/**
 * 鲤慧 LiHui · 百度底图站点服务（零外部依赖，只用 Node 标准库）
 *
 * 为什么需要这一层：
 *  1) 百度 JS API 对 AK 做 Referer 白名单校验。本项目用的是「服务端 AK」，
 *     它的白名单里没有 web-view 页面的域名，直接 <script src="api.map.baidu.com/api?ak=...">
 *     会被判 error:240 / 220 而拿不到地图脚本。
 *     ⇒ 本服务转发时统一伪造 Referer: https://map.baidu.com/，百度照常返回真脚本/真瓦片。
 *  2) 瓦片同理：apimaponline*.bdimg.com 也看 Referer，代理后以同源返回给前端，
 *     顺带规避小程序 web-view 里跨域瓦片被 ORB 拦截的问题。
 *  3) AK 不下发端上 —— 页面由后端渲染时把 __AK__ 替换掉，前端只看到已经注入好的地址。
 *
 * 路由（都挂在 API_PREFIX 之外，直接放行）：
 *  GET /map-home?lat=&lng=       → 百度底图首页（高德式全屏地图 + 底部面板）
 *  GET /bmap/tile?x=&y=&z=       → 瓦片代理
 *  GET /bmap/proxy?u=<encodeURI>  → api.map.baidu.com 通用代理（JS API 脚本也走这里）
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const config = require('../config');
const logger = require('../utils/logger');
const security = require('../utils/security');

const STATIC_DIR = path.resolve(__dirname, '..', 'static');
const PAGE_FILE = path.join(STATIC_DIR, 'bmap-home.html');

/** 百度唯一认的合法 Referer */
const BAIDU_REFERER = 'https://map.baidu.com/';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const TILE_HOSTS = [0, 1, 2, 3].map((i) => `apimaponline${i}.bdimg.com`);
/** 百度瓦片版本，过期会导致底图空白，可按需要更新 */
const TILE_UDT = '20260929';

/* ---------------- 极简 https 请求（不引第三方） ----------------
   本机/公司网络常挂代理（Clash / V2Ray / 公司网关），Node 默认不读
   HTTPS_PROXY / HTTP_PROXY，直连会 ECONNREFUSED。这里手动支持：
   - https 目标：先给代理发 CONNECT 拿隧道 socket，再在 socket 上发 https 请求
   - http  目标：直接把完整 URL 以 absolute-form 发给代理
   云托管容器里没有代理变量时，走原来的直连分支，行为不变。
------------------------------------------------------------------ */
function proxyFor(isHttps) {
  if (isHttps) return process.env.HTTPS_PROXY || process.env.https_proxy || '';
  return process.env.HTTP_PROXY || process.env.http_proxy || '';
}

function connectTunnel(proxyUrl, host, port, timeout) {
  return new Promise((resolve, reject) => {
    const p = new URL(proxyUrl);
    const req = http.request({
      host: p.hostname,
      port: Number(p.port) || 80,
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers: { Host: `${host}:${port}` },
    });
    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) return reject(new Error('代理隧道建立失败 ' + res.statusCode));
      resolve(socket);
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => req.destroy(new Error('代理连接超时')));
    req.end();
  });
}

function onceRequest(opts) {
  return new Promise((resolve, reject) => {
    const mod = opts.isHttps ? https : http;
    const req = mod.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(opts.timeout, () => req.destroy(new Error('百度接口超时')));
    req.end();
  });
}

async function fetchUrl(url, extraHeaders, timeout = 8000) {
  let u;
  try {
    u = new URL(url);
  } catch (e) {
    throw new Error('非法地址');
  }
  const isHttps = u.protocol === 'https:';
  const port = Number(u.port) || (isHttps ? 443 : 80);
  const headers = Object.assign(
    { 'User-Agent': UA, Referer: BAIDU_REFERER, Accept: '*/*', 'Accept-Language': 'zh-CN,zh;q=0.9' },
    extraHeaders || {}
  );
  const proxy = proxyFor(isHttps);

  if (proxy) {
    if (isHttps) {
      const socket = await connectTunnel(proxy, u.hostname, port, timeout);
      return onceRequest({
        isHttps: true,
        host: u.hostname,
        port,
        path: u.pathname + u.search,
        method: 'GET',
        headers,
        socket,
        agent: false,
        timeout,
      });
    }
    const p = new URL(proxy);
    return onceRequest({
      isHttps: false,
      host: p.hostname,
      port: Number(p.port) || 80,
      path: url, // absolute-form
      method: 'GET',
      headers,
      agent: false,
      timeout,
    });
  }

  return onceRequest({
    isHttps,
    host: u.hostname,
    port,
    path: u.pathname + u.search,
    method: 'GET',
    headers,
    timeout,
  });
}

/* ---------------- 页面 ---------------- */
/* 安全(2026-10-06 升级):
 *  ⚠️ 旧版这里 `query.ak || config.baidu.ak` 把【服务端真 AK】明文注入 HTML,
 *     任何访问 /map-home 的人 curl 一下源码就能拿到 AK —— 即本次「API 被盗」的主渠道。
 *  现在改为只注入「浏览器端 AK」(百度控制台单独创建,Referer 白名单锁定本站域名,
 *  泄露无害、可独立重置);未配置时注入蜜罐 AK —— 扒页面的人拿到的是废钥匙,
 *  谁拿着蜜罐回来打接口,security.log 会立刻记下来源。query.ak 注入通道一并封死。 */
