/**
 * 鲤慧 LiHui · 服务端入口（零外部依赖）
 *   - HTTP 路由 + 静态资源 + CORS
 *   - 启动时拉起 MCP Server
 *   - 统一错误处理、限流、结构化日志
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const cluster = require('cluster');
const config = require('./config');
const logger = require('./utils/logger');
const store = require('./services/store');
const { json, fail, readBody, clientIp, TRACE } = require('./utils/http');
const security = require('./utils/security');
const hub = require('./mcp/hub');
const auth = require('./services/auth');

// ★ 可选模块：百度底图站点（/map-home、瓦片代理、JS API 代理）。
//   早先这里是直接 require，而这个 service 一度【没提交进 Gitee】——
//   云托管从仓库 build 时 require 直接抛错，整个进程起不来，健康检查全挂。
//   现在降级处理：模块缺失只让地图站停用，主服务（定位/商城/订单/助手）照常可用。
//   ⚠️ 但同时要保证文件真的入库（见本文件末尾的启动自检）。
let bmapSite = null;
try {
  bmapSite = require('./services/bmapSite');
} catch (e) {
  bmapSite = null;
  logger.warn('app', `百度底图站点模块缺失，/map-home 与瓦片代理已停用: ${e.message}`);
}

/* ---------------- 路由表 ---------------- */
const modules = ['./routes/system', './routes/ip', './routes/map', './routes/life', './routes/agent', './routes/mcp', './routes/model', './routes/voice', './routes/token', './routes/feedback', './routes/action', './routes/shop', './routes/order', './routes/profile', './routes/security', './routes/memory', './routes/privacy', './routes/auth'];
const ROUTES = {};
for (const m of modules) {
  try {
    Object.assign(ROUTES, require(m));
  } catch (e) {
    logger.error('app', `加载路由 ${m} 失败: ${e.message}`);
  }
}

const API_PREFIX = '/api/v1';

/* ---------------- RBAC 路由→最低角色（省略即 guest 公开） ----------------
 * 受保护的多为「管理/运维/写」端点；面向 C 端的体检/地图/助手/商城保持匿名可用，
 * 以不破坏小程序与网页版的既有调用。改一行即可收紧任意路由。 */
const ROUTE_ROLE = {
  'GET /security/events': auth.ROLE.admin,
  'POST /token/quota': auth.ROLE.admin,
  'POST /memory/analyze': auth.ROLE.admin,
  'POST /memory/verify': auth.ROLE.admin,
  'POST /memory/decide': auth.ROLE.admin,
  'GET /feedback/list': auth.ROLE.admin,
  'GET /feedback/detail': auth.ROLE.admin,
  'POST /feedback/handle': auth.ROLE.admin,
  'GET /feedback/summary': auth.ROLE.admin,
  'POST /mcp/toggle': auth.ROLE.admin,
  'POST /mcp/restart': auth.ROLE.admin,
  'POST /mcp/call': auth.ROLE.admin,
  'POST /mcp/install': auth.ROLE.admin,
  'POST /mcp/remove': auth.ROLE.admin,
  'POST /voice/config': auth.ROLE.admin,
  'GET /stats': auth.ROLE.admin,
  // 监控告警 / 备份恢复（运维面，admin 专属）
  'GET /system/metrics': auth.ROLE.admin,
  'GET /system/alerts': auth.ROLE.admin,
  'POST /system/alerts/check': auth.ROLE.admin,
  'GET /system/backups': auth.ROLE.admin,
  'POST /system/backups': auth.ROLE.admin,
  'POST /system/backups/restore': auth.ROLE.admin,
  // 隐私合规：同意/导出/删除是用户对自己的权利，保持 guest 可用（设备维度自证）
  'GET /auth/me': auth.ROLE.user,
  'POST /auth/profile': auth.ROLE.user,
};

