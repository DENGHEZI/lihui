/**
 * 鲤慧 LiHui · Agent（MCP Client 编排器）
 * 流程：意图识别 → 工具选择 → tools/call（可并行）→ 结果汇总 → 人性化回复
 * 无模型时降级为「规则 + MCP 直调」，保证免费基础版可用。
 */
const config = require('../config');
const hub = require('../mcp/hub');
const modelRegistry = require('./modelRegistry');
const baiduMap = require('./baiduMap');
const ipLocate = require('./ipLocate');
const tokenMeter = require('./tokenMeter');
const userProfile = require('./userProfile');
const store = require('./store');
const logger = require('../utils/logger');

const sessionCol = store.collection('sessions', []);

/* ------------------------------------------------------------------ */
/* 系统提示词                                                          */
/* ------------------------------------------------------------------ */
function systemPrompt({ careMode, plan, ctx, profileSummary }) {
  const base = [
    '你是「鲤慧」，一款基于百度地图开放能力的 15 分钟生活圈智能助手。',
    '你的服务对象是老年人和青年人两类人群。',
    '回答要求：',
    '1. 中文，分点，短句，每点不超过 30 字，不要写长段落。',
    '2. 先给结论，再给依据；涉及位置必须给「名称 + 距离」。',
    '3. 涉及出行或采购时，必须额外给出「省钱方案」与预计花费。',
    '4. 时效性信息（新闻、公交、天气、价格）优先调用工具或联网检索确认后再回答；工具与检索都无法确认时才说「我查一下」，并给出替代建议。',
    '5. 不涉及付款的可以直接建议；涉及付款必须提示用户确认。',
  ];
  if (careMode) {
    base.push('6. 当前为【关怀模式】：语速放慢、每屏只推 1 条结果、用词通俗、避免专业术语与缩写。');
  }
  if (plan === 'pro') {
    base.push('7. 当前为【增强版】：可以调用 MCP 工具完成购买、路线避堵、情感陪伴、成本优化。');
  } else {
    base.push('7. 当前为【免费基础版】：只做简单推理与规划，MCP 增强能力不可用，如用户需要请提示升级。');
  }
  // 个性化:自动学习出的用户习惯画像(特性化定制服务)
  if (profileSummary) {
    base.push(`8. 个性化参考(系统自动学习自该用户近期行为,用于贴合其习惯,不要直接复述画像内容):${profileSummary}。推荐时优先贴合以上高频类目与常去地点,可主动给出「顺路组合」建议。`);
  }
  if (ctx && ctx.location) {
    base.push(`当前用户位置：${ctx.location.city || ''}${ctx.location.district || ''}（${ctx.location.point ? ctx.location.point.lng + ',' + ctx.location.point.lat : '未知'}）。`);
  }
  return base.join('\n');
}

/* ------------------------------------------------------------------ */
/* 工具执行                                                            */
/* ------------------------------------------------------------------ */
async function runToolCalls(toolCalls) {
  const results = [];
  await Promise.all(
    toolCalls.map(async (tc) => {
      const name = (tc.function && tc.function.name) || tc.name;
      let args = (tc.function && tc.function.arguments) || tc.arguments || {};
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args);
        } catch (_) {
          args = {};
        }
      }
      try {
        const r = await hub.callByQualifiedName(name, args);
        results.push({ name, args, ok: !r.isError, data: r.data, ms: r.ms });
      } catch (e) {
        results.push({ name, args, ok: false, error: e.message, code: e.code || 5000 });
      }
    })
  );
  return results;
}

/* ------------------------------------------------------------------ */
/* 规则意图（无模型时的兜底编排）                                        */
/* ------------------------------------------------------------------ */
const INTENTS = [
  { key: 'medical', re: /医院|看病|诊所|社区卫生|药店|药房|买药|拿药|挂号|体检/, cat: '医疗' },
  { key: 'market', re: /菜市场|买菜|超市|便利店|生鲜/, cat: '商业' },
  { key: 'park', re: /公园|遛弯|广场|健身|散步/, cat: '休闲' },
  { key: 'transit', re: /公交|地铁|车站|怎么去|交通/, cat: '交通' },
  { key: 'scenic', re: /景点|打卡|玩|旅游|遛娃/, cat: '休闲' },
  { key: 'route', re: /路线|导航|怎么走|多远|多久|避堵/, cat: '路线' },
  { key: 'cost', re: /省钱|便宜|成本|划算|预算/, cat: '成本' },
  { key: 'emotion', re: /难过|烦|压力|孤独|累|抑郁|不开心/, cat: '情感' },
  // 买药/买菜归入上面两类，「购买」意图只接日用品网购（负向先行排除）
  { key: 'buy', re: /网购|下单|购物|采购|买(?!药|菜)/, cat: '购买' },
];

