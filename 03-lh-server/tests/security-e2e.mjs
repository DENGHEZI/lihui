#!/usr/bin/env node
/**
 * 鲤慧 LiHui · 海量 E2E 安全测试套件（零依赖，Node >= 18）
 *
 * 定位：对运行中的服务端（默认 http://127.0.0.1:8809）发起真实 HTTP 攻击面测试，
 * payload 字典 × 端点 × 注入位自动展开为数百用例，验证「恶意入参不 5xx、不回显、
 * 不泄露密钥、路径穿越被封、蜜罐假 key 触发封禁」五条铁律。
 *
 * 用法：
 *   node src/app.js                          # 先起服务（另开终端）
 *   node tests/security-e2e.mjs              # 跑全部用例
 *   node tests/security-e2e.mjs --base=http://127.0.0.1:8809 --quiet
 *
 * 退出码：0=全部通过；1=存在失败（CI 可直接用）。
 */
import http from 'node:http';

const BASE = (process.argv.find((a) => a.startsWith('--base=')) || '--base=http://127.0.0.1:8809').slice(7).replace(/\/$/, '');
const QUIET = process.argv.includes('--quiet');

/* ---------------- payload 字典（分类 × 攻击向量） ---------------- */
const PAYLOADS = {
  sqli: [
    "' OR '1'='1", "1; DROP TABLE users--", "1' UNION SELECT ak,password FROM baidu--",
    "admin'--", "1 OR 1=1", "'; EXEC xp_cmdshell('dir')--",
  ],
  nosqli: ['{"$gt":""}', '{"$ne":null}', "[$where:'1==1']", '{"$regex":".*"}'],
  xss: [
    '<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '"><svg onload=alert(1)>',
    "javascript:alert(1)", '<iframe src="javascript:alert(1)">', '{{7*7}}${7*7}<%= 7*7 %>',
  ],
  pathTraversal: [
    '../../../../.env', '..\\..\\..\\.env', '....//....//.env', '%2e%2e%2f%2e%2e%2f%2e%2e%2f.env',
    '/etc/passwd', 'C:\\Windows\\win.ini',
  ],
  cmdi: ['; cat /etc/passwd', '| whoami', '`id`', '$(rm -rf /)', '& del C:\\Windows\\System32'],
  ssrf: ['http://169.254.169.254/latest/meta-data/', 'file:///etc/passwd', 'gopher://127.0.0.1:6379/_INFO', 'http://127.0.0.1:8809/health'],
  header: ['%0d%0aX-Injected: 1', 'value\r\nSet-Cookie: pwned=1', '\r\n\r\nGET / HTTP/1.1'],
  proto: ['__proto__={"isAdmin":true}', 'constructor.prototype.polluted=1', '{"__proto__":{"x":1}}'],
  overflow: ['A'.repeat(8000), '鱼'.repeat(4000), JSON.stringify({ d: 'x'.repeat(60000) })],
  honeypot: ['vHk3mQ9pX2wR7tZ5nB8cL4dF6gS1aJ0e'],
};
const ALL_PAYLOADS = Object.entries(PAYLOADS).flatMap(([k, arr]) => arr.map((p) => ({ kind: k, p })));

/* ---------------- 目标端点（query 注入 / body 注入） ---------------- */
const TARGETS = [
  { name: 'GET /health', path: '/health' },
  { name: 'GET /server-info', path: '/server-info' },
  { name: 'GET /life/report', path: '/api/v1/life/report', params: { lng: '113.134', lat: '27.827' } },
  { name: 'GET /map/poi/search', path: '/api/v1/map/poi/search', params: { lng: '113.134', lat: '27.827', radius: '2000' } },
  { name: 'GET /map/ak-status', path: '/api/v1/map/ak-status' },
  { name: 'GET /agent/standards', path: '/api/v1/agent/standards', params: { q: '步行标准' } },
  { name: 'POST /agent/chat', path: '/api/v1/agent/chat', method: 'POST', body: () => ({ text: '你好', sessionId: 'e2e', deviceId: 'e2e' }) },
  { name: 'GET /static/**', path: '/static/poi.json' },
];

