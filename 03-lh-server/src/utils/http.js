/**
 * 鲤慧 LiHui · HTTP 工具（零依赖）
 *  - json(): 统一响应体
 *  - readBody(): 解析 JSON / 表单 / multipart 原始体
 *  - fetchJSON(): 带超时、重试、GET/POST 的抓取
 *  - clientIp(): 自动锚定用户 IP 的取址逻辑
 */
const http = require('http');
const https = require('https');
const { URL } = require('url');
const logger = require('./logger');

const TRACE = () => 'tr_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

function json(res, data, status = 200, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Device-Id, X-Trace-Id',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'X-Trace-Id': headers['X-Trace-Id'] || TRACE(),
    ...headers,
  });
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

/** 自动锚定用户 IP：按可信度从高到低取 */
function clientIp(req) {
  const h = req.headers || {};
  const pick = (v) => String(v || '').split(',')[0].trim();

  let ip = '';
  const xff = pick(h['x-forwarded-for']);
  if (xff) ip = xff;
  if (!ip) ip = pick(h['x-real-ip']);
  if (!ip) ip = pick(h['cf-connecting-ip']);
  if (!ip) ip = pick(h['x-client-ip']);
  if (!ip) {
    const ra = req.socket && req.socket.remoteAddress;
    ip = String(ra || '');
  }
  // IPv6 映射
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip === '::1' || ip === '127.0.0.1' || ip === '::ffff:127.0.0.1') {
    return { ip: ip || '127.0.0.1', local: true };
  }
  return { ip, local: false };
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
