/**
 * 鲤慧 LiHui · Memory —— 人机协同安全运维记忆（Human-in-the-loop）
 *
 * 设计铁律：**绝不全自动闭环**。AI 只做「分析与建议」，任何真正生效的动作
 * （改 Nginx 配置、改代码、改配置）都必须经过人工批准，且批准也不自动执行——
 * 而是产出「已审核工件」（conf 片段 / patch 文件）落盘到 memory/approved/，由人去合并。
 *
 * 五步架构：
 *   1) Collect      收集蜜罐命中 / security.log / 系统状态
 *   2) Sanitize     ★ 发送给 DeepSeek 之前必须脱敏：
 *                     - sk- 开头的真实 Key / 32 位 AK 形态 → 掩码（只留前后 4 位）
 *                     - 内网与服务器真实 IP → <内网IP>/<服务器IP>，绝不进 Prompt
 *                     - 攻击来源 IP 仅保留前两段（1.2.*.*，供「源 IP 段」分析）
 *                     - 设备号、ak= 查询参数值一律掩码
 *   3) Analyze      脱敏后的日志 + 历史处置记忆 → DeepSeek（OpenAI 兼容协议）
 *                     输出：诊断 / 威胁等级 / 具体建议（nginx 限流规则、代码补丁等）
 *                   无 Key 时降级「本地规则引擎」，功能不空转
 *   4) Sandbox      对建议做沙箱验证：nginx 指令白名单 + 语法 + 用真实命中样本回放
 *                     估算拦截效果；代码补丁校验目标文件存在性（绝不自动 apply）
 *   5) Learning     人工批准/拒绝的每个决定写入 memory/（结构化 + 人类可读日报），
 *                     下次分析作为「处置记忆」注入 Prompt —— 越用越懂这套系统
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');
const config = require('../config');
const logger = require('../utils/logger');
const security = require('../utils/security');
const store = require('./store');

const suggestionsCol = store.collection('memory-suggestions', []);
const IN_CONTAINER = fs.existsSync('/.dockerenv');
const memoryDir = config.memory.dir || path.resolve(config.root, IN_CONTAINER ? path.join('data', 'memory') : '..', 'memory');
try {
  fs.mkdirSync(path.join(memoryDir, 'approved'), { recursive: true });
} catch (_) {}

/* ================= 1) 收集 ================= */
function tailFile(f, n) {
  try {
    if (!fs.existsSync(f)) return [];
    return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).slice(-n);
  } catch (_) {
    return [];
  }
}

/** 本机真实地址（这些字符串绝不许出现在发给 LLM 的内容里） */
function localAddresses() {
  const out = [];
  try {
    for (const ni of Object.values(os.networkInterfaces())) {
      for (const a of ni || []) if (a.address) out.push(a.address);
    }
  } catch (_) {}
  return out.filter((x) => x && x !== '::1' && x !== '0.0.0.0');
}

function collect() {
  const snap = security.eventsSnapshot();
  return {
    ts: new Date().toISOString(),
    system: {
      node: process.version,
      uptimeSec: Math.round(process.uptime()),
      storeDriver: store.driver,
      banCount: snap.banned.length,
    },
    events: snap.events || [],
    banned: snap.banned || [],
    honeypots: snap.honeypots || {},
    rawLogTail: tailFile(path.join(config.dataDir, 'logs', 'security.log'), 60),
  };
}

/* ================= 2) 脱敏 ================= */
function maskSecret(v) {
  const s = String(v);
  return s.slice(0, Math.min(5, s.length)) + '***' + s.slice(-4);
}
function maskIp(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return '<IP>';
  // 私网/回环 = 服务器侧地址,整段抹掉;公网来源保留前两段(供「源 IP 段」分析)
  const [a, b, c] = [+m[1], +m[2], +m[3]];
  const isPrivate = a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  if (isPrivate) return '<内网IP>';
  return `${a}.${b}.*.*`;
}

/**
 * 对将发给 LLM 的文本做强制脱敏。
 * @returns {{ text: string, report: { keys: number, akLike: number, ips: number, localIps: number, devices: number } }}
 */
