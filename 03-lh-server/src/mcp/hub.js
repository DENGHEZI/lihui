/**
 * 鲤慧 LiHui · MCP Hub
 *  - MCP Server 注册表（data/mcp.json）
 *  - 生命周期：启动 / 停止 / 重启 / 健康检查
 *  - ModelScope MCP 广场检索与安装（含离线内置目录兜底）
 *  - 工具聚合：listTools() / callTool()
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');
const store = require('../services/store');
const { McpClient } = require('./client');
const logger = require('../utils/logger');
const { fetchJSON } = require('../utils/http');

const col = store.collection('mcp', []);

/* ---------------- 默认注册表：指向 04-lh-mcp-servers ---------------- */
const MCP_BASE = config.mcp.dir;

function dirOf(id) {
  const builtinIds = ['ip-anchor', 'feedback'];
  const inBuiltin = fs.existsSync(path.join(config.mcp.builtinDir, `${id}.js`));
  if (inBuiltin || builtinIds.includes(id)) return path.join(config.mcp.builtinDir, `${id}.js`);
  return path.join(MCP_BASE, id, 'index.js');
}

const DEFAULT_SERVERS = [
  { id: 'baidu-map', name: '百度地图能力', plan: 'free', enabled: true, desc: '地理编码/逆地理/周边搜索/路线规划/天气/景点推荐' },
  { id: 'ip-anchor', name: 'IP 自动锚定', plan: 'free', enabled: true, desc: '客户端 IP → 城市/坐标/运营商' },
  { id: 'life-circle', name: '15 分钟生活圈体检', plan: 'free', enabled: true, desc: '6 类设施覆盖度打分 + 短板与补齐建议' },
  { id: 'voice', name: '自定义语音', plan: 'free', enabled: true, desc: 'TTS 合成 / ASR 识别 / 音色定制' },
  { id: 'feedback', name: '用户反馈', plan: 'free', enabled: true, desc: '反馈提交与管理端处理' },
  { id: 'cost-optimizer', name: '智能成本优化', plan: 'pro', enabled: true, desc: '出行/采购方案省钱重排 + 优惠推送' },
  { id: 'desktop-action', name: '桌面应用操作', plan: 'pro', enabled: true, desc: '唤起外部应用 / 桌面应用自动化脚本' },
  { id: 'emotion', name: '情感疏通', plan: 'pro', enabled: true, desc: '情绪识别与共情陪伴' },
];

function seed() {
  const list = col.all();
  if (!list.length) {
    col.save(
      DEFAULT_SERVERS.map((s) => ({
        ...s,
        transport: 'stdio',
        command: process.execPath,
        args: [dirOf(s.id)],
        env: { BAIDU_AK: config.baidu.ak },
        source: 'builtin',
        tools: [],
      }))
    );
    return;
  }
  // 补齐 + 修正 args（路径随目录变动）
  let changed = false;
  const ids = new Set(list.map((x) => x.id));
  for (const s of DEFAULT_SERVERS) {
    if (!ids.has(s.id)) {
      list.push({ ...s, transport: 'stdio', command: process.execPath, args: [dirOf(s.id)], env: { BAIDU_AK: config.baidu.ak }, source: 'builtin', tools: [] });
      changed = true;
    }
  }
  for (const x of list) {
    if (x.source === 'builtin') {
      const want = dirOf(x.id);
      if (!x.args || x.args[0] !== want) {
        x.args = [want];
        x.command = process.execPath;
        changed = true;
      }
    }
  }
  if (changed) col.save(list);
}
seed();

/* ---------------- 运行时实例 ---------------- */
const clients = new Map(); // id -> McpClient

function buildClient(rec) {
  // 防御:注册表里的解释器路径可能随运行时升级失效(如 WorkBuddy 升级 managed node
  // 目录 22.22.2-3 → 22.22.2-6),失效时回退当前 node,避免 8 个 MCP 全挂
  let command = rec.command;
  if (command && !fs.existsSync(command)) {
    logger.warn('mcpHub', `注册的解释器已失效(${command}),回退当前 node`);
    command = process.execPath;
  }
  return new McpClient({
    id: rec.id,
    name: rec.name,
    command,
    args: rec.args,
    env: { ...(rec.env || {}), BAIDU_AK: config.baidu.ak },
    cwd: config.root,
  });
}