/* ---------------- 限流：角色感知令牌桶 + 标准响应头（2026-10-09 升级） ----------------
 *  - 身份维度：匿名设备/账号按身份限速，管理员更高；
 *  - IP 地板：仅对非回环来源生效（防客户端伪造 x-device-id 绕过）；回环=本机可信，免地板；
 *  - 响应头：X-RateLimit-Limit / Remaining / Reset，429 时附 Retry-After。 */
const RL = {
  // 2026-10-10 提高并发阈值：网页版多视图并发拉取 + 多人同时访问，原 guest burst=10
  // 易误伤正常浏览（429 风暴观感）；百度 401 已有 45s 短熔断自愈，入口侧放宽。
  guest: { rpm: 120, burst: 25 },
  user: { rpm: 600, burst: 80 },
  admin: { rpm: 3000, burst: 300 },
  ipFloor: { rpm: 240, burst: 50 }, // 单 IP 硬上限（防 deviceId 伪造绕过），仅非回环
};
const RATE_WINDOW = 60000;
const rateBuckets = new Map();
function rateBucket(key, rpm, burst) {
  const now = Date.now();
  let b = rateBuckets.get(key);
  if (!b || b.rpm !== rpm || b.burst !== burst) {
    b = { tok: burst, ts: now, rpm, burst };
    rateBuckets.set(key, b);
  }
  const perMs = rpm / RATE_WINDOW;
  b.tok = Math.min(b.burst, b.tok + (now - b.ts) * perMs);
  b.ts = now;
  return b;
}
function rateCheck(key, rpm, burst) {
  const b = rateBucket(key, rpm, burst);
  if (b.tok >= 1) {
    b.tok -= 1;
    const resetMs = Math.ceil((1 - b.tok) / (rpm / RATE_WINDOW));
    return { limited: false, remaining: Math.max(0, Math.floor(b.tok)), limit: burst, reset: Math.ceil((Date.now() + Math.max(0, resetMs)) / 1000) };
  }
  const retryAfter = Math.max(1, Math.ceil((1 - b.tok) / (rpm / RATE_WINDOW) / 1000));
  return { limited: true, remaining: 0, limit: burst, reset: Math.ceil((Date.now() + retryAfter * 1000) / 1000), retryAfter };
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateBuckets) if (now - v.ts > RATE_WINDOW * 2) rateBuckets.delete(k);
}, 120000).unref();

/* ---------------- 静态资源 ---------------- */
const MIME = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.json': 'application/json', '.txt': 'text/plain', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.map': 'application/json' };

/* 浏览器沙箱隔离（2026-10-09，2026-10-10 V1.0.27 加固）：
 * CSP 限定脚本/样式/连接只能同源+内联，外域注入脚本/iframe 嵌套全部被浏览器拒绝；
 * img-src 只放行高德瓦片（等时圈底图）、data:/blob: 与百度瓦片域（AK 配置后随时可切回），
 * 第三方追踪像素进不来。
 * frame-ancestors 'self' + X-Frame-Options SAMEORIGIN = 仅允许本站内嵌（防点击劫持）。
 * 注意：页面含内联 script/style，故 'unsafe-inline' 保留（无 nonce 机制下的务实取衡），
 * 外域脚本仍被 default-src 'self' 挡死。若后续接入百度 JS API（api.map.baidu.com），
 * 需在 script-src 追加 https://api.map.baidu.com。 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://*.is.autonavi.com https://*.bdimg.com https://*.map.baidu.com",
  "connect-src 'self'",
  "font-src 'self' data:",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');
const SANDBOX_HEADERS = {
  'Content-Security-Policy': CSP,
  'X-Frame-Options': 'SAMEORIGIN',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'geolocation=(self), camera=(), microphone=(), payment=(), interest-cohort=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'X-Permitted-Cross-Domain-Policies': 'none',
};

/* helmet 式全局安全头注入：包一层 res.writeHead，让 API JSON / 404 / 静态全部带上
 * （此前只有静态文件带了，API 响应是裸的）。HTTPS（反代 x-forwarded-proto）时加 HSTS。 */