function sanitize(text) {
  const report = { keys: 0, akLike: 0, ips: 0, localIps: 0, devices: 0 };
  let out = String(text || '');
  out = out.replace(/\bsk-[A-Za-z0-9_-]{12,}/g, (m) => {
    report.keys += 1;
    return maskSecret(m);
  });
  // 顺序铁律：特异模式在前，通用模式在后(ak= 必须先于裸 32 位规则,否则永不命中)
  out = out.replace(/\bak=[A-Za-z0-9]{16,}/gi, () => {
    report.keys += 1;
    return 'ak=***';
  });
  out = out.replace(/\b[A-Za-z0-9]{32}\b/g, (m) => {
    report.akLike += 1;
    return 'AK***' + m.slice(-4);
  });
  out = out.replace(/\b[a-z]{2,4}_[A-Za-z0-9]{8,}\b/g, () => {
    report.devices += 1;
    return '<设备ID>';
  });
  out = out.replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, (ip) => {
    report.ips += 1;
    return maskIp(ip);
  });
  // 双保险:本机所有真实网卡地址逐个替换(正则漏网的兜底)
  for (const addr of localAddresses()) {
    if (out.includes(addr)) {
      out = out.split(addr).join('<服务器IP>');
      report.localIps += 1;
    }
  }
  return { text: out, report };
}

/** 收集结果整体脱敏(LLM 输入) */
function sanitizeCollect(c) {
  const r1 = sanitize(JSON.stringify({ system: c.system, events: c.events, banned: c.banned, honeypots: c.honeypots }));
  const r2 = sanitize(c.rawLogTail.join('\n'));
  return {
    text:
      '【系统状态】\n' + r1.text + '\n\n【security.log 尾部 60 行】\n' + (r2.text || '(空)'),
    report: {
      keys: r1.report.keys + r2.report.keys,
      akLike: r1.report.akLike + r2.report.akLike,
      ips: r1.report.ips + r2.report.ips,
      localIps: r1.report.localIps + r2.report.localIps,
      devices: r1.report.devices + r2.report.devices,
    },
  };
}

/* ================= 3) 分析(DeepSeek / 本地规则降级) ================= */
/** 历史处置记忆(学习注入) */
function learnings() {
  const d = store.read('memory-learnings', []);
  return Array.isArray(d) ? d.slice(-12) : [];
}

function analysisPrompt(sanitized, learned) {
  return [
    '你是「Memory」，鲤慧服务端（Node 零依赖 + Nginx 反代 + 微信云托管）的 AI 安全运维分析师。',
    '你在【人机协同】模式：只给诊断与建议，绝不执行；人类会审核你的每条建议。',
    '输入内容已脱敏：密钥掩码、服务器/内网 IP 已抹除、来源 IP 仅保留前两段。',
    '',
    '【历史处置记忆】（人类批准/拒绝过的决定，供你学习偏好，别重复给被拒绝的方案）:',
    learned.length ? JSON.stringify(learned) : '（暂无）',
    '',
    '【本次待分析的安全事件】',
    sanitized,
    '',
    '要求输出**严格 JSON**（不要 markdown 代码块之外的任何文字）：',
    '{"diagnosis":"一句话诊断，例：这大概率是一个 CC/目录扫描攻击，源 IP 段 x.x.*.*","threatLevel":"low|medium|high|critical","suggestions":[{"type":"nginx","title":"...","rationale":"为什么","content":"完整可用的配置/补丁原文","confidence":0.0}]}',
    '规则：',
    '- type=nginx 给完整配置块（limit_req_zone 必须在 http 块，limit_req 在 server/location 块，注明放置位置注释）',
    '- type=code 的 content 必须是「文件路径 + 修改前(after→before 对照)」格式',
    '- 最多 4 条，按优先级排序；只依据上面真实事件，不要编造',
  ].join('\n');
}

/** 从模型回复里抠 JSON */
function extractJson(text) {
  const t = String(text || '').replace(/```json|```/g, '');
  const i = t.indexOf('{'), j = t.lastIndexOf('}');
  if (i < 0 || j <= i) return null;
  try {
    return JSON.parse(t.slice(i, j + 1));
  } catch (_) {
    return null;
  }
}

function llmConfig() {
  const mKey = config.memory.llm.apiKey;
  if (mKey) {
    return { key: mKey, base: config.memory.llm.baseUrl || 'https://api.deepseek.com', model: config.memory.llm.model || 'deepseek-chat' };
  }
  // 兼容回落:全局 LLM 配置明确指向 deepseek 时复用
  if (config.llm.apiKey && /deepseek/i.test(config.llm.baseUrl || '')) {
    return { key: config.llm.apiKey, base: config.llm.baseUrl, model: config.llm.model || 'deepseek-chat' };
  }
  return null;
}

