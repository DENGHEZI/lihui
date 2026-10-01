#!/usr/bin/env node
/**
 * 鲤慧 LiHui · MCP Server: feedback
 * 用户反馈闭环 —— 端上提交 → 管理端处理 → 结果回传
 * 数据落盘：环境变量 LH_DATA_DIR 指定目录（默认本目录 ./data/feedback.json）
 * 工具：submit / list_pending / handle / summary
 */
const readline = require('readline');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.LH_DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'feedback.json');
const uid = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

function readAll() {
  try {
    if (!fs.existsSync(FILE)) return [];
    const t = fs.readFileSync(FILE, 'utf8').trim();
    return t ? JSON.parse(t) : [];
  } catch (_) { return []; }
}
function writeAll(list) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2), 'utf8');
  return true;
}

const AUTO_CLASSIFY = [
  { re: /闪退|崩溃|报错|打不开|白屏|卡死/, type: 'bug' },
  { re: /希望|建议|能不能加|期待/, type: 'feature' },
  { re: /投诉|态度差|乱收费|骗/, type: 'complaint' },
  { re: /好用|感谢|点赞|很棒/, type: 'praise' },
];

function submit(args = {}) {
  if (!args.content) throw new Error('content 必填');
  const guess = (AUTO_CLASSIFY.find((x) => x.re.test(args.content)) || {}).type || 'bug';
  const list = readAll();
  const item = {
    id: uid('fb'),
    type: ['bug', 'feature', 'complaint', 'praise'].includes(args.type) ? args.type : guess,
    content: String(args.content).slice(0, 2000),
    contact: args.contact || '',
    deviceId: args.deviceId || 'anonymous',
    page: args.page || '',
    platform: args.platform || '',
    appVersion: args.appVersion || '',
    screenshots: Array.isArray(args.screenshots) ? args.screenshots.slice(0, 6) : [],
    status: 'pending',
    reply: '',
    createdAt: new Date().toISOString(),
  };
  list.push(item);
  writeAll(list);
  return { ok: true, id: item.id, autoClassified: item.type, status: item.status, estimatedReply: '我们会在 24 小时内处理并回复您。' };
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

function summary() {
  const all = readAll();
  const by = (k) => all.reduce((a, b) => ((a[b[k]] = (a[b[k]] || 0) + 1), a), {});
  return { total: all.length, byStatus: by('status'), byType: by('type'), recent: all.slice(-5).reverse() };
}

const TOOLS = [
  { name: 'submit', description: '提交用户反馈，自动按内容分类（bug/feature/complaint/praise）并进入管理端待处理队列。', inputSchema: { type: 'object', properties: { content: { type: 'string' }, type: { type: 'string', enum: ['bug', 'feature', 'complaint', 'praise'] }, contact: { type: 'string' }, deviceId: { type: 'string' }, page: { type: 'string' }, platform: { type: 'string' } }, required: ['content'] } },
  { name: 'list_pending', description: '管理端拉取待处理反馈列表。', inputSchema: { type: 'object', properties: { status: { type: 'string' }, limit: { type: 'number' } } } },
  { name: 'handle', description: '管理端处理反馈：更新状态并填写回复。', inputSchema: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string' }, reply: { type: 'string' } }, required: ['id'] } },
  { name: 'summary', description: '反馈看板：总数、按状态/类型分布与最近 5 条。', inputSchema: { type: 'object', properties: {} } },
];

const IMPL = { submit, list_pending: listPending, handle, summary };
const SERVER_INFO = { name: 'lh-feedback', version: '1.0.0' };
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');

readline.createInterface({ input: process.stdin, terminal: false }).on('line', (line) => {
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
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(fn((params && params.arguments) || {})) }] } });
    } catch (e) {
      return send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: e.message }) }] } });
    }
  }
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `未实现的方法: ${method}` } });
});
