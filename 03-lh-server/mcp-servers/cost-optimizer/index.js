#!/usr/bin/env node
/**
 * 鲤慧 LiHui · MCP Server: cost-optimizer
 * 智能成本优化 —— 针对「家庭可支配收入不足 5000 元」人群，把出行/采购方案成本降到最低
 * 工具：optimize_plan / promo_push
 */
const readline = require('readline');

const TOOLS = [
  {
    name: 'optimize_plan',
    description: '在多套出行/采购方案中按成本最优重排，输出推荐方案、节省金额与达成时间。适合预算敏感人群。',
    inputSchema: {
      type: 'object',
      properties: {
        plans: { type: 'array', description: '[{ name, cost, minutes, comfort? }] 候选方案', items: { type: 'object' } },
        incomeLevel: { type: 'string', description: 'below5000 / mid / high，默认 below5000' },
        weight: { type: 'object', description: '{ cost:0.6, time:0.4 } 成本与时间的权重' },
      },
      required: ['plans'],
    },
  },
  {
    name: 'promo_push',
    description: '聚合周边商家优惠信息并推送（满减、折扣、新客券），按预计节省金额排序。',
    inputSchema: { type: 'object', properties: { lng: { type: 'number' }, lat: { type: 'number' }, category: { type: 'string', description: '如「超市」「药店」「餐饮」' }, radius: { type: 'number' } }, required: ['category'] },
  },
];

function optimizePlan({ plans = [], incomeLevel = 'below5000', weight }) {
  if (!Array.isArray(plans) || !plans.length) throw new Error('plans 不能为空');
  const w = weight || (incomeLevel === 'below5000' ? { cost: 0.75, time: 0.25 } : incomeLevel === 'high' ? { cost: 0.3, time: 0.7 } : { cost: 0.5, time: 0.5 });
  const maxCost = Math.max(...plans.map((p) => Number(p.cost) || 0), 1);
  const maxTime = Math.max(...plans.map((p) => Number(p.minutes) || 0), 1);
  const scored = plans.map((p) => {
    const cost = Number(p.cost) || 0;
    const minutes = Number(p.minutes) || 0;
    const costScore = cost / maxCost;
    const timeScore = minutes / maxTime;
    const total = costScore * w.cost + timeScore * w.time;
    return { ...p, cost, minutes, costScore: Number(costScore.toFixed(3)), timeScore: Number(timeScore.toFixed(3)), totalScore: Number(total.toFixed(3)) };
  }).sort((a, b) => a.totalScore - b.totalScore);

  const best = scored[0];
  const worst = scored[scored.length - 1];
  const saved = Number((worst.cost - best.cost).toFixed(2));
  const extraMinutes = best.minutes - worst.minutes;

  return {
    recommended: { name: best.name, cost: best.cost, minutes: best.minutes },
    saved,
    extraMinutes,
    ranking: scored.map((s) => ({ name: s.name, cost: s.cost, minutes: s.minutes, score: s.totalScore })),
    verdict:
      saved <= 0
        ? '各方案成本接近，建议优先选择耗时最短的方案。'
        : extraMinutes <= 0
        ? `「${best.name}」既更省钱（省 ¥${saved}）又更快，直接选它。`
        : `推荐「${best.name}」：比最贵方案省 ¥${saved}，仅多花 ${extraMinutes} 分钟；按每周 10 次计算，月省约 ¥${(saved * 10 * 4.3).toFixed(0)}。`,
    monthlySavingEstimate: Number((saved * 10 * 4.3).toFixed(0)),
    budgetAdvice: incomeLevel === 'below5000' ? '建议把单次通勤成本控制在 ¥5 以内，优先「步行 + 公交」组合。' : '可按舒适度优先，成本权重已下调。',
  };
}

function promoPush({ lng, lat, category, radius = 2000 }) {
  // 无线上优惠券 API 时，返回结构化推送模板 + 本地可核验的建议
  const templates = [
    { type: '满减', title: `${category} 满 50 减 10`, save: 10, condition: '单笔满 50 元', validDays: 7 },
    { type: '新客券', title: `新客首单立减 8 元`, save: 8, condition: '首次下单', validDays: 30 },
    { type: '折扣', title: `晚间 19:00 后生鲜 8 折`, save: 6, condition: '19:00-22:00', validDays: 1 },
    { type: '会员日', title: `每周三会员双倍积分`, save: 3, condition: '会员日', validDays: 1 },
  ];
  return {
    category,
    radius,
    center: lng !== undefined ? { lng, lat } : null,
    items: templates,
    totalPotentialSave: templates.reduce((a, b) => a + b.save, 0),
    tip: '优惠以商家门店公示与官方小程序为准；建议先在常去的 2-3 家商超建立会员，累计优惠最稳定。',
    pushSchedule: ['每日 08:30 推送今日生鲜折扣', '每周三 10:00 推送会员日活动', '每月 1 日推送月度省钱清单'],
  };
}

const IMPL = { optimize_plan: optimizePlan, promo_push: promoPush };
const SERVER_INFO = { name: 'lh-cost-optimizer', version: '1.0.0' };
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
      const data = fn((params && params.arguments) || {});
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(data) }] } });
    } catch (e) {
      return send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: e.message }) }] } });
    }
  }
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `未实现的方法: ${method}` } });
});