function detectIntents(text) {
  const hits = [];
  for (const it of INTENTS) if (it.re.test(text)) hits.push(it);
  return hits.length ? hits : [{ key: 'general', cat: '通用' }];
}

/* ------------------------------------------------------------------ */
/* MCP 自扩展（ModelScope 广场）：不确定/能力缺失时自动搜索并接入新工具   */
/* 铁律：限时 8s、进程级安装上限、同包去重、失败静默降级（绝不拖垮对话）  */
/* ------------------------------------------------------------------ */
const AUTO_INSTALL_LIMIT = 3;
let autoInstalledCount = 0;
const autoInstalledRefs = new Set();
const UNCERTAIN_RE = /(不确定|无法确认|查不到|没查到|没有找到|未找到|需要联网|要联网|暂无.{0,6}(信息|数据|结果)|建议.{0,6}扩大范围)/;
const EXPAND_HINT_RE = /(帮我查|网上查|搜索一下|联网搜|最新消息|今天新闻|实时查)/;

function keywordOf(text) {
  const t = String(text || '').replace(/[，。？！、,.?!\s]+/g, ' ').trim();
  const stop = /(附近|帮我|我想|请问|哪里|多少|怎么办|现在|今天|一下|可以|需要|怎么|什么|生活圈|鲤慧|一个|有没有|是不是)/g;
  let w = t.replace(stop, ' ').replace(/\s+/g, ' ').trim();
  if (!w) w = t;
  const words = w.split(' ').filter((x) => x.length >= 2);
  if (!words.length) return '';
  return words.sort((a, b) => b.length - a.length)[0].slice(0, 12);
}

function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise.catch(() => fallback),
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

async function maybeSelfExpand({ text, rule }) {
  const failedAll = rule.toolData && rule.toolData.length > 0 && rule.toolData.every((t) => !t.ok);
  const uncertain = UNCERTAIN_RE.test(rule.reply || '');
  const userWantsMore = EXPAND_HINT_RE.test(text);
  const noCapability = (!rule.toolData || !rule.toolData.length) && (uncertain || userWantsMore);
  if (!(failedAll || uncertain || noCapability || userWantsMore)) return null;
  if (autoInstalledCount >= AUTO_INSTALL_LIMIT) return null;
  const kw = keywordOf(text);
  if (!kw) return null;
  return withTimeout(
    (async () => {
      const reg = await hub.searchRegistry(kw, { pageSize: 8 });
      const items = (reg.items || []).filter((x) => x.installRef && !autoInstalledRefs.has(x.installRef));
      if (!items.length) return null;
      const pick = items.slice().sort((a, b) => (b.stars || 0) - (a.stars || 0))[0];
      autoInstalledRefs.add(pick.installRef);
      const id = ('ms-' + String(pick.id || pick.name).toLowerCase().replace(/[^a-z0-9]+/g, '-')).slice(0, 40).replace(/-+$/, '');
      const r = await hub.install({
        id,
        name: pick.name,
        installType: pick.installType,
        installRef: pick.installRef,
        plan: 'pro',
        desc: String(pick.description || '').slice(0, 120),
        autoStart: true,
      });
      autoInstalledCount++;
      const tools = (r.server && r.server.tools) || [];
      logger.info('agent', `self-expand installed ${id} (${reg.source}), started=${r.started}`);
      return { ok: true, started: r.started !== false, name: pick.name, id, tools, source: reg.source, error: r.error || '' };
    })(),
    8000,
    null
  );
}

