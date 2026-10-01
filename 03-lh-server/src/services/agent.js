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
const store = require('./store');
const logger = require('../utils/logger');

const sessionCol = store.collection('sessions', []);

/* ------------------------------------------------------------------ */
/* 系统提示词                                                          */
/* ------------------------------------------------------------------ */
function systemPrompt({ careMode, plan, ctx }) {
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
  { key: 'medical', re: /医院|看病|诊所|社区卫生|药店|体检/, cat: '医疗' },
  { key: 'market', re: /菜市场|买菜|超市|便利店|生鲜/, cat: '商业' },
  { key: 'park', re: /公园|遛弯|广场|健身|散步/, cat: '休闲' },
  { key: 'transit', re: /公交|地铁|车站|怎么去|交通/, cat: '交通' },
  { key: 'scenic', re: /景点|打卡|玩|旅游|遛娃/, cat: '休闲' },
  { key: 'route', re: /路线|导航|怎么走|多远|多久|避堵/, cat: '路线' },
  { key: 'cost', re: /省钱|便宜|成本|划算|预算/, cat: '成本' },
  { key: 'emotion', re: /难过|烦|压力|孤独|累|抑郁|不开心/, cat: '情感' },
  { key: 'buy', re: /买|下单|购物|网购/, cat: '购买' },
];

function detectIntents(text) {
  const hits = [];
  for (const it of INTENTS) if (it.re.test(text)) hits.push(it);
  return hits.length ? hits : [{ key: 'general', cat: '通用' }];
}

/* ------------------------------------------------------------------ */
/* 主入口                                                              */
/* ------------------------------------------------------------------ */
async function chat({ text, sessionId = '', deviceId = 'anonymous', careMode = false, plan = 'pro', lng, lat, ip, stream = false }) {
  tokenMeter.assertQuota(deviceId);

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
    { role: 'system', content: systemPrompt({ careMode, plan, ctx }) },
    ...history.slice(-6),
    { role: 'user', content: text },
  ];

  const tools = hub.toOpenAITools(plan);
  const active = modelRegistry.active();
  const canUseModel = active && (active.apiKey || active.provider === 'ollama');

  // 3) 有模型：走 function-calling
  if (canUseModel) {
    try {
      const first = await modelRegistry.chat({
        messages,
        tools: tools.length ? tools : undefined,
        deviceId,
        modelId: active.id,
      });
      model = first.model;
      usage = first.usage;

      if (first.toolCalls && first.toolCalls.length) {
        const results = await runToolCalls(first.toolCalls);
        toolCallsLog.push(...results.map((r) => ({ server: splitServer(r.name), tool: splitTool(r.name), ok: r.ok, ms: r.ms, error: r.error })));

        // 结果回灌
        messages.push({ role: 'assistant', content: first.text || '', tool_calls: first.toolCalls });
        for (const r of results) {
          messages.push({
            role: 'tool',
            tool_call_id: r.name,
            content: JSON.stringify({ ok: r.ok, data: r.data || null, error: r.error || null }).slice(0, 8000),
          });
        }
        const second = await modelRegistry.chat({ messages, deviceId, modelId: active.id });
        reply = second.text;
        usage = addUsage(usage, second.usage);
        model = second.model;

        // 从工具结果里抽取卡片/动作
        for (const r of results) collectCards(r, cards, actions);
      } else {
        reply = first.text;
      }

      // 防复读兜底话术：轻量模型偶尔无视指令只回「我查一下」——追问一轮逼出实质回答
      if (reply && reply.length <= 40 && /我查一下/.test(reply)) {
        messages.push({
          role: 'user',
          content: '请基于联网检索结果直接回答我刚才的问题；如确实查不到，给出你已知的最接近信息并注明「未经核实」，不要只说「我查一下」。',
        });
        const third = await modelRegistry.chat({ messages, deviceId, modelId: active.id });
        if (third.text && !/我查一下/.test(third.text)) {
          reply = third.text;
          usage = addUsage(usage, third.usage);
        }
      }
    } catch (e) {
      logger.warn('agent', `model path failed: ${e.message}`);
      reply = '';
    }
  }

  // 4b) 清理兜底话术前缀（模型有时先说「我查一下」再给出实质内容，前缀会误导用户）
  if (reply) {
    reply = reply.replace(/^\s*我查一下[。.!！]?\s*/u, '').trim();
  }

  // 4) 无模型 / 模型失败：规则 + MCP 直调
  if (!reply) {
    const r = await ruleOrchestrate({ text, ctx, plan, careMode });
    reply = r.reply;
    cards.push(...r.cards);
    actions.push(...r.actions);
    toolCallsLog.push(...r.toolCalls);
    model = model || 'local-rule-orchestrator';
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
  const lines = [];
  const p = ctx.location && ctx.location.point;

  const callSafe = async (server, tool, args) => {
    try {
      const r = await hub.callByQualifiedName(`${server}__${tool}`, args);
      toolCalls.push({ server, tool, ok: !r.isError, ms: r.ms });
      return (r.data && (r.data.result || r.data)) || null;
    } catch (e) {
      toolCalls.push({ server, tool, ok: false, error: e.message });
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
        actions.push({ type: 'open_app', app: '百度地图', uri: `baidumap://map/direction?origin=${p.lat},${p.lng}&destination=${p.lat + 0.008},${p.lng + 0.006}&mode=walking&coord_type=bd09ll` });
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