async function startOne(id) {
  const rec = col.find((x) => x.id === id);
  if (!rec) throw new Error(`MCP Server 不存在: ${id}`);
  if (!rec.enabled) throw new Error(`MCP Server 已禁用: ${id}`);
  if (clients.get(id) && clients.get(id).status === 'running') return clients.get(id);
  const c = buildClient(rec);
  clients.set(id, c);
  await c.start();
  col.update(id, { tools: c.tools.map((t) => t.name) });
  return c;
}

async function stopOne(id) {
  const c = clients.get(id);
  if (c) {
    await c.stop();
    clients.delete(id);
  }
  return true;
}

async function restartOne(id) {
  await stopOne(id);
  return startOne(id);
}

async function startEnabled(plan = 'pro') {
  const recs = col.all().filter((x) => x.enabled && allowed(x, plan));
  const results = await Promise.allSettled(recs.map((r) => startOne(r.id)));
  results.forEach((r, i) => {
    if (r.status === 'rejected') logger.warn('mcpHub', `${recs[i].id} start failed: ${r.reason && r.reason.message}`);
  });
  return listSummary();
}

function allowed(rec, plan) {
  if (!rec.plan || rec.plan === 'free') return true;
  return plan === 'pro';
}

/* ---------------- 查询 ---------------- */
function list() {
  return col.all().map((rec) => {
    const c = clients.get(rec.id);
    return {
      id: rec.id,
      name: rec.name,
      desc: rec.desc || '',
      plan: rec.plan || 'free',
      enabled: !!rec.enabled,
      source: rec.source || 'builtin',
      transport: rec.transport || 'stdio',
      packageRef: rec.packageRef || '',
      envKeys: Object.keys(rec.env || {}),
      status: c ? c.status : 'stopped',
      error: c ? c.error : '',
      tools: c && c.tools.length ? c.tools.map((t) => t.name) : rec.tools || [],
    };
  });
}

function listSummary() {
  const l = list();
  return {
    total: l.length,
    running: l.filter((x) => x.status === 'running').length,
    servers: l,
  };
}

/** 聚合所有在跑 Server 的工具（供 Agent 做 function-calling） */
function listTools(plan = 'pro') {
  const out = [];
  for (const rec of col.all()) {
    if (!rec.enabled || !allowed(rec, plan)) continue;
    const c = clients.get(rec.id);
    if (!c || c.status !== 'running') continue;
    for (const t of c.tools) {
      out.push({
        serverId: rec.id,
        serverName: rec.name,
        name: t.name,
        description: t.description || '',
        inputSchema: t.inputSchema || { type: 'object', properties: {} },
      });
    }
  }
  return out;
}

/** 转成 OpenAI function-calling 的 tools 结构 */
function toOpenAITools(plan = 'pro') {
  return listTools(plan).map((t) => ({
    type: 'function',
    function: {
      name: `${t.serverId}__${t.name}`.replace(/[^a-zA-Z0-9_]/g, '_'),
      description: `[${t.serverName}] ${t.description}`,
      parameters: t.inputSchema || { type: 'object', properties: {} },
    },
  }));
}

/** 调用工具：toolName 形如 "serverId__tool" 或 {serverId, tool} */
async function callTool(serverId, tool, args = {}) {
  const rec = col.find((x) => x.id === serverId);
  if (!rec) {
    const e = new Error(`MCP Server 不存在: ${serverId}`);
    e.code = 4002;
    throw e;
  }
  if (!rec.enabled) {
    const e = new Error(`MCP Server 未启用: ${serverId}，请先 POST /api/v1/mcp/toggle 开启`);
    e.code = 4001;
    throw e;
  }
  let c = clients.get(serverId);
  if (!c || c.status !== 'running') c = await startOne(serverId);
  const isKnown = c.tools.some((t) => t.name === tool);
  if (!isKnown) {
    const e = new Error(`MCP 工具不存在: ${serverId}.${tool}（可用：${c.tools.map((t) => t.name).join(', ')}）`);
    e.code = 4002;
    throw e;
  }
  const t0 = Date.now();
  const res = await c.call(tool, args);
  return { ...res, serverId, tool, ms: Date.now() - t0 };
}

