#!/usr/bin/env node
/**
 * 鲤慧 LiHui · MCP Server: baidu-map
 * 百度地图开放能力 MCP —— 地理编码 / 逆地理编码 / 周边搜索 / 路线规划 / 天气 / 景点推荐
 *
 * 独立运行：
 *   BAIDU_AK=xxx node index.js
 * 挂载到任意 MCP 客户端：
 *   { "command":"node", "args":[".../04-lh-mcp-servers/baidu-map/index.js"],
 *     "env": { "BAIDU_AK": "<你的百度AK>" } }
 */
const readline = require('readline');
const http = require('http');
const https = require('https');

const AK = process.env.BAIDU_AK || '<你的百度AK>';
const BASE = process.env.BAIDU_MAP_BASE || 'https://api.map.baidu.com';
const LL = (lat, lng) => `${lat},${lng}`;

function fetchJSON(url, timeout = 9000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    lib
      .get(url, { timeout }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (e) {
            reject(new Error('响应解析失败'));
          }
        });
      })
      .on('error', reject)
      .on('timeout', function () {
        this.destroy(new Error('请求超时'));
      });
  });
}

async function api(pathname, params) {
  const qs = new URLSearchParams({ ...params, ak: AK, output: 'json' }).toString();
  const raw = await fetchJSON(`${BASE}${pathname}?${qs}`);
  if (raw && raw.status !== undefined && raw.status !== 0) {
    throw new Error(raw.message || raw.msg || `百度接口错误 status=${raw.status}`);
  }
  return raw;
}

/* ------------------------------ Tools ------------------------------ */
const TOOLS = [
  {
    name: 'geocode',
    description: '地址转经纬度（地理编码）。输入中文地址，返回 bd09ll 经纬度与置信度。',
    inputSchema: { type: 'object', properties: { address: { type: 'string', description: '结构化地址，如「长沙市岳麓区麓山南路932号」' }, city: { type: 'string', description: '限定城市（可选）' } }, required: ['address'] },
  },
  {
    name: 'reverse_geocode',
    description: '经纬度转地址（逆地理编码）。返回省市区、街道、最近 POI。',
    inputSchema: { type: 'object', properties: { lng: { type: 'number' }, lat: { type: 'number' } }, required: ['lng', 'lat'] },
  },
  {
    name: 'poi_search',
    description: '周边 POI 搜索。按关键词在半径内搜索，默认半径 1200 米（约 15 分钟步行）。',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: '关键词，如「药店」「菜市场」「公园」，可用 | 组合' }, lng: { type: 'number' }, lat: { type: 'number' }, radius: { type: 'number', description: '半径（米），默认 1200' }, pageSize: { type: 'number' } }, required: ['query', 'lng', 'lat'] },
  },
  {
    name: 'route_plan',
    description: '路线规划。支持步行 walking / 骑行 riding / 驾车 driving / 公交 transit；driving 可开实时避堵。',
    inputSchema: { type: 'object', properties: { mode: { type: 'string', enum: ['walking', 'riding', 'driving', 'transit'] }, origin: { type: 'string', description: '"lat,lng"' }, destination: { type: 'string', description: '"lat,lng"' }, realtime: { type: 'boolean', description: '驾车是否启用实时路况避堵' } }, required: ['origin', 'destination'] },
  },
  {
    name: 'weather',
    description: '查询指定行政区或坐标的实时天气与 5 日预报，用于出行建议。',
    inputSchema: { type: 'object', properties: { district: { type: 'string', description: '行政区划编码或区县名（可选）' }, lng: { type: 'number' }, lat: { type: 'number' } } },
  },
  {
    name: 'scenic_recommend',
    description: '出行休闲景点 / 公园推荐，按距离排序。适合「遛弯、打卡、遛娃」场景。',
    inputSchema: { type: 'object', properties: { lng: { type: 'number' }, lat: { type: 'number' }, radius: { type: 'number', description: '默认 3000 米' }, tags: { type: 'string', description: '逗号分隔，默认「公园,景点,博物馆,广场」' } }, required: ['lng', 'lat'] },
  },
];