/* ---------------- HTTP 客户端（raw path 保留 ../ 与 CRLF 编码） ---------------- */
function request(pathname, { method = 'GET', body, headers = {}, timeout = 8000 } = {}) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    // 每发请求携带唯一 device-id（避免误触「单设备 60/min」限流，使注入套件真正打到处理器）
    const devId = 'e2e-' + Math.random().toString(36).slice(2, 10);
    const req = http.request(
      `${BASE}${pathname}`,
      {
        method,
        headers: {
          ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}),
          'X-Device-Id': devId,
          ...headers,
        },
        timeout,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, head: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
      }
    );
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, head: {}, text: '' }); });
    req.on('error', (e) => resolve({ status: 0, head: {}, text: `ECONN:${e.message}` }));
    if (data) req.write(data);
    req.end();
  });
}

/* ---------------- 断言铁律 ---------------- */
const SECRETS_RE = /BAIDU_AK\s*=|LLM_API_KEY\s*=|sk-[a-zA-Z0-9]{20,}/; // .env 关键特征
function assertSafe(caseName, r, payload, kind) {
  const problems = [];
  if (r.status === 0) {
    // overflow 被服务端 RST/拒收 = 预期防护行为（超长请求进不了应用层），不算失败
    if (kind === 'overflow' && /ECONN/.test(r.text)) return { rejected: true, problems: [] };
    problems.push('连接失败/超时（服务崩溃或拒绝）');
  }
  if (r.status >= 500) problems.push(`5xx: ${r.status}`);
  // 密钥泄露（无论什么攻击向量，响应里出现 .env 特征即失败）
  if (SECRETS_RE.test(r.text)) problems.push('响应含密钥特征（疑似 .env 泄露/穿越成功）');
  // XSS 原样回显（未转义）—— 仅在 HTML 语境有意义；JSON API 回显用户输入非 XSS 漏洞
  const ct = (r.head && r.head['content-type']) || '';
  if (payload && /<script|onerror=/i.test(payload) && /text\/html/i.test(ct) && r.text.includes(payload.slice(0, 24))) {
    problems.push('XSS payload 原样回显（未转义）');
  }
  // CRLF 注入成功（响应头被污染）
  if (payload && /%0d%0a|\r\n/i.test(payload) && r.head['x-injected']) problems.push('CRLF 注入成功（响应头被污染）');
  return problems;
}

/* ---------------- 用例展开 ---------------- */
function buildCases() {
  const cases = [];
  for (const t of TARGETS) {
    for (const { kind, p } of ALL_PAYLOADS) {
      if (kind === 'honeypot') continue; // 蜜罐单独放最后（触发封禁会影响后续用例）
      // query 位
      {
        const qs = new URLSearchParams({ ...(t.params || {}), q: p, query: p, name: p, lng: t.params ? t.params.lng : p, lat: t.params ? t.params.lat : '27.827' });
        cases.push({ name: `${t.name} [query:${kind}]`, path: `${t.path}?${qs}`, method: t.method || 'GET', body: undefined, payload: p, kind });
      }
      // body 位（POST 端点）
      if (t.method === 'POST') {
        cases.push({ name: `${t.name} [body:${kind}]`, path: t.path, method: 'POST', body: { ...(t.body ? t.body() : {}), text: p, extra: p }, payload: p, kind });
      }
      // 路径穿越：直接打静态路由 raw path
      if (kind === 'pathTraversal') {
        cases.push({ name: `${t.name} [path:${kind}]`, path: `/static/${p}${p.includes('.env') ? '' : ''}`, method: 'GET', payload: p, kind });
        cases.push({ name: `/vendor [path:${kind}]`, path: `/vendor/${p}`, method: 'GET', payload: p, kind });
      }
    }
  }
  // 大 body / 坏 JSON
  cases.push({ name: 'POST /agent/chat [malformed-json]', path: '/api/v1/agent/chat', method: 'POST', rawBody: '{"text":"hi",', payload: '' });
  cases.push({ name: 'POST /agent/chat [huge-body]', path: '/api/v1/agent/chat', method: 'POST', body: { text: 'A'.repeat(100000) }, payload: '' });
  return cases;
}