async function callByQualifiedName(qualified, args = {}) {
  const [serverId, tool] = String(qualified).split('__');
  // 工具名进入 OpenAI function-calling 时连字符被清洗为下划线（如 ip-anchor → ip_anchor），
  // 回查服务时先按原 id 找，找不到再尝试「下划线还原为连字符」，否则带连字符的
  // 服务（ip-anchor / life-circle / cost-optimizer / desktop-action…）永远 4002
  if (!col.find((x) => x.id === serverId)) {
    const alt = serverId.replace(/_/g, '-');
    if (col.find((x) => x.id === alt)) return callTool(alt, tool, args);
  }
  return callTool(serverId, tool, args);
}

/* ---------------- 启停 / 增删 ---------------- */
async function toggle(id, enabled) {
  const rec = col.update(id, { enabled: !!enabled });
  if (!rec) {
    const e = new Error('MCP Server 不存在');
    e.code = 4002;
    throw e;
  }
  if (enabled) await startOne(id).catch((e) => logger.warn('mcpHub', e.message));
  else await stopOne(id);
  return list().find((x) => x.id === id);
}

async function install(payload) {
  const { id, installType = 'npx', installRef = '', env = {}, autoStart = true, name = '', plan = 'pro', desc = '' } = payload || {};
  if (!id || !installRef) {
    const e = new Error('id 与 installRef 必填');
    e.code = 1001;
    throw e;
  }
  let command = process.execPath;
  let args = [];
  if (installType === 'npx') {
    command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    args = ['-y', installRef];
  } else if (installType === 'uvx') {
    command = 'uvx';
    args = [installRef];
  } else if (installType === 'node') {
    args = [installRef];
  } else if (installType === 'http' || installType === 'sse') {
    // 远程 MCP：本服务暂以 stdio 为主，登记为 remote 供参考
    command = process.execPath;
    args = [path.join(config.mcp.builtinDir, 'remote-proxy.js')];
    env.MCP_REMOTE_URL = installRef;
  }

  const existing = col.find((x) => x.id === id);
  const rec = existing
    ? col.update(id, { name: name || existing.name, command, args, env, enabled: true, source: 'modelscope', packageRef: installRef, plan, desc })
    : col.add({ id, name: name || id, command, args, env, transport: 'stdio', enabled: true, source: 'modelscope', packageRef: installRef, plan, desc, tools: [] });

  if (autoStart) {
    try {
      await startOne(id);
    } catch (e) {
      logger.warn('mcpHub', `install ${id} but start failed: ${e.message}`);
      col.update(id, { enabled: false });
      return { installed: true, started: false, error: e.message, server: list().find((x) => x.id === id) };
    }
  }
  return { installed: true, started: !!autoStart, server: list().find((x) => x.id === rec.id) };
}

function remove(id) {
  stopOne(id);
  col.remove(id);
  return true;
}

/* ---------------- ModelScope MCP 广场 ---------------- */
const MS_ENDPOINTS = [
  'https://modelscope.cn/api/v1/mcp/servers',
  'https://modelscope.cn/api/v1/dolphin/mcp/servers',
];