function httpsPostJson(base, apiKey, model, messages, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL('/v1/chat/completions', base.endsWith('/') ? base : base + '/');
    const body = JSON.stringify({ model, messages, temperature: 0.3, max_tokens: 1600 });
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request(
      { host: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443), path: u.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey, 'Content-Length': Buffer.byteLength(body) },
        timeout: timeoutMs },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            const j = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (j.error) return reject(new Error(j.error.message || 'LLM 返回错误'));
            resolve((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '');
          } catch (e) {
            reject(new Error('LLM 响应解析失败'));
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('LLM 请求超时')));
    req.write(body);
    req.end();
  });
}

/** 本地规则引擎降级分析(无 Key 时保证功能可用) */
function localRuleAnalysis(c) {
  const byIp = new Map();
  for (const e of c.events) {
    if (!e.ip) continue;
    const k = maskIp(e.ip);
    byIp.set(k, (byIp.get(k) || 0) + 1);
  }
  const top = [...byIp.entries()].sort((a, b) => b[1] - a[1])[0];
  const total = c.events.length;
  const heavy = total >= 6 || (top && top[1] >= 3);
  const diag = heavy
    ? `疑似批量扫描/CC 探测：近期 ${total} 次蜜罐命中` + (top ? `，最集中来源段 ${top[0]}（${top[1]} 次）` : '')
    : '近期蜜罐命中较少，属常规互联网背景噪音';
  const level = heavy ? 'medium' : 'low';
  const sug = [];
  if (heavy) {
    sug.push({
      type: 'nginx',
      title: '对蜜罐命中集中来源段加限流（示例按 /16 段）',
      rationale: '高频命中段先限速再观察，误伤面小',
      content: [
        '# 放在 http {} 块（nginx.conf）',
        'limit_req_zone $binary_remote_addr zone=lh_api:10m rate=30r/m;',
        '',
        '# 放在 server {} / location /api/v1/ {} 内',
        'limit_req zone=lh_api burst=10 nodelay;',
        'limit_req_status 429;',
      ].join('\n'),
      confidence: 0.6,
    });
    sug.push({
      type: 'config',
      title: '把 BAIDU_QPS 临时下调到 15，收敛出站配额消耗',
      rationale: '被扫描期间减少真实 AK 的无效出站调用',
      content: '环境变量 BAIDU_QPS=15（云托管控制台「环境变量」或 .env），生效需重启服务',
      confidence: 0.5,
    });
  } else {
    sug.push({
      type: 'config',
      title: '保持现状，无需动作',
      rationale: '事件量低，现有 L1/L2 封禁已覆盖',
      content: '无（观察即可）',
      confidence: 0.8,
    });
  }
  return { diagnosis: diag, threatLevel: level, suggestions: sug, engine: 'local-rules' };
}

/** 生成建议并入库存(24h 内同标题去重) */
function saveSuggestions(analysis) {
  const now = Date.now();
  const day = 24 * 3600 * 1000;
  const recent = suggestionsCol.all().filter((s) => now - Number(s.ts || 0) < day);
  const made = [];
  for (const s of (analysis.suggestions || []).slice(0, 4)) {
    if (!s || !s.title || !s.type) continue;
    if (recent.some((x) => x.title === s.title)) continue;
    const item = suggestionsCol.add({
      ts: now,
      tsText: new Date().toISOString(),
      type: ['nginx', 'code', 'config'].includes(s.type) ? s.type : 'config',
      title: String(s.title).slice(0, 120),
      rationale: String(s.rationale || '').slice(0, 400),
      content: String(s.content || '').slice(0, 4000),
      confidence: Number(s.confidence) || 0.5,
      engine: analysis.engine || 'deepseek',
      status: 'pending',
      verify: null,
    });
    if (item) made.push(item);
  }
  return made;
}

/**
 * 全流程:收集 → 脱敏 → 分析 → 建议入库
 * @returns {{ sanitized: {text,report}, analysis, suggestions }}
 */