function applySecurityHeaders(req, res) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const isHttps = (!!req.socket && req.socket.encrypted) || proto === 'https';
  const extra = isHttps ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {};
  const wh = res.writeHead.bind(res);
  res.writeHead = (code, headers) => wh(code, { ...SANDBOX_HEADERS, ...extra, ...(headers || {}) });
}

function serveStatic(req, res, urlPath) {
  // /static/** → 03-lh-server/data/**
  const rel = urlPath.replace(/^\/static\/?/, '');
  const full = path.resolve(config.dataDir, rel);
  if (!full.startsWith(config.dataDir)) {
    return json(res, { code: 1001, msg: 'invalid path' }, 400);
  }
  fs.readFile(full, (err, buf) => {
    if (err) return json(res, { code: 4040, msg: 'not found' }, 404);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'public, max-age=600', ...SANDBOX_HEADERS });
    res.end(buf);
  });
}

/* /vendor/** → src/static/vendor/**（前端本地化的第三方库，如 Leaflet。
 * ⚠️ 不能塞 data/：那是运行时数据目录，云托管重建/备份都会被污染） */
function serveVendor(req, res, urlPath) {
  const rel = urlPath.replace(/^\/vendor\/?/, '');
  const base = path.resolve(__dirname, 'static', 'vendor');
  const full = path.resolve(base, rel);
  if (!full.startsWith(base)) {
    return json(res, { code: 1001, msg: 'invalid path' }, 400);
  }
  fs.readFile(full, (err, buf) => {
    if (err) return json(res, { code: 4040, msg: 'not found' }, 404);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'public, max-age=86400', ...SANDBOX_HEADERS });
    res.end(buf);
  });
}

