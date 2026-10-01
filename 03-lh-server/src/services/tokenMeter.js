/**
 * 鲤慧 LiHui · Token 计量与配额
 *  - 每次模型调用后调用 record()
 *  - 支持按天 / 按设备 / 按模型聚合
 *  - 简单价格表（元 / 千 token），可按需扩展
 */
const config = require('../config');
const store = require('./store');

const PRICE = {
  // 元 / 1K tokens  [输入, 输出]
  'qwen-plus': [0.0008, 0.002],
  'qwen-turbo': [0.0003, 0.0006],
  'qwen-1.8b-instruct': [0, 0],
  'deepseek-chat': [0.001, 0.002],
  'gpt-4o-mini': [0.0011, 0.0043],
  'glm-4-flash': [0, 0],
  default: [0.001, 0.002],
};

const col = store.collection('tokens', []);
const quotaStore = store.collection('quota', [{ id: 'default', daily: config.token.dailyQuota }]);

function dayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function priceOf(model) {
  return PRICE[model] || PRICE[PRICE[model && model.toLowerCase()]] || PRICE.default;
}

function record({ deviceId = 'anonymous', model = '', prompt = 0, completion = 0 }) {
  const total = Number(prompt || 0) + Number(completion || 0);
  const [pi, po] = priceOf(model);
  const costCny = (Number(prompt || 0) / 1000) * pi + (Number(completion || 0) / 1000) * po;
  const item = {
    id: store.uid('tk'),
    day: dayKey(),
    ts: Date.now(),
    deviceId,
    model: model || config.llm.model,
    prompt: Number(prompt || 0),
    completion: Number(completion || 0),
    total,
    costCny: Number(costCny.toFixed(6)),
  };
  col.add(item);
  return item;
}

/** 粗估 token（无 usage 返回时兜底）：中文≈1字1token，英文≈4字符1token */
function estimate(text) {
  if (!text) return 0;
  const s = String(text);
  const cn = (s.match(/[\u4e00-\u9fa5]/g) || []).length;
  const other = s.length - cn;
  return cn + Math.ceil(other / 4);
}

function getQuota() {
  const q = quotaStore.find((x) => x.id === 'default');
  return { daily: (q && q.daily) || config.token.dailyQuota };
}

function setQuota(daily) {
  const q = quotaStore.find((x) => x.id === 'default');
  if (q) quotaStore.update('default', { daily: Number(daily) });
  else quotaStore.add({ id: 'default', daily: Number(daily) });
  return getQuota();
}

function stats({ range = '7d', deviceId = '' } = {}) {
  const days = Number(String(range).replace(/[^\d]/g, '')) || 7;
  const all = col.all().filter((x) => (deviceId ? x.deviceId === deviceId : true));
  const since = Date.now() - days * 24 * 3600 * 1000;
  const scope = all.filter((x) => x.ts >= since);

  const agg = (list) => ({
    prompt: list.reduce((a, b) => a + b.prompt, 0),
    completion: list.reduce((a, b) => a + b.completion, 0),
    total: list.reduce((a, b) => a + b.total, 0),
    costCny: Number(list.reduce((a, b) => a + b.costCny, 0).toFixed(6)),
    calls: list.length,
  });

  const byDayMap = new Map();
  const byModelMap = new Map();
  for (const it of scope) {
    const d = byDayMap.get(it.day) || { day: it.day, prompt: 0, completion: 0, total: 0, costCny: 0, calls: 0 };
    d.prompt += it.prompt; d.completion += it.completion; d.total += it.total;
    d.costCny = Number((d.costCny + it.costCny).toFixed(6)); d.calls += 1;
    byDayMap.set(it.day, d);

    const m = byModelMap.get(it.model) || { model: it.model, prompt: 0, completion: 0, total: 0, costCny: 0, calls: 0 };
    m.prompt += it.prompt; m.completion += it.completion; m.total += it.total;
    m.costCny = Number((m.costCny + it.costCny).toFixed(6)); m.calls += 1;
    byModelMap.set(it.model, m);
  }

  const today = dayKey();
  const usedToday = all.filter((x) => x.day === today).reduce((a, b) => a + b.total, 0);
  const { daily } = getQuota();

  return {
    range: `${days}d`,
    total: agg(scope),
    allTime: agg(all),
    quota: { daily, usedToday, remainToday: Math.max(0, daily - usedToday) },
    byDay: Array.from(byDayMap.values()).sort((a, b) => (a.day < b.day ? -1 : 1)),
    byModel: Array.from(byModelMap.values()).sort((a, b) => b.total - a.total),
  };
}

/** 配额校验：超限时抛错 */
function assertQuota(deviceId) {
  const today = dayKey();
  const used = col.all().filter((x) => x.day === today && x.deviceId === deviceId).reduce((a, b) => a + b.total, 0);
  const { daily } = getQuota();
  if (used >= daily) {
    const e = new Error('今日 Token 配额已用完，请明日再试或在管理端调整配额');
    e.code = 1003;
    throw e;
  }
  return { used, daily };
}

module.exports = { record, estimate, stats, getQuota, setQuota, assertQuota, priceOf };
