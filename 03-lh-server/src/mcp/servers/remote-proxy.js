#!/usr/bin/env node
/**
 * 鲤慧 LiHui · MCP 远程代理（stdio ⇄ HTTP/SSE）
 * 用途：把「HTTP/SSE 类型的 MCP Server」包装成 stdio 形态，
 *      让 03-lh-server 的 MCP Hub 能像调用本地进程一样调用它。
 * 环境变量：MCP_REMOTE_URL、MCP_REMOTE_TOKEN（可选）
 */
const readline = require('readline');
const http = require('http');
const https = require('https');

const REMOTE = process.env.MCP_REMOTE_URL || '';
const TOKEN = process.env.MCP_REMOTE_TOKEN || '';

function post(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const payload = JSON.stringify(body);
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'Content-Length': Buffer.byteLength(payload),
          ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
        },
        timeout: 60000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          // SSE 形态：取 data: 行
          const m = text.match(/^data:\s*(.+)$/m);
          const payloadText = m ? m[1] : text;
          try {
            resolve(JSON.parse(payloadText));
          } catch (e) {
            reject(new Error('remote mcp 返回无法解析: ' + text.slice(0, 200)));
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', function () {
      this.destroy(new Error('remote mcp timeout'));
    });
    req.write(payload);
    req.end();
  });
}

function out(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

readline.createInterface({ input: process.stdin, terminal: false }).on('line', async (line) => {
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
    return out({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'lh-remote-proxy', version: '1.0.0' } } });
  }
  if (method === 'notifications/initialized' || method === 'initialized') return;
  if (method === 'ping') return out({ jsonrpc: '2.0', id, result: {} });

  if (!REMOTE) {
    if (id !== undefined) out({ jsonrpc: '2.0', id, error: { code: -32000, message: '未配置 MCP_REMOTE_URL' } });
    return;
  }

  try {
    const res = await post(REMOTE, { jsonrpc: '2.0', id, method, params });
    out(res && res.error ? { jsonrpc: '2.0', id, error: res.error } : { jsonrpc: '2.0', id, result: (res && res.result) || res });
  } catch (e) {
    if (id !== undefined) out({ jsonrpc: '2.0', id, error: { code: -32000, message: e.message } });
  }
});
