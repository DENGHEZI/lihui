#!/usr/bin/env node
/**
 * 鲤慧 LiHui · MCP Server: ip-anchor
 * IP 自动锚定 —— 由 IP 反查城市/坐标/运营商，作为 GPS 不可用时的兜底定位
 * 工具：locate / batch_locate
 */
const readline = require('readline');
const http = require('http');
const https = require('https');

const AK = process.env.BAIDU_AK || '<你的百度AK>';
const BASE = process.env.BAIDU_MAP_BASE || 'https://api.map.baidu.com';

const FALLBACK = [
  { city: '长沙市', province: '湖南省', lng: 112.938814, lat: 28.228209, isp: '' },
  { city: '北京市', province: '北京市', lng: 116.404269, lat: 39.915119, isp: '' },
  { city: '上海市', province: '上海市', lng: 121.473662, lat: 31.231732, isp: '' },
  { city: '广州市', province: '广东省', lng: 113.264435, lat: 23.129163, isp: '' },
  { city: '深圳市', province: '广东省', lng: 114.057868, lat: 22.543099, isp: '' },
  { city: '成都市', province: '四川省', lng: 104.066301, lat: 30.572961, isp: '' },
  { city: '杭州市', province: '浙江省', lng: 120.15507, lat: 30.274085, isp: '' },
  { city: '武汉市', province: '湖北省', lng: 114.298572, lat: 30.584355, isp: '' },
];

function fetchJSON(url, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    lib.get(url, { timeout }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(new Error('响应解析失败')); } });
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('请求超时')); });
  });
}

const isPrivate = (ip) => !ip || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1|localhost)/.test(ip);

async function locate({ ip = '', fallbackCity = '长沙市' } = {}) {
  const queryIp = isPrivate(ip) ? '' : ip;
  try {
    const url = `${BASE}/location/ip?ak=${encodeURIComponent(AK)}&ip=${encodeURIComponent(queryIp)}&coor=bd09ll`;
    const raw = await fetchJSON(url);
    if (raw && raw.status === 0 && raw.content) {
      const c = raw.content;
      const ad = c.address_detail || {};
      const p = c.point || {};
      return {
        ip: c.ip || ip,
        city: c.address || '',
        province: ad.province || '',
        district: ad.district || '',
        isp: ad.isp || '',
        point: p.x !== undefined ? { lng: Number(p.x), lat: Number(p.y) } : null,
        confidence: p.x !== undefined ? 0.75 : 0.35,
        source: 'baidu-ip',
        private: isPrivate(ip),
      };
    }
  } catch (_) { /* 降级 */ }
  const hit = FALLBACK.find((c) => c.city.includes(fallbackCity)) || FALLBACK[0];
  return { ip, city: hit.city, province: hit.province, district: '', isp: '', point: { lng: hit.lng, lat: hit.lat }, confidence: 0.3, source: 'fallback', private: isPrivate(ip) };
}

const TOOLS = [
  { name: 'locate', description: '根据 IP 自动锚定用户位置，返回城市、区县、经纬度、运营商与可信度。IP 为内网地址时自动改用调用方公网 IP 或兜底城市。', inputSchema: { type: 'object', properties: { ip: { type: 'string', description: '可选，不传则由百度按请求来源判断' }, fallbackCity: { type: 'string', description: '可选，接口不可用时的兜底城市' } } } },
  { name: 'batch_locate', description: '批量锚定多个 IP，用于多用户场景的设备分布统计。', inputSchema: { type: 'object', properties: { ips: { type: 'array', items: { type: 'string' }, description: 'IP 列表（最多 20 个）' } }, required: ['ips'] } },
];

const IMPL = {
  locate,
  async batch_locate({ ips = [] }) {
    const list = ips.slice(0, 20);
    const results = [];
    for (const ip of list) results.push(await locate({ ip }));
    const byCity = results.reduce((a, b) => ((a[b.city || '未知'] = (a[b.city || '未知'] || 0) + 1), a), {});
    return { count: results.length, byCity, results };
  },
};

const SERVER_INFO = { name: 'lh-ip-anchor', version: '1.0.0' };
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');

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
    try {
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(await fn((params && params.arguments) || {})) }] } });
    } catch (e) {
      return send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: e.message }) }] } });
    }
  }
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `未实现的方法: ${method}` } });
});