/* ------------------------------ Impl ------------------------------ */
const IMPL = {
  async geocode({ address, city = '' }) {
    const raw = await api('/geocoding/v3/', { address, city });
    const r = raw.result || {};
    const l = r.location || {};
    return { address, lng: Number(l.lng), lat: Number(l.lat), precision: r.precise === 1, confidence: r.confidence || 0, level: r.level || '' };
  },

  async reverse_geocode({ lng, lat }) {
    const raw = await api('/reverse_geocoding/v3/', { location: LL(lat, lng), coordtype: 'bd09ll', extensions_poi: 1 });
    const r = raw.result || {};
    const ad = r.addressComponent || {};
    return { formatted: r.formatted_address || '', province: ad.province || '', city: ad.city || '', district: ad.district || '', street: ad.street || '', adcode: ad.adcode || '', business: r.business || '', nearbyPoi: (r.pois && r.pois[0] && r.pois[0].name) || '', lng, lat };
  },

  async poi_search({ query, lng, lat, radius = 1200, pageSize = 20 }) {
    const raw = await api('/place/v2/search', { query, location: LL(lat, lng), radius, page_size: pageSize, page_num: 0, scope: 2 });
    const items = (raw.results || []).map((x) => {
      const l = x.location || {};
      const d = x.detail_info || {};
      return { uid: x.uid || '', name: x.name || '', address: x.address || '', lng: Number(l.lng), lat: Number(l.lat), distance: d.distance !== undefined ? Number(d.distance) : null, tag: d.tag || '', type: d.type || '', telephone: (x.telephone || '').replace(/^"/, ''), rating: d.overall_rating || null };
    });
    return { total: raw.total || items.length, radius, items };
  },

  async route_plan({ mode = 'walking', origin, destination, realtime = false }) {
    const pathname = { walking: '/directionlite/v1/walking', riding: '/directionlite/v1/riding', driving: '/directionlite/v1/driving', transit: '/directionlite/v1/transit' }[mode] || '/directionlite/v1/walking';
    const params = { origin, destination };
    if (mode === 'driving') { params.tactics = realtime ? 11 : 0; params.ret_coordtype = 'bd09ll'; }
    const raw = await api(pathname, params);
    const r = raw.result || {};
    const first = (r.routes || [])[0] || {};
    const steps = (first.steps || []).map((s) => ({ instruction: s.instruction || '', distance: Number(s.distance || 0), duration: Number(s.duration || 0), path: s.path || '' }));
    return { mode, distance: Number(first.distance || 0), duration: Number(first.duration || 0), trafficLight: Number(first.traffic_light || 0), congestion: first.congestion || '', steps, polyline: steps.map((s) => s.path).filter(Boolean).join(';'), alternatives: (r.routes || []).slice(1, 4).map((x) => ({ distance: Number(x.distance || 0), duration: Number(x.duration || 0) })) };
  },

  async weather({ district = '', lng, lat }) {
    const params = { data_type: 'all' };
    if (district) params.district_id = district;
    else if (lng !== undefined) params.location = LL(lat, lng);
    const raw = await api('/weather/v1/', params);
    const r = raw.result || {};
    const now = r.now || {};
    return { city: (r.location && r.location.city) || '', temperature: now.temp, feelsLike: now.feels_like, text: now.text || '', windDir: now.wind_dir || '', windClass: now.wind_class || '', humidity: now.rh, aqi: now.aqi, pm25: now.pm25, tips: (r.index && r.index[0] && r.index[0].des) || '', forecast: (r.forecasts || []).slice(0, 5).map((f) => ({ date: f.date, high: f.high, low: f.low, textDay: f.text_day, textNight: f.text_night })) };
  },

  async scenic_recommend({ lng, lat, radius = 3000, tags = '公园,景点,博物馆,广场' }) {
    const list = String(tags).split(',').map((s) => s.trim()).filter(Boolean).slice(0, 4);
    const results = await Promise.all(list.map((t) => this.poi_search({ query: t, lng, lat, radius, pageSize: 5 }).catch(() => ({ items: [] }))));
    const merged = [];
    const seen = new Set();
    results.forEach((r, i) => (r.items || []).forEach((it) => { if (!seen.has(it.uid)) { seen.add(it.uid); merged.push({ ...it, tag: list[i] }); } }));
    merged.sort((a, b) => (a.distance || 9e9) - (b.distance || 9e9));
    return { total: merged.length, radius, items: merged.slice(0, 12) };
  },
};

/* ------------------------------ Server ------------------------------ */
const SERVER_INFO = { name: 'lh-baidu-map', version: '1.0.0' };
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const replyOK = (id, data) => send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data) }] } });
const replyErr = (id, e) => send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: e.message || String(e) }) }] } });

readline.createInterface({ input: process.stdin, terminal: false }).on('line', async (line) => {
  const s = line.trim();
  if (!s) return;
  let msg;
  try { msg = JSON.parse(s); } catch (_) { return; }
  const { id, method, params } = msg;

  if (method === 'initialize') return send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO } });
  if (method === 'notifications/initialized' || method === 'initialized') return;
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  if (method === 'tools/call') {
    const name = params && params.name;
    const fn = IMPL[name];
    if (!fn) return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `未知工具: ${name}` } });
    try { return replyOK(id, await fn.call(IMPL, (params && params.arguments) || {})); } catch (e) { return replyErr(id, e); }
  }
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `未实现的方法: ${method}` } });
});