/* ---------------- 主流程 ---------------- */
const CONCURRENCY = 12;
async function run() {
  const t0 = Date.now();
  const cases = buildCases();
  console.log(`目标: ${BASE}`);
  console.log(`用例: ${cases.length}（payload 字典 ${ALL_PAYLOADS.length} × 端点 ${TARGETS.length} × 注入位）\n`);
  const fails = [];
  let done = 0;
  let rejected = 0; // overflow 被服务端拒收（预期防护）

  async function worker(queue) {
    while (queue.length) {
      const c = queue.shift();
      const r = await request(c.path, { method: c.method, body: c.body !== undefined ? c.body : undefined, headers: {} });
      // raw body 特殊处理
      let resp = r;
      if (c.rawBody !== undefined) {
        resp = await new Promise((resolve) => {
          const u = new URL(`${BASE}${c.path}`);
          const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: c.method, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(c.rawBody) } }, (res) => {
            const ch = []; res.on('data', (x) => ch.push(x)); res.on('end', () => resolve({ status: res.statusCode, head: res.headers, text: Buffer.concat(ch).toString('utf8') }));
          });
          req.on('error', (e) => resolve({ status: 0, head: {}, text: `ECONN:${e.message}` }));
          req.end(c.rawBody);
        });
      }
      const problems = assertSafe(c.name, resp, c.payload, c.kind);
      if (problems.rejected) rejected++;
      if (problems.length) fails.push({ name: c.name, problems, status: resp.status, sample: resp.text.slice(0, 120) });
      done++;
      if (!QUIET && done % 50 === 0) console.log(`  … ${done}/${cases.length}`);
    }
  }
  const queue = [...cases];
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(queue)));

  /* ---------------- RBAC 鉴权 + 限流（2026-10-09） ---------------- */
  // 错误密码 → 401
  const loginBad = await request('/api/v1/auth/login', { method: 'POST', body: { username: 'admin', password: 'wrong' } });
  if (loginBad.status !== 401) fails.push({ name: '登录错误密码应 401', problems: [`实得 ${loginBad.status}`], status: loginBad.status, sample: loginBad.text.slice(0, 120) });

  // 无令牌访问 /auth/me → 401
  const meNoToken = await request('/api/v1/auth/me', { method: 'GET' });
  if (meNoToken.status !== 401) fails.push({ name: 'GET /auth/me 无令牌应 401', problems: [`实得 ${meNoToken.status}`], status: meNoToken.status, sample: meNoToken.text.slice(0, 120) });

  // 默认管理员登录 → 200 + token
  const adminU = process.env.LH_ADMIN_USER || 'admin';
  const adminP = process.env.LH_ADMIN_PASS || 'lihui-admin-2026';
  const loginOk = await request('/api/v1/auth/login', { method: 'POST', body: { username: adminU, password: adminP } });
  let adminToken = '';
  if (loginOk.status === 200) { try { adminToken = JSON.parse(loginOk.text).data.token; } catch (_) {} }
  if (loginOk.status !== 200 || !adminToken) fails.push({ name: '默认管理员登录应 200', problems: [`实得 ${loginOk.status}`], status: loginOk.status, sample: loginOk.text.slice(0, 120) });
  else {
    const meOk = await request('/api/v1/auth/me', { method: 'GET', headers: { Authorization: `Bearer ${adminToken}` } });
    if (meOk.status !== 200) fails.push({ name: 'GET /auth/me 带令牌应 200', problems: [`实得 ${meOk.status}`], status: meOk.status, sample: meOk.text.slice(0, 120) });
    const secOk = await request('/api/v1/security/events', { method: 'GET', headers: { Authorization: `Bearer ${adminToken}` } });
    if (secOk.status !== 200) fails.push({ name: 'admin 令牌访问 /security/events 应 200', problems: [`实得 ${secOk.status}`], status: secOk.status, sample: secOk.text.slice(0, 120) });
  }

  // 公开注册 user → 200 + token；user 令牌访问 admin 端点 → 403（回环豁免只在「无令牌」时生效）
  const reg = await request('/api/v1/auth/register', { method: 'POST', body: { username: 'e2euser_' + Date.now(), password: 'e2epass123' } });
  let userToken = '';
  if (reg.status === 200) { try { userToken = JSON.parse(reg.text).data.token; } catch (_) {} }
  if (reg.status !== 200 || !userToken) fails.push({ name: '公开注册应 200', problems: [`实得 ${reg.status}`], status: reg.status, sample: reg.text.slice(0, 120) });
  else {
    const userAdmin = await request('/api/v1/security/events', { method: 'GET', headers: { Authorization: `Bearer ${userToken}` } });
    if (userAdmin.status !== 403) fails.push({ name: 'user 令牌访问 admin 端点应 403', problems: [`实得 ${userAdmin.status}`], status: userAdmin.status, sample: userAdmin.text.slice(0, 120) });
  }

  // 响应头含 X-RateLimit-*
  const hdr = await request('/api/v1/config/public', { method: 'GET' });
  if (!hdr.head['x-ratelimit-limit']) fails.push({ name: '响应应含 X-RateLimit-Limit 头', problems: ['缺失'], status: hdr.status, sample: '' });

  // 限流：固定 device-id 打满单设备 60/min → 应出现 429
  let got429 = false;
  const shots = await Promise.all(
    Array.from({ length: 130 }, () => request('/api/v1/config/public', { method: 'GET', headers: { 'X-Device-Id': 'rate-fixed-device' } }))
  );
  for (const s of shots) if (s.status === 429) got429 = true;
  if (!got429) fails.push({ name: '限流应触发 429（单设备 60/min）', problems: ['未出现 429'], status: 0, sample: '' });

  /* 蜜罐封禁（最后执行）：塞入已知蜜罐 key → 期望 4xx 且安全日志记下。
   * 放在所有其他断言之后，是因为命中蜜罐会封禁本机 IP（loopback），
   * 若提前跑会让后续 RBAC/限流请求被 403 连带失败。 */
  const pot = PAYLOADS.honeypot[0];
  const potRes = await request(`/api/v1/agent/standards?q=${encodeURIComponent('测试')}&ak=${pot}`);
  const potBlocked = potRes.status === 403 || potRes.status === 429 || /honeypot|forbidden|封禁/i.test(potRes.text);
  if (!potBlocked) fails.push({ name: '蜜罐假 key 封禁', problems: [`期望 403/429，实得 ${potRes.status}`], status: potRes.status, sample: potRes.text.slice(0, 120) });

  /* 报告 */  const pass = cases.length + 1 - fails.length;
  console.log('\n──────── E2E 安全测试报告 ────────');
  console.log(`总用例: ${cases.length + 1}   通过: ${pass}   其中溢出拒绝(预期): ${rejected}   失败: ${fails.length}   耗时: ${Date.now() - t0}ms`);
  if (fails.length) {
    console.log('\n失败明细（前 20 条）:');
    fails.slice(0, 20).forEach((f) => console.log(`  ✗ [${f.status}] ${f.name}\n      ${f.problems.join('；')}\n      ${JSON.stringify(f.sample)}`));
    process.exitCode = 1;
  } else {
    console.log('✅ 全部通过：恶意入参不 5xx、无密钥泄露、无 XSS 回显、无 CRLF 污染、蜜罐生效。');
  }
}

run().catch((e) => { console.error('runner error:', e); process.exitCode = 1; });