/* ------------------------------------------------------------------ */
/* 主入口                                                              */
/* ------------------------------------------------------------------ */
async function chat({ text, sessionId = '', deviceId = 'anonymous', careMode = false, plan = 'pro', lng, lat, ip, stream = false }) {
  tokenMeter.assertQuota(deviceId);
  // 自动学习:对话主题入画像(轻权重,不因闲聊带偏)
  try {
    userProfile.track(deviceId, 'chat_topic', { text });
  } catch (_) {}

  // 1) 位置上下文
  let location = null;
  if (lng !== undefined && lat !== undefined) {
    location = { point: { lng: Number(lng), lat: Number(lat) }, source: 'client' };
    try {
      const rev = await baiduMap.reverseGeocode(Number(lng), Number(lat));
      location = { ...location, city: rev.city, district: rev.district, formatted: rev.formatted };
    } catch (_) {}
  } else {
    location = await ipLocate.locate(ip, {});
  }

  const ctx = { location };
  const toolCallsLog = [];
  const cards = [];
  const actions = [];
  let reply = '';
  let usage = { prompt: 0, completion: 0, total: 0, costCny: 0 };
  let model = '';

  // 2) 会话记忆
  const history = loadHistory(sessionId);
  const messages = [
    { role: 'system', content: systemPrompt({ careMode, plan, ctx, profileSummary: userProfile.summary(deviceId) }) },
    ...history.slice(-6),
    { role: 'user', content: text },
  ];

  const active = modelRegistry.active();
  const canUseModel = active && (active.apiKey || active.provider === 'ollama');

  // 3) 规则直调 MCP（方案 v2）：工具选择由意图规则确定性决定，
  //    不再交给模型 function-calling 猜——杜绝误调工具 / 幻觉工具名 / 编排失败
  const rule = await ruleOrchestrate({ text, ctx, plan, careMode });
  cards.push(...rule.cards);
  actions.push(...rule.actions);
  toolCallsLog.push(...rule.toolCalls);

  // 3b) MCP 自扩展：结果不确定 / 能力缺失 / 用户点名联网时，
  //     自动从 ModelScope MCP 广场搜索并安装最匹配的 MCP Server（限时 8s，失败静默）
  let expandNote = '';
  try {
    const ex = await maybeSelfExpand({ text, rule });
    if (ex && ex.ok) {
      expandNote = `已自动从 MCP 广场接入「${ex.name}」${ex.tools.length ? '（工具：' + ex.tools.slice(0, 5).join('、') + '）' : ''}`;
      toolCallsLog.push({ server: 'modelscope', tool: 'auto_install', ok: true, detail: ex.id, started: ex.started });
      if (!ex.started) expandNote += '，但该服务启动失败，已在面板登记待排查';
    }
  } catch (_) {}

  // 4) 有模型：云端 Qwen 把工具结果润色成人性化回复（联网搜索兜底时效信息）
  if (canUseModel) {
    try {
      if (rule.toolData && rule.toolData.length) {
        messages.push({
          role: 'user',
          content:
            '（系统注入的工具结果，非用户发言）已确定性调用以下工具：\n' +
            JSON.stringify(rule.toolData).slice(0, 6000) +
            (expandNote ? `\n${expandNote}。可在回答末尾用一句话告知用户能力已扩展。` : '') +
            '\n回答我上一个问题的要求：\n1. 名称、距离、价格等事实只能来自以上工具结果或联网检索，禁止凭记忆编造。\n2. 工具查不到的就明说查不到，给出替代建议。\n3. 不要只说「我查一下」。',
        });
      }
      const resp = await modelRegistry.chat({ messages, deviceId, modelId: active.id });
      if (resp.text) {
        reply = resp.text;
        usage = resp.usage;
        model = resp.model;
      }
    } catch (e) {
      logger.warn('agent', `model polish failed: ${e.message}`);
      reply = '';
    }
  }

  // 4b) 模型不可用 / 失败：直接用规则编排的回复（免费基础版同款体验）
  if (!reply) {
    reply = expandNote ? `${rule.reply}\n🧩 ${expandNote}。可稍后再问我一次，试试新接入的能力。` : rule.reply;
    model = model || 'local-rule-orchestrator';
  }

  // 4c) 清理兜底话术前缀（模型有时先说「我查一下」再给出实质内容，前缀会误导用户）
  if (reply) {
    reply = reply.replace(/^\s*我查一下[。.!！]?\s*/u, '').trim();
  }

  // 5) 成本优化后处理
  if (/省钱|便宜|成本|预算|划算/.test(text) && !cards.some((c) => c.type === 'cost')) {
    try {
      const r = await hub.callByQualifiedName('cost-optimizer__optimize_plan', {
        plans: [{ name: '打车直达', cost: 20, minutes: 12 }, { name: '公交+步行', cost: 2, minutes: 26 }],
        incomeLevel: 'below5000',
      });
      const d = (r.data && r.data.result) || r.data;
      if (d) {
        cards.push({ type: 'cost', title: '省钱方案', ...d });
        toolCallsLog.push({ server: 'cost-optimizer', tool: 'optimize_plan', ok: true, ms: r.ms });
      }
    } catch (_) {}
  }

  // 6) 落会话
  saveHistory(sessionId, [
    { role: 'user', content: text },
    { role: 'assistant', content: reply },
  ]);

  return {
    reply,
    cards: dedupeCards(cards),
    actions,
    toolCalls: toolCallsLog,
    usage,
    model,
    location,
    careMode,
    plan,
  };
}