/* ---------------- 主服务 ---------------- */
const server = http.createServer(async (req, res) => {
  const traceId = TRACE();
  const t0 = Date.now();
  applySecurityHeaders(req, res); // helmet 式安全头：API/静态/404 全覆盖
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(u.pathname);

  // CORS 预检
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': config.server.corsOrigin,
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Device-Id, X-Trace-Id',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Max-Age': '86400',
    });
    return res.end();
  }

  // 静态
  if (pathname.startsWith('/static/')) return serveStatic(req, res, pathname);
  if (pathname.startsWith('/vendor/')) return serveVendor(req, res, pathname);

  // 根路径 → 鲤慧网页版（绑定 lihui-tech.online 后，访问域名即得网页版；
  // API 仍走 /api/v1/*，同源无跨域。页面文件缺失时回落原 JSON 自述，不影响服务）
  if (pathname === '/' || pathname === '/index.html') {
    const webFile = path.join(__dirname, 'static', 'web', 'index.html');
    try {
      let html = fs.readFileSync(webFile, 'utf8');
      // ★ 浏览器端 AK 注入（与 /map-home 同策略）：等时圈卡片内嵌百度地图需要 JS API。
      //   只注入 akBrowser（Referer 白名单锁定本站域名，泄露无害、可独立重置）；
      //   未配置时注入蜜罐 AK —— 扒页面的人拿到废钥匙，一打接口 security.log 立刻记下。
      const akBrowser = (bmapSite && config.baidu.akBrowser) ? config.baidu.akBrowser : security.webHoneypot();
      html = html.replace(/__AK__/g, akBrowser);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ...SANDBOX_HEADERS });
      return res.end(html);
    } catch (e) {
      return json(res, {
        code: 0,
        msg: 'ok',
        data: {
          name: '鲤慧 LiHui Server',
          version: '1.0.0',
          hint: '网页版静态文件缺失，仅返回 API 自述',
          docs: '见 00-设计文档/03-API与MCP接口文档.md',
          endpoints: Object.keys(ROUTES),
        },
        traceId,
      });
    }
  }

  // 隐私政策页（自包含静态页；缺失时回落 JSON 版政策全文，页面挂了合规也不缺位）
  if (pathname === '/privacy' || pathname === '/privacy.html') {
    const page = path.join(__dirname, 'static', 'web', 'privacy.html');
    try {
      const html = fs.readFileSync(page, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ...SANDBOX_HEADERS });
      return res.end(html);
    } catch (_) {
      return json(res, { code: 0, msg: 'ok', data: require('./services/privacy').POLICY });
    }
  }

  // 服务端自述（原来挂在 / 的 JSON 挪到这里，调试/健康巡检仍可用）
  if (pathname === '/server-info') {
    return json(res, {
      code: 0,
      msg: 'ok',
      data: {
        name: '鲤慧 LiHui Server',
        version: '1.0.0',
        docs: '见 00-设计文档/03-API与MCP接口文档.md',
        endpoints: Object.keys(ROUTES),
      },
      traceId,
    });
  }

  // 保底：容器平台（云托管 / 云厂商 / K8s）健康检查常探不带前缀的 /health、/ping。
  // 必须在下面 API_PREFIX 检查之前放行，否则会被直接 404 拦掉。
  const isPlainHealth = pathname === '/health' || pathname === '/ping';

  // ===== 安全防护(2026-10-06 升级) =====
  // 1) IP 封禁检查:命中蜜罐的来源在封禁期内直接 403
  const clientIP = clientIp(req).ip || 'unknown';
  if (security.isBanned(clientIP)) {
    return fail(res, 4031, '访问被临时限制', 403, { traceId });
  }
  // 2) 蜜罐检测:入站任何参数/头携带蜜罐密钥 → 判定密钥已从某渠道泄露,
  //    记 security.log + 封禁。覆盖所有路由(含 /map-home 等无前缀路由)。
  const q = {};
  for (const [k, v] of u.searchParams.entries()) q[k] = v;
  const honey = security.checkRequest(req, q, null);
  if (honey.hit) {
    security.recordHit({ ip: clientIP, req, key: honey.key, where: honey.where });
    return fail(res, 4031, 'invalid credential', 403, { traceId });
  }

  // 百度底图站点（web-view 首页 / 瓦片代理 / JS API 代理），不走 /api/v1 前缀
  if (bmapSite && (pathname === '/map-home' || pathname === '/map_home' || pathname.startsWith('/bmap/'))) {
    return await bmapSite.handle(req, res, u);
  }

  if (!pathname.startsWith(API_PREFIX) && !isPlainHealth) {
    return fail(res, 4040, 'not found', 404);
  }

  const key = pathname.slice(API_PREFIX.length) || '/';
  let handler = ROUTES[`${req.method} ${key}`];

  // 同义映射，避免「服务活着但探活 404 → 平台判部署失败」
  if (!handler && isPlainHealth) {
    handler = ROUTES['GET /health'];
  }

  if (!handler) {
    return fail(res, 4040, `接口不存在: ${req.method} ${pathname}`, 404, { traceId });
  }

  // ===== RBAC 鉴权(2026-10-09) =====
  const reqAuth = auth.fromRequest(req);
  req.auth = reqAuth;
  const routeKey = `${req.method} ${key}`;
  const needRole =
    ROUTE_ROLE[routeKey] !== undefined ? ROUTE_ROLE[routeKey] : ROUTE_ROLE[key] || auth.ROLE.guest;
  if (needRole > auth.ROLE.guest) {
    const isLoop = clientIp(req).local;
    const loopAdminOk = isLoop && config.auth && config.auth.allowLoopbackAdmin === true;
    if (reqAuth && reqAuth.role >= needRole) {
      // 已登录且角色满足 → 放行
    } else if (!reqAuth && loopAdminOk) {
      // 本机回环匿名 → 视为 admin（本地开发便利，保留 memory 旧行为）
      req.auth = { uid: 'loopback', username: 'loopback', role: auth.ROLE.admin, rank: auth.ROLE.admin };
    } else if (!reqAuth) {
      return fail(res, 4010, '未登录或令牌无效（请带 Authorization: Bearer <token>）', 401, { traceId });
    } else {
      return fail(res, 4031, `权限不足（需要 ${auth.ROLE_NAME[needRole] || '更高'} 角色）`, 403, { traceId });
    }
  }

  // ===== 限流（角色感知令牌桶 + 标准响应头；探活与静态不限） =====
  if (!isPlainHealth) {
    const roleRank = (req.auth && req.auth.role) || auth.ROLE.guest;
    const lim = roleRank >= auth.ROLE.admin ? RL.admin : roleRank >= auth.ROLE.user ? RL.user : RL.guest;
    const idKey =
      req.auth && req.auth.uid && req.auth.uid !== 'loopback'
        ? `u:${req.auth.uid}`
        : req.headers['x-device-id'] || clientIp(req).ip || 'anonymous';
    const rc = rateCheck(idKey, lim.rpm, lim.burst);
    let chosen = rc;
    // IP 地板：仅非回环来源生效（防伪造 deviceId 绕过）；回环免地板
    if (!clientIp(req).local) {
      const ipc = rateCheck(`ip:${clientIp(req).ip || 'unknown'}`, RL.ipFloor.rpm, RL.ipFloor.burst);
      if (ipc.limited) chosen = ipc;
    }
    res.setHeader('X-RateLimit-Limit', String(chosen.limit));
    res.setHeader('X-RateLimit-Remaining', String(chosen.remaining));
    res.setHeader('X-RateLimit-Reset', String(chosen.reset));
    if (chosen.limited) {
      res.setHeader('Retry-After', String(chosen.retryAfter || 1));
      return fail(res, 1003, '请求过于频繁，请稍后再试', 429, { traceId });
    }
  }

  // (q 已在上方安全防护段解析)

  try {
    let body = {};
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      body = await readBody(req);
    }
    // 3) body 蜜罐检测(POST/PUT 携带的 key 字段)
    const honeyBody = security.checkRequest(req, {}, body);
    if (honeyBody.hit) {
      security.recordHit({ ip: clientIP, req, key: honeyBody.key, where: honeyBody.where });
      return fail(res, 4031, 'invalid credential', 403, { traceId });
    }
    const result = await handler(req, res, q, body);
    if (result === undefined && !res.writableEnded) {
      return fail(res, 5000, 'handler 未返回响应', 500, { traceId });
    }
    logger.info('http', `${req.method} ${pathname}`, { ms: Date.now() - t0, device: (req.headers['x-device-id'] || clientIp(req).ip || 'anonymous').slice(0, 24), traceId });
  } catch (e) {
    logger.error('http', `${req.method} ${pathname} 异常: ${e.message}`, { stack: (e.stack || '').split('\n').slice(0, 4).join(' | '), traceId });
    if (!res.writableEnded) {
      // 请求体错误（坏 JSON / 超限）属客户端问题 → 400；其余才是 500
      const isClient = /invalid json body|body too large/i.test(e.message);
      fail(res, isClient ? 4000 : 5000, isClient ? `请求体错误：${e.message}` : `服务端内部错误：${e.message}`, isClient ? 400 : 500, { traceId });
    }
  }
});

