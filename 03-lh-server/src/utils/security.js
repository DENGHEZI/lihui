/**
 * 鲤慧 LiHui · 安全防护层(零依赖,Node 标准库)
 *
 * 背景:此前百度 AK 通过 /map-home 页面 HTML 与静态图 URL 明文下发到端上,
 * AK 被第三方扒走盗用,日配额被打爆(status=302)。本次安全升级:
 *
 *  1) 蜜罐密钥(Honeytoken):格式逼真的假 AK / 假 token,散布在对外可见位置
 *     (H5 页面、.env.example 示例)。正常业务永远不会携带它们;
 *     一旦任何入站请求携带蜜罐密钥 → 说明密钥已从该渠道泄露 →
 *     写 data/logs/security.log + 封禁来源 IP。蜜罐打到百度侧调不通,
 *     攻击者拿到的「钥匙」是废的,真正的 AK 从此不出服务端。
 *
 *  2) IP 封禁表(内存):命中蜜罐的来源临时封禁(默认 10 分钟)。
 *
 *  3) 出站令牌桶:保护百度配额,QPS 可配(BAIDU_QPS,默认 30),
 *     高并发时出站请求排队而非瞬间打爆配额。
 *
 *  4) in-flight 去重:相同参数的并发请求合并为一次计算,
 *     多端同时进页/恶意并发只算一次(防雪崩,配合各服务的 TTL 缓存)。
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');

/* ---------------- 蜜罐密钥名单(固定值,多环境一致) ---------------- */
const HONEYPOTS = [
  // 仿百度 AK(32 位字母数字混合)—— 散布在 /map-home 页面与 .env.example 示例
  'vHk3mQ9pX2wR7tZ5nB8cL4dF6gS1aJ0e',
  'Yt6Rw2Nq8Mx4Kz1Pb9Vc5Df3Gs7Hj0La',
  'Qw3Er7Ty9Ui2Op4As5Df6Gh8Jk1Lz0Xc',
  // 仿 OpenAI 兼容平台 token —— 诱捕「抓模型 key」的爬虫
  'sk-hn9f4e2a7c1b8d6m3k5p0q2r4t6v8x0',
];
/** 渠道标记:每个蜜罐对应一个投放渠道,泄露后能定位「从哪漏的」;轮换时原地更新值 */
const honeypots = {
  web: HONEYPOTS[0], // /map-home H5 页面注入
  env: HONEYPOTS[1], // .env.example 模板诱饵
  docs: HONEYPOTS[2], // 文档/注释诱饵
  model: HONEYPOTS[3], // 仿模型 token 诱饵
};
/** 兼容旧引用:H5 页面注入值(字符串) */
function webHoneypot() {
  return honeypots.web;
}

/* ---------------- 安全日志 ---------------- */
const LOG_DIR = path.join(config.dataDir, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'security.log');
function ensureLogDir() {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch (_) {}
}
function securityLog(event, detail) {
  try {
    ensureLogDir();
    const line = JSON.stringify({ ts: new Date().toISOString(), event, ...detail }) + '\n';
    fs.appendFileSync(LOG_FILE, line, 'utf8');
  } catch (_) {}
  // 同步打一条应用日志,运维在主日志里也能看到告警
  try {
    const logger = require('./logger');
    logger.warn('security', `${event}: ${JSON.stringify(detail)}`);
  } catch (_) {}
}

/* ---------------- 入站蜜罐检测 ---------------- */
const KEY_FIELDS = /^(ak|apiKey|api_key|token|access_token|authorization|key|secret)$/i;
const SENSITIVE_HEADER = /^(authorization|x-api-key|x-token|ak)$/i;

/**
 * 扫描入站请求是否携带蜜罐密钥。
 * @returns {{ hit: boolean, key: string, where: string }}
 */
