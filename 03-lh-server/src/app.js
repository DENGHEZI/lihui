/**
 * 鲤慧 LiHui · 服务端入口（零外部依赖）
 *   - HTTP 路由 + 静态资源 + CORS
 *   - 启动时拉起 MCP Server
 *   - 统一错误处理、限流、结构化日志
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const logger = require('./utils/logger');
const { json, fail, readBody, clientIp, TRACE } = require('./utils/http');
const hub = require('./mcp/hub');

/* ---------------- 路由表 ---------------- */
const modules = ['./routes/system', './routes/ip', './routes/map', './routes/life', './routes/agent', './routes/mcp', './routes/model', './routes/voice', './routes/token', './routes/feedback', './routes/action'];
const ROUTES = {};
for (const m of modules) {
  try {
    Object.assign(ROUTES, require(m));
  } catch (e) {
    logger.error('app', `加载路由 ${m} 失败: ${e.message}`);
  }
}

const API_PREFIX = '/api/v1';

/* ---------------- 简易限流：60 次/分钟/设备 ---------------- */
const RATE = { windowMs: 60000, max: 60 };
const rateMap = new Map();
function rateLimited(key) {
  const now = Date.now();
  const rec = rateMap.get(key);
  if (!rec || now - rec.start > RATE.windowMs) {
    rateMap.set(key, { start: now, count: 1 });
    return false;
  }
  rec.count += 1;
  return rec.count > RATE.max;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateMap) if (now - v.start > RATE.windowMs * 2) rateMap.delete(k);
}, 300000).unref();

/* ---------------- 静态资源 ---------------- */
const MIME = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.json': 'application/json', '.txt': 'text/plain' };
function serveStatic(req, res, urlPath) {
  // /static/** → 03-lh-server/data/**
  const rel = urlPath.replace(/^\/static\/?/, '');
  const full = path.resolve(config.dataDir, rel);
  if (!full.startsWith(config.dataDir)) {
    return json(res, { code: 1001, msg: 'invalid path' }, 400);
  }
  fs.readFile(full, (err, buf) => {
    if (err) return json(res, { code: 4040, msg: 'not found' }, 404);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'public, max-age=600' });
    res.end(buf);
  });
}

/* ---------------- 主服务 ---------------- */
const server = http.createServer(async (req, res) => {
  const traceId = TRACE();
  const t0 = Date.now();
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

  // 根路径
  if (pathname === '/' || pathname === '/index.html') {
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

  // 限流（探活与静态不限）
  const deviceId = req.headers['x-device-id'] || clientIp(req).ip || 'anonymous';
  if (rateLimited(deviceId)) {
    return fail(res, 1003, '请求过于频繁（60 次/分钟），请稍后再试', 429, { traceId });
  }

  const q = {};
  for (const [k, v] of u.searchParams.entries()) q[k] = v;

  try {
    let body = {};
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      body = await readBody(req);
    }
    const result = await handler(req, res, q, body);
    if (result === undefined && !res.writableEnded) {
      return fail(res, 5000, 'handler 未返回响应', 500, { traceId });
    }
    logger.info('http', `${req.method} ${pathname}`, { ms: Date.now() - t0, device: deviceId.slice(0, 24), traceId });
  } catch (e) {
    logger.error('http', `${req.method} ${pathname} 异常: ${e.message}`, { stack: (e.stack || '').split('\n').slice(0, 4).join(' | '), traceId });
    if (!res.writableEnded) fail(res, 5000, `服务端内部错误：${e.message}`, 500, { traceId });
  }
});

/* ---------------- 启动 ---------------- */
async function bootstrap() {
  const { port, host } = config.server;
  server.listen(port, host, async () => {
    logger.info('app', `鲤慧服务端已启动 http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`);
    logger.info('app', `百度地图 AK：${config.baidu.ak ? config.baidu.ak.slice(0, 6) + '****' + config.baidu.ak.slice(-4) : '未配置'}`);
    logger.info('app', `数据目录：${config.dataDir}`);
    logger.info('app', `路由数量：${Object.keys(ROUTES).length}`);

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
process.on('SIGINT', async () => {
  logger.info('app', '收到 SIGINT，正在关闭 MCP Server…');
  for (const s of hub.list()) if (s.status === 'running') await hub.stopOne(s.id).catch(() => {});
  process.exit(0);
});

if (require.main === module) bootstrap();

module.exports = { server, bootstrap };
