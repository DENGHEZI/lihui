#!/usr/bin/env node
/**
 * 鲤慧 LiHui · MCP Server: ip-anchor（内置版）
 * 工具：locate — 自动锚定用户 IP
 * 传输：stdio，换行分隔 JSON-RPC 2.0
 *
 * 可直接被任意 MCP 客户端挂载：
 *   { "command": "node", "args": ["src/mcp/servers/ip-anchor.js"] }
 */
const readline = require('readline');

const BAIDU_AK = process.env.BAIDU_AK || '';

const TOOLS = [
  {
    name: 'locate',
    description: '自动锚定用户 IP 地址，返回所在城市、区县、经纬度与运营商。老年人与青年人均适用，无需参数。',
    inputSchema: {
      type: 'object',
      properties: {
        ip: { type: 'string', description: '可选。不传则按调用方 IP 自动识别。' },
        fallbackCity: { type: 'string', description: '可选。接口不可用时的兜底城市，默认 长沙市。' },
      },
    },
  },
];

const FALLBACK = [
  { city: '长沙市', province: '湖南省', lng: 112.938814, lat: 28.228209 },
  { city: '北京市', province: '北京市', lng: 116.404269, lat: 39.915119 },
  { city: '上海市', province: '上海市', lng: 121.473662, lat: 31.231732 },
  { city: '广州市', province: '广东省', lng: 113.264435, lat: 23.129163 },
  { city: '深圳市', province: '广东省', lng: 114.057868, lat: 22.543099 },
];

function fetchJSON(url) {
  const http = require('http');
  const https = require('https');
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    lib
      .get(url, { timeout: 8000 }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject)
      .on('timeout', function () {
        this.destroy(new Error('timeout'));
      });
  });
}

async function locate({ ip = '', fallbackCity = '长沙市' } = {}) {
  if (BAIDU_AK) {
    try {
      const url = `https://api.map.baidu.com/location/ip?ak=${encodeURIComponent(BAIDU_AK)}&ip=${encodeURIComponent(ip)}&coor=bd09ll`;
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
        };
      }
    } catch (_) {
      /* 降级 */
    }
  }
  const hit = FALLBACK.find((c) => c.city.includes(fallbackCity)) || FALLBACK[0];
  return { ip, city: hit.city, province: hit.province, district: '', isp: '', point: { lng: hit.lng, lat: hit.lat }, confidence: 0.3, source: 'fallback' };
}

/* ---------------- JSON-RPC 循环 ---------------- */
const SERVER_INFO = { name: 'lh-ip-anchor', version: '1.0.0' };

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}
function replyErr(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', async (line) => {
  const s = line.trim();
  if (!s) return;
  let msg;
  try {
    msg = JSON.parse(s);
  } catch (_) {
    return;
  }
  const { id, method, params } = msg;

  if (method === 'initialize') {
    return reply(id, { protocolVersion: '2024-11-05', capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO });
  }
  if (method === 'notifications/initialized' || method === 'initialized') return;
  if (method === 'tools/list') return reply(id, { tools: TOOLS });
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    if (name !== 'locate') return replyErr(id, -32601, `未知工具: ${name}`);
    try {
      const result = await locate(args);
      return reply(id, { content: [{ type: 'text', text: JSON.stringify(result) }] });
    } catch (e) {
      return reply(id, { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: e.message }) }] });
    }
  }
  if (id !== undefined) replyErr(id, -32601, `未实现的方法: ${method}`);
});
