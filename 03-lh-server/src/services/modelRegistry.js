/**
 * 鲤慧 LiHui · 用户自定义模型注册表 + 统一 LLM 调用
 * 支持：openai-compatible / anthropic / gemini / ollama / baidu-qianfan / deepseek
 */
const config = require('../config');
const store = require('./store');
const { fetchJSON } = require('../utils/http');
const logger = require('../utils/logger');
const tokenMeter = require('./tokenMeter');

const col = store.collection('models', []);
const PRESETS = [
  {
    id: 'preset-qwen-free',
    name: '通义千问（ModelScope 免费推理）',
    provider: 'openai-compatible',
    baseUrl: 'https://api-inference.modelscope.cn/v1',
    apiKey: '',
    model: 'Qwen/Qwen2.5-7B-Instruct',
    // ⚠️ 默认关：没填有效 token 时开着只会 401。seed() 检测到 key（环境变量或库内）会自动启用并设为默认
    enabled: false,
    isDefault: true,
    preset: true,
    webSearch: false,
    note: '阿里魔搭 ModelScope 官方免费 API 推理（每天 2000 次，0 元），OpenAI 兼容；仍是 Qwen 系列云端。Token 在 modelscope.cn → 控制台 → 访问令牌 免费获取，配 MODELSCOPE_TOKEN 环境变量或在此粘贴'
  },
  {
    id: 'preset-sf-qwen-free',
    name: 'Qwen 7B（硅基流动 免费档）',
    provider: 'openai-compatible',
    baseUrl: 'https://api.siliconflow.cn/v1',
    apiKey: '',
    model: 'Qwen/Qwen2.5-7B-Instruct',
    enabled: false,
    isDefault: false,
    preset: true,
    webSearch: false,
    note: '硅基流动免费档（Qwen2.5-7B 永久免费）；备选渠道，Token 在 siliconflow.cn 免费获取，配 SILICONFLOW_API_KEY'
  },
  {
    id: 'preset-qwen18b',
    name: '通义千问 Flash（DashScope · 付费）',
    provider: 'openai-compatible',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKey: '',
    model: 'qwen-flash',
    enabled: false,
    isDefault: false,
    preset: true,
    webSearch: true,
    note: '阿里云百炼 DashScope（消耗个人付费额度，仅手动开启时使用）；qwen-1.8b-chat 已下线，升级为 qwen-flash；联网搜索已开启（enable_search）'
  },
  { id: 'preset-deepseek', name: 'DeepSeek Chat', provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', apiKey: '', model: 'deepseek-chat', enabled: true, isDefault: false, preset: true, note: '支持 Function Calling，推荐用于 MCP 编排；账户需有余额（欠费时 API 返回 402）' },
  { id: 'preset-qwen-plus', name: '通义千问 Plus', provider: 'openai-compatible', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: '', model: 'qwen-plus', enabled: false, isDefault: false, preset: true, note: '中文强，支持工具调用' },
  { id: 'preset-glm4flash', name: '智谱 GLM-4-Flash', provider: 'openai-compatible', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: '', model: 'glm-4-flash', enabled: false, isDefault: false, preset: true, note: '免费额度大，适合大批量对话' },
  { id: 'preset-ollama', name: '本地 Ollama（备用）', provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', apiKey: 'ollama', model: 'qwen2.5:7b-instruct', enabled: false, isDefault: false, preset: true, note: '完全本地、零成本；仅在云端模型未配 Key 时作为演示备用' },
];

/** 免费渠道的密钥环境变量（配了就自动填进对应预置，云端部署只需设环境变量） */
const PRESET_ENV_KEY = {
  'preset-qwen-free': 'MODELSCOPE_TOKEN',
  'preset-sf-qwen-free': 'SILICONFLOW_API_KEY',
};

function seed() {
  const list = col.all();
  if (!list.length) {
    col.save(PRESETS.map((p) => ({
      ...p,
      apiKey: p.apiKey || process.env[PRESET_ENV_KEY[p.id]] || '',
    })));
    return;
  }
  // 补齐新增预置 + 用环境变量填充免费渠道密钥 + 预置项开关以代码为准
  // （预置的 enabled/isDefault 改动要能落库生效，否则云上永远跑旧开关）
  const ids = new Set(list.map((x) => x.id));
  let changed = false;
  for (const p of PRESETS) {
    if (!ids.has(p.id)) {
      list.push({ ...p, apiKey: p.apiKey || process.env[PRESET_ENV_KEY[p.id]] || '' });
      changed = true;
      continue;
    }
    const it = list.find((x) => x.id === p.id);
    // 免费渠道：库里有 key 就尊重库里的；没 key 而环境变量有 → 自动填；
    // 且拿到有效 key 后自动启用为默认（没 key 时保持关闭，避免 401 挡住整条链）
    if (p.id === 'preset-qwen-free') {
      if (!it.apiKey && process.env[PRESET_ENV_KEY[p.id]]) it.apiKey = process.env[PRESET_ENV_KEY[p.id]];
      const shouldOn = !!it.apiKey;
      if (it.enabled !== shouldOn || it.isDefault !== shouldOn) {
        it.enabled = shouldOn;
        it.isDefault = shouldOn;
        changed = true;
      }
      if (it.model !== p.model || it.baseUrl !== p.baseUrl) {
        it.model = p.model;
        it.baseUrl = p.baseUrl;
        changed = true;
      }
      continue;
    }
    if (it.apiKey && process.env[PRESET_ENV_KEY[p.id]] && !it.apiKey) it.apiKey = process.env[PRESET_ENV_KEY[p.id]];
    // 开关/默认以代码里的预置为准（防止旧的「付费 preset 是默认」状态残留）
    if (it.enabled !== p.enabled || it.isDefault !== p.isDefault || it.model !== p.model || it.baseUrl !== p.baseUrl) {
      it.enabled = p.enabled;
      it.isDefault = p.isDefault;
      it.model = p.model;
      it.baseUrl = p.baseUrl;
      changed = true;
    }
  }
  if (changed) col.save(list);
}
seed();

const mask = (k) => (!k ? '' : k.length <= 8 ? '****' : k.slice(0, 4) + '****' + k.slice(-4));

function list({ reveal = false } = {}) {
  return col.all().map((m) => ({ ...m, apiKey: reveal ? m.apiKey : mask(m.apiKey) }));
}

function listFull() {
  return col.all();
}

function get(id) {
  return col.find((x) => x.id === id) || null;
}

function active() {
  const all = listFull();
  // 可用 = 已启用 且（有密钥 或 是本地 Ollama 这种免密渠道）。
  // ⚠️ 不再回退到「没配 key 的云端模型」——那样每次对话只会白报错；
  //    也不默认回退到付费渠道——客户明确要求不消耗个人付费 API。
  const usable = (x) => x.enabled && (x.apiKey || x.provider === 'ollama');
  return all.find((x) => usable(x) && x.isDefault) || all.find(usable) || null;
}

function save(input) {
  const patch = {
    name: input.name || '未命名模型',
    provider: input.provider || 'openai-compatible',
    baseUrl: (input.baseUrl || '').replace(/\/+$/, ''),
    apiKey: input.apiKey || '',
    model: input.model || '',
    enabled: input.enabled !== false,
    note: input.note || '',
    preset: false,
    updatedAt: Date.now(),
  };
  let item;
  if (input.id && get(input.id)) {
    const old = get(input.id);
    // 未传新 key 时保留旧 key
    if (!input.apiKey) patch.apiKey = old.apiKey;
    item = col.update(input.id, patch);
  } else {
    item = col.add({ id: store.uid('m'), createdAt: Date.now(), ...patch });
  }
  // 唯一 default
  if (input.isDefault) {
    const all = col.all().map((x) => ({ ...x, isDefault: x.id === item.id, enabled: x.id === item.id ? true : x.enabled }));
    col.save(all);
  }
  return get(item.id);
}

function remove(id) {
  const m = get(id);
  if (m && m.preset) {
    // 预置项不物理删除，只禁用
    return col.update(id, { enabled: false, isDefault: false });
  }
  col.remove(id);
  return true;
}

function setDefault(id) {
  const all = col.all().map((x) => ({ ...x, isDefault: x.id === id }));
  col.save(all);
  return get(id);
}

/* ------------------------------------------------------------------ */
/* 统一 chat 调用                                                      */
/* ------------------------------------------------------------------ */
/**
 * @returns {{ text:string, usage:{prompt,completion,total}, model:string, raw:any }}
 */
async function chat({ messages, modelId = '', temperature = 0.6, maxTokens = 1024, tools, deviceId = 'anonymous' }) {
  let m = modelId ? get(modelId) : null;
  if (!m || !m.enabled) m = active();

  // 完全没配模型 → 走本地规则兜底（不消耗 token）
  if (!m || (!m.apiKey && m.provider !== 'ollama' && !(config.llm.apiKey && config.llm.baseUrl))) {
    const text = ruleBasedReply(messages);
    return {
      text,
      usage: { prompt: 0, completion: 0, total: 0, costCny: 0 },
      model: 'local-rule-fallback',
      fallback: true,
    };
  }

  if (!m.apiKey && config.llm.apiKey && config.llm.baseUrl) {
    m = { ...m, provider: 'openai-compatible', baseUrl: config.llm.baseUrl, apiKey: config.llm.apiKey, model: config.llm.model };
  }

  const provider = m.provider;
  let res;

  if (provider === 'ollama') {
    res = await callOllama(m, messages, { temperature, maxTokens });
  } else if (provider === 'anthropic') {
    res = await callAnthropic(m, messages, { temperature, maxTokens });
  } else if (provider === 'gemini') {
    res = await callGemini(m, messages, { temperature, maxTokens });
  } else {
    res = await callOpenAICompatible(m, messages, { temperature, maxTokens, tools });
  }

  const usage = res.usage || {
    prompt: tokenMeter.estimate(messages.map((x) => x.content).join('\n')),
    completion: tokenMeter.estimate(res.text),
  };
  usage.total = (usage.prompt || 0) + (usage.completion || 0);
  const rec = tokenMeter.record({ deviceId, model: m.model, prompt: usage.prompt || 0, completion: usage.completion || 0 });
  usage.costCny = rec.costCny;

  return { text: res.text, usage, model: m.model, toolCalls: res.toolCalls || [], raw: res.raw };
}

async function callOpenAICompatible(m, messages, { temperature, maxTokens, tools }) {
  const url = `${m.baseUrl || 'https://api.openai.com/v1'}/chat/completions`;
  const body = {
    model: m.model,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: false,
  };
  // 联网搜索（阿里云百炼 DashScope 专属参数）：模型可检索实时信息回答。
  // ⚠️ 必须同时传 search_options.search_mode，否则搜索是「尽力而为」经常静默不触发
  //    （实测：带 search_options 后 tools+search 同传 3/3 稳定返回真实检索结果）
  if (m.webSearch === true || /dashscope\.aliyuncs\.com/.test(m.baseUrl || '')) {
    body.enable_search = true;
    body.search_options = { search_mode: 'balanced', enable_caching: true };
  }
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  const raw = await fetchJSON(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${m.apiKey}` },
    body,
    timeout: 60000,
    retry: 1,
  });
  const choice = (raw.choices && raw.choices[0]) || {};
  const msg = choice.message || {};
  let text = msg.content || '';
  if (Array.isArray(text)) text = text.map((c) => (c.text || '')).join('');
  return {
    text,
    toolCalls: msg.tool_calls || [],
    usage: raw.usage
      ? { prompt: raw.usage.prompt_tokens, completion: raw.usage.completion_tokens }
      : null,
    raw,
  };
}

async function callOllama(m, messages, { temperature, maxTokens }) {
  const url = `${m.baseUrl || 'http://127.0.0.1:11434'}/api/chat`;
  const raw = await fetchJSON(url, {
    method: 'POST',
    body: {
      model: m.model,
      messages,
      stream: false,
      options: { temperature, num_predict: maxTokens },
    },
    timeout: 120000,
    retry: 0,
  });
  return {
    text: (raw.message && raw.message.content) || '',
    usage: raw.eval_count
      ? { prompt: raw.prompt_eval_count || 0, completion: raw.eval_count || 0 }
      : null,
    raw,
  };
}

async function callAnthropic(m, messages, { temperature, maxTokens }) {
  const url = `${m.baseUrl || 'https://api.anthropic.com'}/v1/messages`;
  const system = messages.filter((x) => x.role === 'system').map((x) => x.content).join('\n');
  const rest = messages.filter((x) => x.role !== 'system');
  const raw = await fetchJSON(url, {
    method: 'POST',
    headers: { 'x-api-key': m.apiKey, 'anthropic-version': '2023-06-01' },
    body: { model: m.model, system, messages: rest, temperature, max_tokens: maxTokens },
    timeout: 60000,
  });
  const text = (raw.content || []).map((c) => c.text || '').join('');
  return {
    text,
    usage: raw.usage ? { prompt: raw.usage.input_tokens, completion: raw.usage.output_tokens } : null,
    raw,
  };
}

async function callGemini(m, messages, { temperature, maxTokens }) {
  const base = m.baseUrl || 'https://generativelanguage.googleapis.com/v1beta';
  const url = `${base}/models/${m.model}:generateContent?key=${encodeURIComponent(m.apiKey)}`;
  const contents = messages
    .filter((x) => x.role !== 'system')
    .map((x) => ({ role: x.role === 'assistant' ? 'model' : 'user', parts: [{ text: x.content }] }));
  const sys = messages.filter((x) => x.role === 'system').map((x) => x.content).join('\n');
  const raw = await fetchJSON(url, {
    method: 'POST',
    body: {
      contents,
      ...(sys ? { systemInstruction: { parts: [{ text: sys }] } } : {}),
      generationConfig: { temperature, maxOutputTokens: maxTokens },
    },
    timeout: 60000,
  });
  const cand = (raw.candidates && raw.candidates[0]) || {};
  const text = ((cand.content && cand.content.parts) || []).map((p) => p.text || '').join('');
  return {
    text,
    usage: raw.usageMetadata
      ? { prompt: raw.usageMetadata.promptTokenCount, completion: raw.usageMetadata.candidatesTokenCount }
      : null,
    raw,
  };
}

/* 无模型时的本地规则兜底（保证赛题「免费基础版」也能跑） */
function ruleBasedReply(messages) {
  const last = [...messages].reverse().find((x) => x.role === 'user');
  const q = (last && last.content) || '';
  if (/医院|看病|诊所|卫生/.test(q)) return '已为您找到附近的医疗机构，详见下方卡片。如需 15 分钟生活圈完整体检，请点击「生活圈」。';
  if (/菜市场|买菜|超市|便利店/.test(q)) return '周边 15 分钟步行范围内有菜市场与超市，详见下方列表。';
  if (/怎么走|路线|导航|多远/.test(q)) return '已为您规划步行路线，预计耗时见卡片。';
  if (/省钱|便宜|成本/.test(q)) return '已按「成本最低」为您重排方案，详见省钱对比。';
  return '我是鲤慧。您可以问我：附近哪里能看病？15 分钟生活圈缺什么？怎么走最省时间？';
}

/** 连通性测试 */
async function test(id) {
  const m = get(id);
  if (!m) return { ok: false, msg: '模型不存在' };
  const t0 = Date.now();
  try {
    const r = await chat({
      modelId: id,
      messages: [
        { role: 'system', content: '你是连通性测试助手，只回复 pong' },
        { role: 'user', content: 'ping' },
      ],
      maxTokens: 16,
      deviceId: '__test__',
    });
    return { ok: true, latencyMs: Date.now() - t0, reply: r.text, model: r.model, usage: r.usage };
  } catch (e) {
    logger.warn('modelRegistry', `test ${id} failed: ${e.message}`);
    return { ok: false, latencyMs: Date.now() - t0, msg: e.message };
  }
}

module.exports = { list, listFull, get, active, save, remove, setDefault, chat, test, PRESETS };
