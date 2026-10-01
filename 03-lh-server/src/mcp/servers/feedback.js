#!/usr/bin/env node
/**
 * 鲤慧 LiHui · MCP Server: feedback（内置版）
 * 工具：submit（提交反馈）、list_pending（管理端拉取待处理）、handle（管理端处理）
 * 数据落 03-lh-server/data/feedback.json（与 HTTP /api/v1/feedback 同源）
 */
const readline = require('readline');
const fs = require('fs');
const path = require('path');

// 本文件位于 03-lh-server/src/mcp/servers/  →  数据目录 ../../../data
const DATA_DIR = process.env.LH_DATA_DIR || path.resolve(__dirname, '..', '..', '..', 'data');
const FILE = path.join(DATA_DIR, 'feedback.json');

function readAll() {
  try {
    if (!fs.existsSync(FILE)) return [];
    const t = fs.readFileSync(FILE, 'utf8').trim();
    return t ? JSON.parse(t) : [];
  } catch (_) {
    return [];
  }
}
function writeAll(list) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(list, null, 2), 'utf8');
    return true;
  } catch (_) {
    return false;
  }
}
const uid = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

const TOOLS = [
  {
    name: 'submit',
    description: '提交用户反馈（问题/建议/投诉/表扬），直接同步到管理端待处理列表。',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['bug', 'feature', 'complaint', 'praise'], description: '反馈类型' },
        content: { type: 'string', description: '反馈内容' },
        contact: { type: 'string', description: '联系方式（可选）' },
        deviceId: { type: 'string', description: '设备标识（可选）' },
        page: { type: 'string', description: '来源页面（可选）' },
      },
      required: ['content'],
    },
  },
  {
    name: 'list_pending',
    description: '管理端拉取待处理反馈列表。',
    inputSchema: { type: 'object', properties: { status: { type: 'string', description: 'pending/processing/resolved/rejected，默认 pending' }, limit: { type: 'number', description: '返回条数，默认 20' } } },
  },
  {
    name: 'handle',
    description: '管理端处理反馈：标记状态并回复用户。',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string' }, reply: { type: 'string' } }, required: ['id'] },
  },
];

function submit(args) {
  if (!args.content) throw new Error('content 必填');
  const list = readAll();
  const item = {
    id: uid('fb'),
    type: ['bug', 'feature', 'complaint', 'praise'].includes(args.type) ? args.type : 'bug',
    content: String(args.content).slice(0, 2000),
    contact: args.contact || '',
    deviceId: args.deviceId || 'anonymous',
    page: args.page || '',
    status: 'pending',
    reply: '',
    createdAt: new Date().toISOString(),
  };
  list.push(item);
  writeAll(list);
  return { ok: true, id: item.id, status: item.status, createdAt: item.createdAt, total: list.length };
}

function listPending(args = {}) {
  const status = args.status || 'pending';
  const limit = Number(args.limit) || 20;
  const list = readAll().filter((x) => x.status === status).slice(-limit).reverse();
  return { status, count: list.length, items: list };
}

function handle(args = {}) {
  const list = readAll();
  const i = list.findIndex((x) => x.id === args.id);
  if (i < 0) throw new Error('反馈不存在');
  list[i].status = ['pending', 'processing', 'resolved', 'rejected'].includes(args.status) ? args.status : 'processing';
  if (args.reply !== undefined) list[i].reply = args.reply;
  list[i].handledAt = new Date().toISOString();
  writeAll(list);
  return { ok: true, item: list[i] };
}

const HANDLERS = { submit, list_pending: listPending, handle };
const SERVER_INFO = { name: 'lh-feedback', version: '1.0.0' };

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}
function replyErr(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
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
  if (method === 'initialize') return reply(id, { protocolVersion: '2024-11-05', capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO });
  if (method === 'notifications/initialized' || method === 'initialized') return;
  if (method === 'tools/list') return reply(id, { tools: TOOLS });
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/call') {
    const name = params && params.name;
    const fn = HANDLERS[name];
    if (!fn) return replyErr(id, -32601, `未知工具: ${name}`);
    try {
      return reply(id, { content: [{ type: 'text', text: JSON.stringify(fn((params && params.arguments) || {})) }] });
    } catch (e) {
      return reply(id, { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: e.message }) }] });
    }
  }
  if (id !== undefined) replyErr(id, -32601, `未实现的方法: ${method}`);
});