async function analyze() {
  const c = collect();
  const { text, report } = sanitizeCollect(c);
  const learned = learnings();
  let analysis = null;
  let degraded = false;
  const cfg = llmConfig();
  if (cfg) {
    try {
      const raw = await httpsPostJson(cfg.base, cfg.key, cfg.model, [
        { role: 'system', content: '你是严谨的安全运维分析师,只输出 JSON。' },
        { role: 'user', content: analysisPrompt(text, learned) },
      ], config.memory.llm.timeout);
      const j = extractJson(raw);
      if (j && j.diagnosis) {
        j.engine = 'deepseek';
        analysis = j;
      } else {
        logger.warn('memory', 'LLM 返回无法解析为 JSON,降级本地规则引擎');
      }
    } catch (e) {
      logger.warn('memory', `DeepSeek 分析失败(${e.message}),降级本地规则引擎`);
    }
  }
  if (!analysis) {
    analysis = localRuleAnalysis(c);
    degraded = true;
  }
  const made = saveSuggestions(analysis);
  appendMemoryLog(`\n### 🔍 AI 分析（${analysis.engine}${degraded ? '·降级' : ''}）\n- 诊断：${analysis.diagnosis}\n- 威胁等级：${analysis.threatLevel}\n- 新建议：${made.length ? made.map((x) => x.title).join('；') : '无新增'}\n- 脱敏：密钥×${report.keys} AK×${report.akLike} IP×${report.ips} 服务器IP×${report.localIps} 设备×${report.devices}`);
  return { sanitized: { text, report }, analysis, suggestions: made, degraded };
}

/* ================= 4) 沙箱验证 ================= */
const NGINX_DIRS = /^(limit_req_zone|limit_req|limit_req_status|limit_conn|limit_conn_zone|allow|deny|proxy_pass|return|set|if|location|server|http|include|map)\b/;

