/**
 * 鲤慧 LiHui · 监控与主动告警（零依赖）
 *
 * 背景：/health 与安全事件面板只是「被动可查」，CPU/内存/MCP 进程/配额/证书
 * 出问题不会主动喊人。本模块补上「巡检 → 阈值判定 → 告警落库 → 外发」闭环：
 *   - snapshot():   采集当前指标（内存/CPU/uptime/MCP 进程/Token 配额/证书天数）
 *   - evaluate():   纯函数阈值判定（便于单元测试）
 *   - check():      snapshot → evaluate → 告警落库（同 key 去重、恢复自动关闭）→ webhook 外发
 *   - start():      定时巡检（LH_ALERT_INTERVAL_SEC，默认 60s；0=关闭）
 *
 * 环境变量：
 *   LH_ALERT_INTERVAL_SEC  巡检间隔秒（默认 60，0=关闭）
 *   LH_ALERT_MEM_PCT       进程 RSS / 系统总内存 告警阈值 %（默认 85）
 *   LH_ALERT_HEAP_PCT      V8 heap 告警阈值 %（默认 90）
 *   LH_ALERT_MCP_DOWN      「启用但未运行」的 MCP Server 数量阈值（默认 1）
 *   LH_ALERT_QUOTA_PCT     当日 Token 配额用量告警阈值 %（默认 90）
 *   LH_ALERT_CERT_DAYS     证书剩余天数告警阈值（默认 14；未配域名不检测）
 *   MONITOR_CERT_HOST      要检测 HTTPS 证书的域名（如 lihui-tech.online）
 *   ALERT_WEBHOOK_URL      告警外发 webhook（POST JSON；企微/钉钉/飞书自定义机器人均可）
 */
const os = require('os');
const https = require('https');
const http = require('http');
const config = require('../config');
const store = require('./store');
const hub = require('../mcp/hub');
const tokenMeter = require('./tokenMeter');
const logger = require('../utils/logger');

const alertsCol = store.collection('alerts', []);

function num(k, d) {
  const n = Number(process.env[k]);
  return Number.isFinite(n) && process.env[k] !== '' && process.env[k] !== undefined ? n : d;
}

function thresholds() {
  return {
    memPct: num('LH_ALERT_MEM_PCT', 85),
    heapPct: num('LH_ALERT_HEAP_PCT', 90),
    mcpDown: num('LH_ALERT_MCP_DOWN', 1),
    quotaPct: num('LH_ALERT_QUOTA_PCT', 90),
    certDays: num('LH_ALERT_CERT_DAYS', 14),
  };
}

/* ---------------- CPU 采样（两次快照差值 → 百分比） ---------------- */
let lastCpu = process.cpuUsage();
let lastCpuAt = Date.now();
function cpuPercent() {
  const now = process.cpuUsage();
  const dt = Math.max(1, Date.now() - lastCpuAt); // ms
  const userMs = (now.user - lastCpu.user) / 1000;
  const sysMs = (now.system - lastCpu.system) / 1000;
  lastCpu = now;
  lastCpuAt = Date.now();
  const pct = ((userMs + sysMs) / dt) * 100; // 单进程相对单核；>100 说明多核忙
  return Math.round(pct * 10) / 10;
}

/* ---------------- 证书到期天数（结果缓存 1h，失败不反复打） ---------------- */
let certCache = { at: 0, daysLeft: null, error: '' };
function certDaysLeft(host, timeoutMs = 5000) {
  if (!host) return Promise.resolve(null);
  if (Date.now() - certCache.at < 3600 * 1000) {
    return Promise.resolve(certCache.error ? { error: certCache.error } : certCache.daysLeft);
  }
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      certCache.at = Date.now();
      resolve(r);
    };
    try {
      const req = https.request({ host, port: 443, method: 'HEAD', timeout: timeoutMs, rejectUnauthorized: false }, (res) => {
        const cert = res.socket && res.socket.getPeerCertificate ? res.socket.getPeerCertificate() : null;
        const validTo = cert && cert.valid_to ? new Date(cert.valid_to) : null;
        if (!validTo || Number.isNaN(validTo.getTime())) {
          certCache.error = '证书信息不可读';
          return done({ error: certCache.error });
        }
        certCache.daysLeft = Math.floor((validTo.getTime() - Date.now()) / 86400000);
        certCache.error = '';
        done(certCache.daysLeft);
      });
      req.on('timeout', () => {
        req.destroy();
        certCache.error = '证书探测超时';
        done({ error: certCache.error });
      });
      req.on('error', (e) => {
        certCache.error = `证书探测失败: ${e.message}`;
        done({ error: certCache.error });
      });
      req.end();
    } catch (e) {
      certCache.error = `证书探测异常: ${e.message}`;
      done({ error: certCache.error });
    }
  });
}