/** 内置精选目录（ModelScope 不可达时的可用兜底 + 常见 MCP 参考） */
const CURATED = [
  { id: 'modelscope/baidu-maps-mcp', name: '百度地图 MCP Server', stars: 860, description: '地理编码、逆地理编码、地点检索、路线规划、天气查询（百度官方 MCP）', installType: 'npx', installRef: '@baidu/mcp-server-maps', license: 'MIT' },
  { id: 'modelscope/amap-maps', name: '高德地图 MCP Server', stars: 1420, description: '高德开放平台官方 MCP，提供 POI 搜索、路径规划、天气', installType: 'npx', installRef: '@amap/amap-maps-mcp-server', license: 'MIT' },
  { id: 'modelscope/mcp-server-fetch', name: 'Fetch MCP Server', stars: 3100, description: '抓取网页并转 Markdown，供 Agent 读取在线信息', installType: 'uvx', installRef: 'mcp-server-fetch', license: 'MIT' },
  { id: 'modelscope/mcp-server-filesystem', name: 'Filesystem MCP Server', stars: 2900, description: '安全受限的本地文件读写', installType: 'npx', installRef: '@modelcontextprotocol/server-filesystem', license: 'MIT' },
  { id: 'modelscope/mcp-server-memory', name: 'Memory MCP Server', stars: 1800, description: '基于知识图谱的长期记忆', installType: 'npx', installRef: '@modelcontextprotocol/server-memory', license: 'MIT' },
  { id: 'modelscope/mcp-server-sequential-thinking', name: 'Sequential Thinking', stars: 2100, description: '结构化多步推理', installType: 'npx', installRef: '@modelcontextprotocol/server-sequential-thinking', license: 'MIT' },
  { id: 'modelscope/mcp-server-weather', name: 'Weather MCP Server', stars: 640, description: '全球天气查询', installType: 'npx', installRef: 'mcp-server-weather', license: 'MIT' },
  { id: 'modelscope/mcp-server-sqlite', name: 'SQLite MCP Server', stars: 980, description: 'SQLite 数据库查询与写入', installType: 'uvx', installRef: 'mcp-server-sqlite', license: 'MIT' },
];

async function searchRegistry(keyword = '', { page = 1, pageSize = 20 } = {}) {
  const kw = String(keyword || '').toLowerCase();
  for (const ep of MS_ENDPOINTS) {
    for (const attempt of [
      () => fetchJSON(`${ep}?pageNumber=${page}&pageSize=${pageSize}&search=${encodeURIComponent(kw)}`, { timeout: 8000 }),
      () => fetchJSON(`${ep}?page=${page}&perPage=${pageSize}&keyword=${encodeURIComponent(kw)}`, { timeout: 8000 }),
    ]) {
      try {
        const raw = await attempt();
        const arr = extractArray(raw);
        if (arr.length) {
          return { source: 'modelscope', keyword, items: arr.map(normalizeMs) };
        }
      } catch (e) {
        logger.debug('mcpHub', `modelscope ${ep} failed: ${e.message}`);
      }
    }
  }
  // 兜底：内置精选
  const items = CURATED.filter(
    (x) => !kw || x.name.toLowerCase().includes(kw) || x.description.toLowerCase().includes(kw) || x.id.toLowerCase().includes(kw)
  );
  return { source: 'builtin-catalog', keyword, items, hint: 'ModelScope 暂不可达（或未开放公开检索），已返回内置精选目录；可直接安装。' };
}

function extractArray(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  const cands = [raw.data, raw.Data, raw.result, raw.servers, raw.list, raw.data && raw.data.list, raw.data && raw.data.servers];
  for (const c of cands) {
    if (Array.isArray(c)) return c;
  }
  return [];
}

function normalizeMs(x) {
  const id = x.id || x.serverId || x.name || x.slug || '';
  const name = x.name || x.chineseName || x.title || id;
  const description = x.description || x.summary || x.chineseDescription || '';
  const stars = x.stars || x.starCount || x.likes || 0;
  const installRef = x.npmPackage || x.package || x.installRef || x.reference || x.url || '';
  let installType = x.installType || '';
  if (!installType) {
    if (/^https?:\/\//.test(installRef)) installType = 'http';
    else if (/npx|@/.test(installRef)) installType = 'npx';
    else installType = 'npx';
  }
  return { id, name, stars, description, installType, installRef, license: x.license || '' };
}

module.exports = {
  seed,
  list,
  listSummary,
  listTools,
  toOpenAITools,
  startOne,
  stopOne,
  restartOne,
  startEnabled,
  toggle,
  install,
  remove,
  callTool,
  callByQualifiedName,
  searchRegistry,
  CURATED,
};