function serveHome(res, query) {
  let html;
  try {
    html = fs.readFileSync(PAGE_FILE, 'utf8');
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('底图页面缺失：' + e.message);
  }
  const ak = config.baidu.akBrowser || security.HONEYPOT_AK_WEB;
  const lat = Number(query.lat);
  const lng = Number(query.lng);
  const seed =
    Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0)
      ? { lat, lng }
      : { lat: 28.228209, lng: 112.938814 }; // 长沙默认

  html = html
    .replace(/__AK__/g, ak)
    .replace(/__LAT__/g, String(seed.lat))
    .replace(/__LNG__/g, String(seed.lng))
    .replace(/__RADIUS__/g, String(query.radius || 1200));

  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-cache',
  });
  res.end(html);
}

/* ---------------- 瓦片 ---------------- */
async function serveTile(res, query) {
  const x = query.x;
  const y = query.y;
  const z = query.z;
  if (x === undefined || y === undefined || z === undefined) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('x/y/z 必填');
  }
  const host = TILE_HOSTS[Math.abs(hash(x + y)) % TILE_HOSTS.length];
  const url = `https://${host}/tile/?qt=vtile&x=${encodeURIComponent(x)}&y=${encodeURIComponent(y)}&z=${encodeURIComponent(
    z
  )}&styles=pl&scaler=1&udt=${TILE_UDT}&v=3.0&ak=${encodeURIComponent(config.baidu.ak || '')}`;

  try {
    const r = await fetchUrl(url);
    if (r.statusCode !== 200) {
      logger.warn('bmap', `瓦片 ${z}/${x}/${y} 上游 ${r.statusCode}`);
      res.writeHead(r.statusCode);
      return res.end();
    }
    const ct = r.headers['content-type'] || '';
    if (!/image/i.test(ct)) {
      // 百度有时回文本（限流/参数错），别把 HTML 当图片返回
      logger.warn('bmap', `瓦片 ${z}/${x}/${y} 返回非图片：${ct}`);
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('瓦片代理失败');
    }
    res.writeHead(200, {
      'Content-Type': ct,
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*',
    });
    return res.end(r.body);
  } catch (e) {
    logger.warn('bmap', `瓦片代理异常 ${e.message}`);
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('瓦片代理异常');
  }
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

/* ---------------- 通用代理（JS API 脚本 / JSONP） ---------------- */
/* 安全(2026-10-06 升级):旧版是【无白名单开放代理】——任意 URL 都能借用本服务转发
 * (还自带百度 Referer 头),存在 SSRF 风险:可探测内网、白嫖带宽、伪造来源刷百度。
 * 现在收紧为「百度域名白名单」:仅允许 api.map.baidu.com / map.baidu.com 及其子域,
 * 裸 IP / localhost / 内网域一律拒绝。 */
const PROXY_ALLOW_HOSTS = ['api.map.baidu.com', 'map.baidu.com', 'baidu.com', 'bdimg.com'];
function proxyTargetAllowed(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch (_) {
    return false;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  const h = (u.hostname || '').toLowerCase();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return false; // 裸 IP(SSRF 打内网的典型形态)
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return false;
  if (h.includes(':')) return false; // IPv6 字面量
  return PROXY_ALLOW_HOSTS.some((d) => h === d || h.endsWith('.' + d));
}

async function serveProxy(res, query) {
  const target = query.u;
  if (!target) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('u 必填');
  }
  const decoded = decodeURIComponent(target);
  if (!proxyTargetAllowed(decoded)) {
    logger.warn('bmap', `代理目标被拒绝(白名单外): ${decoded.slice(0, 120)}`);
    res.writeHead(403, { 'Content-Type': 'application/javascript; charset=utf-8' });
    return res.end('/* proxy target not allowed */');
  }
  try {
    const r = await fetchUrl(decoded);
    const ct = r.headers['content-type'] || 'application/javascript; charset=utf-8';
    res.writeHead(r.statusCode || 200, {
      'Content-Type': ct,
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    });
    return res.end(r.body);
  } catch (e) {
    logger.warn('bmap', `代理异常 ${e.message}`);
    res.writeHead(502, { 'Content-Type': 'application/javascript; charset=utf-8' });
    return res.end('/* proxy error */');
  }
}

/* ---------------- 入口 ---------------- */
async function handle(req, res, url) {
  const pathname = decodeURIComponent(url.pathname);
  const query = {};
  for (const [k, v] of url.searchParams.entries()) query[k] = v;

  try {
    if (pathname === '/map-home' || pathname === '/map_home') return serveHome(res, query);
    if (pathname === '/bmap/tile') return await serveTile(res, query);
    if (pathname === '/bmap/proxy') return await serveProxy(res, query);
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('not found');
  } catch (e) {
    logger.error('bmap', `底图路由异常 ${e.message}`);
    if (!res.writableEnded) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('底图服务异常：' + e.message);
    }
  }
}

module.exports = { handle, fetchUrl, BAIDU_REFERER };