/* ---------------- 指标快照 ---------------- */
async function snapshot() {
  const mem = process.memoryUsage();
  const total = os.totalmem() || 1;
  const mcpList = hub.list().filter((x) => x.enabled !== false);
  const running = mcpList.filter((x) => x.status === 'running').length;
  const st = tokenMeter.stats({ range: '1d' });
  const quota = st.quota || { daily: config.token.dailyQuota, usedToday: 0 };
  const certHost = process.env.MONITOR_CERT_HOST || '';
  const certRaw = certHost ? await certDaysLeft(certHost) : null;
  const cert = !certHost
    ? { host: '', checked: false }
    : certRaw && typeof certRaw === 'object' && certRaw.error
    ? { host: certHost, checked: true, error: certRaw.error, daysLeft: null }
    : { host: certHost, checked: true, daysLeft: certRaw };
  return {
    ts: new Date().toISOString(),
    uptimeSec: Math.round(process.uptime()),
    mem: {
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      rssPct: Math.round((mem.rss / total) * 1000) / 10,
      heapPct: Math.round((mem.heapUsed / Math.max(mem.heapTotal, 1)) * 1000) / 10,
      osTotal: total,
      osFree: os.freemem(),
    },
    cpu: { percent: cpuPercent(), loadavg1: Math.round((os.loadavg()[0] || 0) * 100) / 100 },
    mcp: {
      total: mcpList.length,
      running,
      down: mcpList.length - running,
      downIds: mcpList.filter((x) => x.status !== 'running').map((x) => x.id),
    },
    quota: {
      daily: quota.daily,
      usedToday: quota.usedToday || 0,
      pct: quota.daily ? Math.round(((quota.usedToday || 0) / quota.daily) * 1000) / 10 : 0,
    },
    cert,
  };
}

/* ---------------- 阈值判定（纯函数，单测覆盖） ----------------
 * @returns {Array<{key,level:'warn'|'crit',msg,value,threshold}>} */
function evaluate(snap, th) {
  const out = [];
  const t = th || thresholds();
  if (snap && snap.mem) {
    if (t.memPct > 0 && snap.mem.rssPct >= t.memPct) {
      out.push({ key: 'mem_high', level: 'warn', msg: `进程内存过高：RSS 占系统内存 ${snap.mem.rssPct}%`, value: snap.mem.rssPct, threshold: t.memPct });
    }
    if (t.heapPct > 0 && snap.mem.heapPct >= t.heapPct) {
      out.push({ key: 'heap_high', level: 'warn', msg: `V8 堆内存过高：${snap.mem.heapPct}%（${Math.round(snap.mem.heapUsed / 1048576)}MB / ${Math.round(snap.mem.heapTotal / 1048576)}MB）`, value: snap.mem.heapPct, threshold: t.heapPct });
    }
  }
  if (snap && snap.mcp && t.mcpDown > 0 && snap.mcp.down >= t.mcpDown) {
    out.push({ key: 'mcp_down', level: 'crit', msg: `MCP Server 异常：${snap.mcp.down}/${snap.mcp.total} 未运行（${(snap.mcp.downIds || []).join(',')}）`, value: snap.mcp.down, threshold: t.mcpDown });
  }
  if (snap && snap.quota && t.quotaPct > 0 && snap.quota.pct >= t.quotaPct) {
    out.push({ key: 'quota_high', level: 'warn', msg: `Token 配额告急：今日已用 ${snap.quota.usedToday}/${snap.quota.daily}（${snap.quota.pct}%）`, value: snap.quota.pct, threshold: t.quotaPct });
  }
  if (snap && snap.cert && snap.cert.checked) {
    if (typeof snap.cert.daysLeft === 'number' && t.certDays > 0 && snap.cert.daysLeft <= t.certDays) {
      const level = snap.cert.daysLeft <= 3 ? 'crit' : 'warn';
      out.push({ key: 'cert_expiring', level, msg: `HTTPS 证书即将到期：${snap.cert.host} 剩余 ${snap.cert.daysLeft} 天`, value: snap.cert.daysLeft, threshold: t.certDays });
    }
    if (snap.cert.error) {
      out.push({ key: 'cert_check_failed', level: 'warn', msg: `证书检测失败：${snap.cert.host}（${snap.cert.error}）`, value: null, threshold: t.certDays });
    }
  }
  return out;
}