function verifyNginx(content) {
  const lines = String(content).split('\n').map((l) => l.trim());
  const issues = [];
  let braces = 0, zoneDefined = false, hasLimitReq = false;
  for (const [i, line] of lines.entries()) {
    const code = line.replace(/#.*$/, '').trim();
    if (!code) continue;
    if (code.includes('{')) braces += (code.match(/{/g) || []).length;
    if (code.includes('}')) braces -= (code.match(/}/g) || []).length;
    if (braces < 0) issues.push(`第 ${i + 1} 行：花括号不匹配`);
    if (/^limit_req_zone\b/.test(code)) zoneDefined = true;
    if (/^limit_req\s/.test(code)) hasLimitReq = true;
    const head = code.split(/[\s{;]/)[0];
    if (head && !NGINX_DIRS.test(head) && !/^(#|$)/.test(code)) {
      issues.push(`第 ${i + 1} 行：非常用指令「${head}」，请人工确认`);
    }
  }
  if (braces !== 0) issues.push('花括号总数不配对');
  if (hasLimitReq && !zoneDefined) issues.push('使用了 limit_req 但未见 limit_req_zone 定义（若在主配置已定义可忽略）');
  // 样本回放:rate=30r/m 时,过去事件里同段来源第 N 次以后会被 429
  let replay = null;
  const rate = /rate=(\d+)r\/(m|s)/.exec(String(content));
  if (rate) {
    const windowMs = rate[2] === 'm' ? 60000 : 1000;
    const max = Number(rate[1]);
    const bySeg = new Map();
    let blocked = 0, total = 0;
    for (const e of security.eventsSnapshot().events) {
      if (!e.ip) continue;
      total += 1;
      const seg = maskIp(e.ip);
      const t0 = Date.parse(e.ts) || 0;
      const arr = (bySeg.get(seg) || []).filter((x) => t0 - x < windowMs);
      arr.push(t0);
      bySeg.set(seg, arr);
      if (arr.length > max) blocked += 1;
    }
    replay = { total, blocked, rate: max + 'r/' + rate[2] };
  }
  return { ok: issues.length === 0, issues, replay, checkedAt: new Date().toISOString() };
}

function verifyCode(content) {
  const issues = [];
  const m = /^\s*(?:#|\/\/)?\s*(?:文件|file|路径)[::]?\s*(\S+)/m.exec(String(content));
  const target = m && m[1];
  if (!target) issues.push('未注明目标文件路径（格式：「文件: 03-lh-server/src/...」）');
  else {
    const safe = path.resolve(config.root, '..', target.replace(/\\/g, '/'));
    if (!safe.startsWith(path.resolve(config.root, '..'))) issues.push('路径越界（只允许仓库内文件）');
    else if (!fs.existsSync(safe)) issues.push(`目标文件不存在：${target}`);
  }
  if (!/(修改前|before|<<<|-{3,})/i.test(String(content))) issues.push('内容缺少「修改前/后」对照，难以安全合并');
  return { ok: issues.length === 0, issues, checkedAt: new Date().toISOString() };
}

function verifySuggestion(id) {
  const s = suggestionsCol.find((x) => x.id === id);
  if (!s) return null;
  let report;
  if (s.type === 'nginx') report = verifyNginx(s.content);
  else if (s.type === 'code') report = verifyCode(s.content);
  else report = { ok: true, issues: [], note: 'config 类仅人工审阅，无自动沙箱', checkedAt: new Date().toISOString() };
  suggestionsCol.update(id, { verify: report, status: report.ok ? 'verified' : s.status });
  return { id, ...report };
}

/* ================= 5) 人工审核与合并 + 学习 ================= */
function appendMemoryLog(md) {
  try {
    const day = new Date().toISOString().slice(0, 10);
    const f = path.join(memoryDir, `${day}.md`);
    if (!fs.existsSync(f)) fs.writeFileSync(f, `# ${day} · Memory 安全运维记忆\n`, 'utf8');
    fs.appendFileSync(f, md + '\n', 'utf8');
  } catch (e) {
    logger.warn('memory', `写入记忆日报失败: ${e.message}`);
  }
}

function learn(decision) {
  const list = store.read('memory-learnings', []);
  const arr = Array.isArray(list) ? list : [];
  arr.push({ ...decision, tsText: new Date().toISOString() });
  while (arr.length > 50) arr.shift();
  store.write('memory-learnings', arr);
}

function decide(id, action, note, by) {
  const s = suggestionsCol.find((x) => x.id === id);
  if (!s) return null;
  if (!['approve', 'reject'].includes(action)) return { error: 'action 必须是 approve|reject' };
  const record = {
    id,
    action: action === 'approve' ? '批准' : '拒绝',
    type: s.type,
    title: s.title,
    note: String(note || '').slice(0, 200),
    by: String(by || 'admin').slice(0, 40),
  };
  let artifact = null;
  if (action === 'approve') {
    // 批准 ≠ 自动执行:产出「已审核工件」供人工合并,绝不触碰线上配置/代码
    const ext = s.type === 'nginx' ? 'conf' : s.type === 'code' ? 'diff' : 'txt';
    const fname = `${s.type}-${Date.now()}.${ext}`;
    const body =
      `# Memory 已审核工件（人工批准,待合并）\n# 批准人:${record.by}  时间:${new Date().toISOString()}\n# 建议标题:${s.title}\n# 备注:${record.note || '-'}\n\n` +
      s.content + '\n';
    try {
      fs.writeFileSync(path.join(memoryDir, 'approved', fname), body, 'utf8');
      artifact = `memory/approved/${fname}`;
    } catch (e) {
      return { error: '工件写入失败: ' + e.message };
    }
  }
  suggestionsCol.update(id, { status: action === 'approve' ? 'approved' : 'rejected', decidedBy: record.by, decidedNote: record.note, decidedAt: new Date().toISOString(), artifact });
  learn(record);
  appendMemoryLog(`\n### ✅ 人工决定（${record.action}）\n- ${record.type} · ${record.title}\n- 备注：${record.note || '-'}${artifact ? `\n- 工件：${artifact}` : ''}`);
  return { ok: true, id, status: action === 'approve' ? 'approved' : 'rejected', artifact };
}

/* ================= 面板聚合 ================= */
function overview() {
  const all = suggestionsCol.all();
  return {
    events: security.eventsSnapshot(),
    suggestions: all.slice(-20).reverse(),
    learnings: learnings().slice(-10).reverse(),
    memoryDir,
    llm: (() => {
      const c = llmConfig();
      return c ? { engine: 'deepseek', base: c.base, model: c.model } : { engine: 'local-rules', base: '', model: '' };
    })(),
  };
}

module.exports = { analyze, verifySuggestion, decide, overview, sanitize, collect, memoryDir };