function splitServer(q) {
  return String(q).split('__')[0];
}
function splitTool(q) {
  return String(q).split('__')[1];
}
function addUsage(a, b) {
  if (!b) return a;
  return {
    prompt: (a.prompt || 0) + (b.prompt || 0),
    completion: (a.completion || 0) + (b.completion || 0),
    total: (a.total || 0) + (b.total || 0),
    costCny: Number(((a.costCny || 0) + (b.costCny || 0)).toFixed(6)),
  };
}

/** 从 MCP 工具结果里提炼端上要渲染的卡片与动作 */
function collectCards(r, cards, actions) {
  const d = r.data && (r.data.result || r.data);
  if (!d) return;
  const server = splitServer(r.name);
  const tool = splitTool(r.name);

  if (server === 'baidu-map' && tool === 'poi_search' && Array.isArray(d.items)) {
    cards.push({ type: 'poi_list', title: '周边结果', items: d.items.slice(0, 8) });
  }
  if (server === 'baidu-map' && tool === 'route_plan') {
    cards.push({ type: 'route', distance: d.distance, duration: d.duration, mode: d.mode, polyline: d.polyline, congestion: d.congestion });
  }
  if (server === 'baidu-map' && tool === 'weather') {
    cards.push({ type: 'weather', ...d });
  }
  if (server === 'life-circle' && (tool === 'diagnose' || tool === 'life_report')) {
    cards.push({ type: 'life_score', score: d.score, level: d.level, shortboards: d.shortboards, suggestions: d.suggestions, categories: d.categories });
  }
  if (server === 'desktop-action' && tool === 'open_app' && d.uri) {
    actions.push({ type: 'open_app', app: d.app, uri: d.uri });
  }
  if (server === 'cost-optimizer' && tool === 'optimize_plan') {
    cards.push({ type: 'cost', title: '省钱方案', ...d });
  }
}