/* ---------------- 告警落库（同 key 未关闭则去重；条件消失自动 resolve） ---------------- */
const ALERT_KEYS = ['mem_high', 'heap_high', 'mcp_down', 'quota_high', 'cert_expiring', 'cert_check_failed'];

function recordAlerts(fired) {
  const now = Date.now();
  const firedKeys = new Set(fired.map((a) => a.key));
  const changed = [];
  for (const a of fired) {
    const open = alertsCol.all().find((x) => x.key === a.key && !x.resolved);
    if (open) {
      // 已有未关闭的同 key 告警：仅更新最新值，不重复轰炸
      alertsCol.update(open.id, { value: a.value, lastSeenAt: now });
    } else {
      const item = alertsCol.add({ id: store.uid('al'), key: a.key, level: a.level, msg: a.msg, value: a.value, threshold: a.threshold, at: now, lastSeenAt: now, resolved: false, resolvedAt: null });
      changed.push(item);
      logger.warn('monitor', `[告警] ${a.key}: ${a.msg}`);
    }
  }
  // 条件消失 → 自动关闭
  for (const key of ALERT_KEYS) {
    if (firedKeys.has(key)) continue;
    for (const open of alertsCol.all().filter((x) => x.key === key && !x.resolved)) {
      alertsCol.update(open.id, { resolved: true, resolvedAt: now });
      logger.info('monitor', `[恢复] ${key}`);
    }
  }
  if (alertsCol.all().length > 500) {
    // 防膨胀：只留最近 500 条
    const keep = alertsCol.all().sort((a, b) => b.at - a.at).slice(0, 500);
    alertsCol.save(keep);
  }
  return changed;
}

/* ---------------- webhook 外发（fire-and-forget，失败只记日志） ---------------- */
function pushWebhook(alerts) {
  const url = process.env.ALERT_WEBHOOK_URL || '';
  if (!url || !alerts.length) return;
  try {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const text = alerts.map((a) => `【鲤慧${a.level === 'crit' ? '严重' : '告警'}】${a.msg}`).join('\n');
    const body = JSON.stringify({ msgtype: 'text', text: { content: `鲤慧服务监控\n${text}` } });
    const req = lib.request(u, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 5000 }, () => {});
    req.on('error', (e) => logger.warn('monitor', `告警 webhook 外发失败: ${e.message}`));
    req.on('timeout', () => req.destroy());
    req.end(body);
  } catch (e) {
    logger.warn('monitor', `告警 webhook 配置无效: ${e.message}`);
  }
}

/* ---------------- 巡检 ---------------- */
let checking = false;
let lastSnapshot = null;
async function check() {
  if (checking) return { skipped: true };
  checking = true;
  try {
    const snap = await snapshot();
    lastSnapshot = snap;
    const fired = evaluate(snap);
    const created = recordAlerts(fired);
    pushWebhook(created);
    return { fired, created: created.length };
  } catch (e) {
    logger.warn('monitor', `巡检异常: ${e.message}`);
    return { error: e.message };
  } finally {
    checking = false;
  }
}

let timer = null;
function start() {
  const sec = num('LH_ALERT_INTERVAL_SEC', 60);
  if (timer || sec <= 0) return;
  timer = setInterval(() => check().catch(() => {}), sec * 1000);
  timer.unref();
  logger.info('monitor', `主动巡检已启动（每 ${sec}s 一次${process.env.ALERT_WEBHOOK_URL ? '，告警外发 webhook 已配置' : ''}）`);
  setTimeout(() => check().catch(() => {}), 5000).unref(); // 启动后 5s 先巡检一次
}

function latest() {
  return lastSnapshot;
}

function listAlerts({ includeResolved = false, limit = 100 } = {}) {
  const all = alertsCol
    .all()
    .sort((a, b) => b.at - a.at)
    .filter((x) => includeResolved || !x.resolved)
    .slice(0, limit);
  return all;
}

module.exports = { snapshot, evaluate, check, start, latest, listAlerts, thresholds, certDaysLeft, ALERT_KEYS };