function checkRequest(req, query, body) {
  const probe = (v, where) => {
    if (typeof v !== 'string' || v.length < 8) return null;
    for (const h of HONEYPOTS) {
      if (v === h) return { hit: true, key: h, where };
      // 有些攻击者会搬运完整 URL,蜜罐嵌在 query 里也要抓
      if (v.includes(h)) return { hit: true, key: h, where };
    }
    return null;
  };
  // 1) URL query:所有参数值(不只 ak 字段——攻击者可能换个字段名搬运)
  for (const [k, v] of Object.entries(query || {})) {
    const r = probe(v, `query.${k}`);
    if (r) return r;
  }
  // 2) body 的敏感字段
  if (body && typeof body === 'object') {
    for (const [k, v] of Object.entries(body)) {
      if (KEY_FIELDS.test(k) || typeof v === 'string') {
        const r = probe(v, `body.${k}`);
        if (r) return r;
      }
    }
  }
  // 3) 请求头
  const headers = (req && req.headers) || {};
  for (const [k, v] of Object.entries(headers)) {
    if (SENSITIVE_HEADER.test(k) && typeof v === 'string') {
      const r = probe(v, `header.${k}`);
      if (r) return r;
    }
  }
  return { hit: false, key: '', where: '' };
}

/* ---------------- IP 封禁 ---------------- */
const banned = new Map(); // ip -> until(ms)
function isBanned(ip) {
  const until = banned.get(ip);
  if (!until) return false;
  if (Date.now() > until) {
    banned.delete(ip);
    return false;
  }
  return true;
}
function ban(ip, ms) {
  banned.set(ip, Date.now() + (ms || config.security.banMs));
  // 防膨胀:超限清最旧
  if (banned.size > 5000) {
    const it = banned.keys();
    for (let i = 0; i < 1000; i++) {
      const k = it.next().value;
      if (k !== undefined) banned.delete(k);
    }
  }
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of banned) if (now > v) banned.delete(k);
}, 300000).unref();

/* ---------------- 危险自动响应(分级补丁,2026-10-06) ----------------
 * L1 单次命中:封 IP(默认 10min)→ 常规扫描器,挡掉即可。
 * L2 同 IP 反复命中(≥3 次):封禁升级 24h → 判定「针对性攻击者」。
 * L3 多 IP 命中同一蜜罐渠道(1h 内 ≥3 个不同 IP):判定【该渠道已泄露】
 *    → 自动轮换该渠道蜜罐(旧钥匙作废,攻击者手里那把失效),
 *    生成渠道泄露事件,运维在 /api/v1/security/events 面板一眼可见。 */
const ipHitCount = new Map(); // ip -> 命中次数
const channelHits = new Map(); // channel -> [{ ip, ts }]
const REPEAT_BAN_MS = 24 * 60 * 60 * 1000;
const CHANNEL_LEAK_IPS = 3; // 1h 内不同 IP 数阈值
const CHANNEL_LEAK_WIN = 60 * 60 * 1000;

/* 安全事件环形缓冲(内存,≤200 条,供面板查询;security.log 仍是全量落盘) */
const EVENTS = [];
function pushEvent(level, event, detail) {
  EVENTS.push({ ts: new Date().toISOString(), level, event, ...detail });
  if (EVENTS.length > 200) EVENTS.splice(0, EVENTS.length - 200);
}

/** 渠道蜜罐轮换:替换 honeypots[channel] 与 HONEYPOTS 数组中的对应值 */
function rotateHoneypot(channel) {
  const fresh =
    'sk-' + require('crypto').randomBytes(16).toString('hex') + String(Date.now()).slice(-4);
  const old = honeypots[channel];
  if (!old) return null;
  honeypots[channel] = fresh;
  const idx = HONEYPOTS.indexOf(old);
  if (idx >= 0) HONEYPOTS[idx] = fresh;
  return { channel, oldMasked: old.slice(0, 6) + '****', newMasked: fresh.slice(0, 6) + '****' };
}