function dedupeCards(cards) {
  const seen = new Set();
  return cards.filter((c) => {
    const k = c.type + ':' + (c.title || '') + ':' + (c.score !== undefined ? c.score : '');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/* ------------------------------------------------------------------ */
/* 规则编排（免费基础版可用）                                           */
/* ------------------------------------------------------------------ */
async function ruleOrchestrate({ text, ctx, plan }) {
  const intents = detectIntents(text);
  const cards = [];
  const actions = [];
  const toolCalls = [];
  const toolData = []; // 原始工具结果，供云端模型润色回复时引用
  const lines = [];
  const p = ctx.location && ctx.location.point;

  const callSafe = async (server, tool, args) => {
    try {
      const r = await hub.callByQualifiedName(`${server}__${tool}`, args);
      toolCalls.push({ server, tool, ok: !r.isError, ms: r.ms });
      const d = (r.data && (r.data.result || r.data)) || null;
      toolData.push({ server, tool, ok: true, result: d });
      return d;
    } catch (e) {
      toolCalls.push({ server, tool, ok: false, error: e.message });
      toolData.push({ server, tool, ok: false, error: e.message });
      return null;
    }
  };

  const KEYWORD = { medical: '医院|药店|社区卫生服务中心', market: '超市|菜市场|便利店', park: '公园|广场', transit: '公交站|地铁站', scenic: '景点|公园' };

  for (const it of intents) {
    if (KEYWORD[it.key] && p) {
      const d = await callSafe('baidu-map', 'poi_search', { query: KEYWORD[it.key], lng: p.lng, lat: p.lat, radius: 1200 });
      if (d && d.items && d.items.length) {
        cards.push({ type: 'poi_list', title: `周边${it.cat}`, items: d.items.slice(0, 6) });
        const first = d.items[0];
        lines.push(`${it.cat}：${first.name}，约 ${first.distance || '?'} 米。`);
      } else {
        lines.push(`${it.cat}：15 分钟步行范围内暂未查到，建议扩大范围。`);
      }
    }
  }

  if (intents.some((i) => i.key === 'route') && p) {
    const d = await callSafe('baidu-map', 'route_plan', {
      mode: /开车|驾车|打车/.test(text) ? 'driving' : 'walking',
      origin: `${p.lat},${p.lng}`,
      destination: `${p.lat + 0.008},${p.lng + 0.006}`,
      realtime: /避堵|堵|实时/.test(text),
    });
    if (d) {
      cards.push({ type: 'route', distance: d.distance, duration: d.duration, mode: d.mode, polyline: d.polyline, congestion: d.congestion });
      lines.push(`路线：约 ${(d.distance / 1000).toFixed(1)} 公里，预计 ${Math.round((d.duration || 0) / 60)} 分钟${d.congestion ? '，' + d.congestion : ''}。`);
      if (plan === 'pro') {
        // ⚠️ coord_type=gcj02：p 来自端上报的 GCJ-02 定位，写 bd09ll 会整个错位
        actions.push({ type: 'open_app', app: '百度地图', uri: `baidumap://map/direction?origin=${p.lat},${p.lng}&destination=${p.lat + 0.008},${p.lng + 0.006}&mode=walking&coord_type=gcj02` });
      }
    }
  }

  if (intents.some((i) => i.key === 'cost')) {
    const d = await callSafe('cost-optimizer', 'optimize_plan', {
      plans: [{ name: '打车直达', cost: 20, minutes: 12 }, { name: '公交+步行', cost: 2, minutes: 26 }],
      incomeLevel: 'below5000',
    });
    if (d) {
      cards.push({ type: 'cost', title: '省钱方案', ...d });
      if (d.recommended) lines.push(`省钱推荐：${d.recommended.name}，约 ¥${d.recommended.cost}，省 ¥${d.saved || 0}。`);
    }
  }

  if (intents.some((i) => i.key === 'emotion')) {
    const d = await callSafe('emotion', 'soothe', { text, mood: 'low' });
    if (d && d.reply) lines.push(d.reply);
  }

  if (intents.some((i) => i.key === 'buy') && plan === 'pro') {
    const d = await callSafe('desktop-action', 'desktop_operate', { os: 'windows', target: '电商应用', intent: text, constraints: { maxPrice: 39 } });
    if (d && d.steps) {
      cards.push({ type: 'action_plan', title: '桌面操作方案', steps: d.steps, needConfirm: true });
      lines.push('已生成操作步骤，涉及付款需您确认后才会执行。');
    }
  }

  // 通用：无具体意图 → 给一次生活圈体检
  if (intents[0].key === 'general' && p) {
    const d = await callSafe('life-circle', 'diagnose', { lng: p.lng, lat: p.lat, radius: 1200 });
    if (d) {
      cards.push({ type: 'life_score', score: d.score, level: d.level, shortboards: d.shortboards, suggestions: d.suggestions, categories: d.categories });
      lines.push(`15 分钟生活圈体检：${d.score} 分（${d.level}）。`);
      if (d.shortboards && d.shortboards.length) lines.push(`短板：${d.shortboards[0]}`);
    }
  }

  if (!lines.length) {
    lines.push('我是鲤慧。您可以问我：附近哪里能看病？15 分钟生活圈缺什么？怎么走最省时间？');
  }

  return {
    reply: lines.map((l, i) => `${i + 1}. ${l}`).join('\n'),
    cards,
    actions,
    toolCalls,
    toolData,
  };
}

/* ------------------------------------------------------------------ */
/* 会话记忆（长记忆落 data/sessions.json）                              */
/* ------------------------------------------------------------------ */
function loadHistory(sessionId) {
  if (!sessionId) return [];
  const s = sessionCol.find((x) => x.id === sessionId);
  return (s && s.messages) || [];
}

function saveHistory(sessionId, items) {
  if (!sessionId) return;
  const s = sessionCol.find((x) => x.id === sessionId);
  if (s) {
    const messages = [...(s.messages || []), ...items].slice(-40);
    sessionCol.update(sessionId, { messages, updatedAt: Date.now() });
  } else {
    sessionCol.add({ id: sessionId, messages: items, createdAt: Date.now(), updatedAt: Date.now() });
  }
}

function listSessions() {
  return sessionCol.all().map((s) => ({ id: s.id, count: (s.messages || []).length, updatedAt: s.updatedAt }));
}

function clearSession(sessionId) {
  return sessionCol.remove(sessionId);
}

module.exports = { chat, detectIntents, listSessions, clearSession, systemPrompt };
