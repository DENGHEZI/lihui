/**
 * 鲤慧 LiHui · HTTP 工具（零依赖）
 *  - json(): 统一响应体
 *  - readBody(): 解析 JSON / 表单 / multipart 原始体
 *  - fetchJSON(): 带超时、重试、GET/POST 的抓取
 *  - clientIp(): 自动锚定用户 IP 的取址逻辑
 */
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { URL } = require('url');
const logger = require('./logger');
const config = require('../config');

const TRACE = () => 'tr_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

const GZIP_MIN_BYTES = 512; // 小于 512B 不压缩（压不满头反而变大）

function json(res, data, status = 200, headers = {}) {
  const body = JSON.stringify(data);
  const h = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': (config.server && config.server.corsOrigin) || '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Device-Id, X-Trace-Id',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    // CORS_ORIGIN 配置为具体域名时告知缓存按 Origin 区分（issue #6：与 OPTIONS 预检口径统一）
    'Vary': 'Origin',
    'X-Trace-Id': headers['X-Trace-Id'] || TRACE(),
    ...headers,
  };
  // 性能：客户端支持 gzip 且响应体足够大时压缩（wx.request / 浏览器均自动解压）
  const acceptEnc = (res.req && res.req.headers && res.req.headers['accept-encoding']) || '';
  if (acceptEnc.includes('gzip') && Buffer.byteLength(body) >= GZIP_MIN_BYTES) {
    const gz = zlib.gzipSync(body);
    h['Content-Encoding'] = 'gzip';
    h['Content-Length'] = gz.length;
    res.writeHead(status, h);
    res.end(gz);
    return;
  }
  res.writeHead(status, h);
  res.end(body);
}

function ok(res, data, headers) {
  return json(res, { code: 0, msg: 'ok', data, traceId: (headers && headers['X-Trace-Id']) || TRACE() }, 200, headers);
}

function fail(res, code = 5000, msg = '服务端内部错误', status = 200, extra) {
  return json(res, { code, msg, data: null, ...(extra || {}) }, status);
}

/** 解析请求体 */
function readBody(req, { maxBytes = 20 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      const ct = String(req.headers['content-type'] || '');
      if (ct.includes('application/json')) {
        try {
          resolve(buf.length ? JSON.parse(buf.toString('utf8')) : {});
        } catch (e) {
          reject(new Error('invalid json body'));
        }
      } else if (ct.includes('multipart/form-data')) {
        resolve({ __raw: buf, __contentType: ct });
      } else if (ct.includes('application/x-www-form-urlencoded')) {
        const q = new URLSearchParams(buf.toString('utf8'));
        const o = {};
        for (const [k, v] of q.entries()) o[k] = v;
        resolve(o);
      } else {
        resolve({ __raw: buf });
      }
    });
    req.on('error', reject);
  });
}

/** 通用抓取 */
function fetchJSON(url, { method = 'GET', body = null, headers = {}, timeout = 8000, retry = 1 } = {}) {
  return new Promise((resolve, reject) => {
    const attempt = (left) => {
      let u;
      try {
        u = new URL(url);
      } catch (e) {
        return reject(new Error('bad url: ' + url));
      }
      const lib = u.protocol === 'https:' ? https : http;
      const payload = body == null ? null : typeof body === 'string' ? body : JSON.stringify(body);
      const req = lib.request(
        {
          protocol: u.protocol,
          hostname: u.hostname,
          port: u.port || (u.protocol === 'https:' ? 443 : 80),
          path: u.pathname + u.search,
          method,
          headers: {
            'User-Agent': 'lihui-server/1.0',
            Accept: 'application/json',
            ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
            ...headers,
          },
          timeout,
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            if (res.statusCode >= 400) {
              const err = new Error(`HTTP ${res.statusCode}: ${text.slice(0, 200)}`);
              err.statusCode = res.statusCode;
              return reject(err);
            }
            try {
              resolve(text ? JSON.parse(text) : {});
            } catch (e) {
              resolve({ __text: text });
            }
          });
        }
      );
      req.on('timeout', () => {
        req.destroy(new Error('request timeout'));
      });
      req.on('error', (e) => {
        if (left > 0) {
          logger.warn('http', `retry(${left}) ${url} ${e.message}`);
          setTimeout(() => attempt(left - 1), 300);
        } else reject(e);
      });
      if (payload) req.write(payload);
      req.end();
    };
    attempt(retry);
  });
}

/** 自动锚定用户 IP：
 *  安全口径（issue #1/#2）：
 *  - 仅当 TRUST_PROXY=true（挂在可信反代后面）才读 x-forwarded-for 等转发头取真实客户端 IP；
 *  - 直连部署默认不信任任何客户端可伪造的头 —— 伪造 X-Forwarded-For: 127.0.0.1 不再能
 *    冒充回环（绕过 IP 封禁 / IP 地板限流 / allowLoopbackAdmin 提权）；
 *  - local 回环判定只看 TCP 层真实对端地址（req.socket.remoteAddress），与请求头无关。 */
function clientIp(req) {
  const h = req.headers || {};
  const pick = (v) => String(v || '').split(',')[0].trim();
  const trustProxy = !!(config.server && config.server.trustProxy);

  // TCP 层真实对端地址（唯一不可伪造的来源）
  let ra = String((req.socket && req.socket.remoteAddress) || '');
  if (ra.startsWith('::ffff:')) ra = ra.slice(7); // IPv4-mapped IPv6 归一化
  const raLocal = ra === '::1' || ra === '127.0.0.1';

  let ip = '';
  if (trustProxy) {
    ip = pick(h['x-forwarded-for']);
    if (!ip) ip = pick(h['x-real-ip']);
    if (!ip) ip = pick(h['cf-connecting-ip']);
    if (!ip) ip = pick(h['x-client-ip']);
  }
  if (!ip) ip = ra;
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);

  // 回环只由真实对端地址决定；转发头里出现的 127.0.0.1 不算 local（直连部署下可伪造）
  if (raLocal) return { ip: '127.0.0.1', local: true };
  return { ip: ip || 'unknown', local: false };
}

function isPrivateIp(ip) {
  if (!ip) return true;
  return (
    /^10\./.test(ip) ||
    /^192\.168\./.test(ip) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
    /^127\./.test(ip) ||
    /^169\.254\./.test(ip) ||
    ip === 'localhost'
  );
}

module.exports = { json, ok, fail, readBody, fetchJSON, clientIp, isPrivateIp, TRACE };