/* ---------------- 启动 ---------------- */
async function bootstrap() {
  const { port, host } = config.server;
  server.listen(port, host, async () => {
    logger.info('app', `鲤慧服务端已启动 http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`);
    logger.info('app', `百度地图 AK：${config.baidu.ak ? config.baidu.ak.slice(0, 6) + '****' + config.baidu.ak.slice(-4) : '未配置'}`);
    logger.info('app', `数据目录：${config.dataDir}`);
    const st = store.stats();
    logger.info('app', `存储驱动：${st.driver}${st.driver === 'sqlite' ? `（${st.dbPath}${st.docs !== undefined ? `，${st.docs} docs` : ''}）` : '（data/*.json 单文件）'}`);
    logger.info('app', `进程模型：${cluster.isWorker ? `worker（主进程 ${process.ppid}，LH_WORKERS=${process.env.LH_WORKERS}）` : '单进程（设 LH_WORKERS>1 开启集群）'}`);
    logger.info('app', `路由数量：${Object.keys(ROUTES).length}`);
    // RBAC：首次启动播种默认管理员（库内已有用户则跳过）
    try {
      auth.bootstrapSeed();
    } catch (e) {
      logger.warn('app', `RBAC 播种失败（不影响启动）: ${e.message}`);
    }

    // ★ 启动自检：静态数据文件必须在镜像里，否则接口会「静默返回空」，
    //   本地跑得好好的、一上云就空白（典型：商品列表打不开）。
    for (const f of ['models.json', 'shop.json']) {
      const p = path.join(config.dataDir, f);
      if (fs.existsSync(p)) continue;
      logger.warn('app', `缺少静态数据 ${f}（期望 ${p}）→ 对应接口会返回空。容器环境请确认 Dockerfile 里有 COPY 这一行。`);
    }

    // 监控主动巡检 + 定期备份（零依赖闭环；任一失败不影响主服务）
    try {
      require('./services/monitor').start();
      require('./services/backup').start();
    } catch (e) {
      logger.warn('app', `监控/备份调度启动失败（不影响服务）: ${e.message}`);
    }

    if (config.mcp.autostart) {
      logger.info('app', '正在拉起 MCP Server…');
      try {
        const s = await hub.startEnabled('pro');
        logger.info('app', `MCP：${s.running}/${s.total} 运行中`);
      } catch (e) {
        logger.warn('app', `MCP 启动异常：${e.message}`);
      }
    }
  });
}