/** 蜜罐命中统一处理:分级响应 + 记日志 + 事件缓冲 */
function recordHit({ ip, req, key, where }) {
  // 渠道判定:命中的这把蜜罐是投在哪的
  let channel = 'unknown';
  for (const [ch, val] of Object.entries(honeypots)) if (val === key) channel = ch;

  // L1:基础封禁
  ban(ip);
  const hits = (ipHitCount.get(ip) || 0) + 1;
  ipHitCount.set(ip, hits);
  securityLog('honeypot-hit', {
    ip,
    level: 1,
    channel,
    keyMasked: key.slice(0, 6) + '****',
    where,
    method: (req && req.method) || '',
    path: (req && req.url || '').slice(0, 200),
    ua: ((req && req.headers && req.headers['user-agent']) || '').slice(0, 120),
  });
  pushEvent('warn', 'honeypot-hit', { ip, channel, where, hits });

  // L2:反复命中 → 封禁升级
  if (hits >= 3) {
    ban(ip, REPEAT_BAN_MS);
    securityLog('honeypot-repeat', { ip, level: 2, hits, banMs: REPEAT_BAN_MS });
    pushEvent('danger', 'honeypot-repeat', { ip, hits, action: 'banned-24h' });
  }

  // L3:多 IP 命中同一渠道 → 判定渠道泄露,自动轮换蜜罐
  const now = Date.now();
  const list = (channelHits.get(channel) || []).filter((r) => now - r.ts < CHANNEL_LEAK_WIN);
  if (!list.some((r) => r.ip === ip)) list.push({ ip, ts: now });
  channelHits.set(channel, list);
  const distinct = new Set(list.map((r) => r.ip)).size;
  if (distinct >= CHANNEL_LEAK_IPS) {
    const rot = rotateHoneypot(channel);
    channelHits.delete(channel); // 轮换后重置该渠道计数
    securityLog('channel-leak', { level: 3, channel, distinctIps: distinct, rotated: !!rot });
    pushEvent('critical', 'channel-leak-rotated', { channel, distinctIps: distinct, rotation: rot });
  }
}

/** 管理面板:事件缓冲 + 当前封禁名单 + 蜜罐状态(全部掩码,不泄真值) */
function eventsSnapshot() {
  const now = Date.now();
  const bannedList = [];
  for (const [ip, until] of banned) {
    if (until > now) bannedList.push({ ip, until: new Date(until).toISOString() });
  }
  const honeypotStatus = {};
  for (const [ch, val] of Object.entries(honeypots)) {
    honeypotStatus[ch] = { keyMasked: val.slice(0, 6) + '****', channel: ch };
  }
  return { events: EVENTS.slice(-50), banned: bannedList.slice(0, 100), honeypots: honeypotStatus };
}

/* ---------------- 出站令牌桶(保护百度配额) ---------------- */
class TokenBucket {
  /**
   * @param {number} qps 每秒允许的请求数
   */
  constructor(qps) {
    this.rate = Math.max(1, qps) / 1000; // token/ms
    this.capacity = Math.max(4, Math.ceil(qps)); // 突发容量
    this.tokens = this.capacity;
    this.last = Date.now();
  }
  _refill() {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + (now - this.last) * this.rate);
    this.last = now;
  }
  async take() {
    for (;;) {
      this._refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await new Promise((r) => setTimeout(r, 40));
    }
  }
}
const baiduBucket = new TokenBucket(config.security.baiduQps);

/* ---------------- in-flight 去重 ---------------- */
const pending = new Map();
/**
 * 相同 key 的并发调用共享同一次执行(后到者等先到者的结果)。
 * @param {string} key 去重键(参数完全一致的请求)
 * @param {() => Promise<any>} fn 真正的执行函数
 */
function dedup(key, fn) {
  if (pending.has(key)) return pending.get(key);
  const p = (async () => fn())().finally(() => pending.delete(key));
  pending.set(key, p);
  return p;
}

module.exports = {
  HONEYPOTS,
  honeypots,
  webHoneypot,
  securityLog,
  checkRequest,
  isBanned,
  ban,
  recordHit,
  eventsSnapshot,
  baiduBucket,
  dedup,
};