process.on('uncaughtException', (e) => logger.error('app', `uncaughtException: ${e.message}`, { stack: e.stack }));
process.on('unhandledRejection', (e) => logger.error('app', `unhandledRejection: ${e && e.message}`));

/* ---------------- 集群模式（2026-10-06 分布式） ----------------
 * LH_WORKERS>1 时：主进程 fork N 个 worker（cluster 自动共享监听端口、
 * 均摊连接），每个 worker 跑完整服务（含各自的 MCP 子进程，互为热备）。
 * 跨 worker / 跨实例的共享状态由统一存储层承担：
 *   - LH_STORE=sqlite（多进程必须）：node:sqlite WAL 多进程并发，零 npm 依赖
 *   - json 驱动多进程会互相覆盖（last-writer-wins），仅限单进程使用 */
const WORKERS = Math.max(1, Number(process.env.LH_WORKERS) || 1);
const IS_MULTI_PRIMARY = cluster.isPrimary && WORKERS > 1;

if (IS_MULTI_PRIMARY) {
  logger.info('app', `集群模式：LH_WORKERS=${WORKERS}，主进程 ${process.pid} 只管 worker 不监听`);
  for (let i = 0; i < WORKERS; i++) cluster.fork();
  cluster.on('exit', (w, code, sig) => {
    logger.warn('app', `worker#${w.id}（pid=${w.process.pid}）退出 code=${code} sig=${sig}，自动拉起替补`);
    cluster.fork();
  });
  const stopPrimary = (sig) => {
    logger.info('app', `主进程收到 ${sig}，正在关闭全部 worker…`);
    for (const id of Object.keys(cluster.workers)) cluster.workers[id].kill();
    setTimeout(() => process.exit(0), 3000);
  };
  process.on('SIGINT', () => stopPrimary('SIGINT'));
  process.on('SIGTERM', () => stopPrimary('SIGTERM'));
} else if (require.main === module) {
  bootstrap();
}

/* 单进程 / worker 的退出钩子（多进程主进程的退出由 stopPrimary 统一处理） */
const gracefulStop = async (sig) => {
  logger.info('app', `收到 ${sig}，正在关闭 MCP Server…`);
  try {
    for (const s of hub.list()) if (s.status === 'running') await hub.stopOne(s.id).catch(() => {});
  } catch (_) {}
  process.exit(0);
};
if (!IS_MULTI_PRIMARY) {
  process.on('SIGINT', () => gracefulStop('SIGINT'));
  process.on('SIGTERM', () => gracefulStop('SIGTERM')); // Docker stop / 云平台缩容都发 SIGTERM
}

module.exports = { server, bootstrap };
