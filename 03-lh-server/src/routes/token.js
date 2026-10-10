/**
 * 鲤慧 LiHui · Token 计量与配额路由
 */
const { ok, fail } = require('../utils/http');
const tokenMeter = require('../services/tokenMeter');
const auth = require('../services/auth');

module.exports = {
  /** GET /api/v1/token/stats?range=7d
   *  2026-10-10 账号锚定修复：计量写入（agent/vision → resolveOwner.ownerKey，
   *  登录= user:<uid>）与统计读取此前口径不一致——登录后用的 Token 按设备查全为 0，
   *  端上「花费不更新」。现读取与写入同锚：登录按账号聚合，未登录按设备兜底。
   *  2026-10-10 二次修复（V1.0.20）：重登录后统计「归零」——匿名期间的用量记在
   *  device 键下，登录后只读 user 键自然看不见。现登录态自动聚合 账号 + 本机匿名
   *  两段用量（byDay / byModel / allTime / usedToday 全合并），退出或重登录统计不再丢失。 */
  'GET /token/stats': async (req, res, q) => {
    const owner = auth.resolveOwner(req);
    const range = (q && q.range) || '7d';
    const base = tokenMeter.stats({ range, deviceId: owner.ownerKey });
    if (owner.ownerType !== 'user' || !owner.deviceId || owner.deviceId === 'anonymous') {
      return ok(res, { ...base, ownerType: owner.ownerType });
    }
    const dev = tokenMeter.stats({ range, deviceId: owner.deviceId }); // 匿名段（裸 deviceId 键）
    const mergeAgg = (a, b) => ({
      prompt: a.prompt + b.prompt,
      completion: a.completion + b.completion,
      total: a.total + b.total,
      costCny: Number((a.costCny + b.costCny).toFixed(6)),
      calls: a.calls + b.calls,
    });
    const mergeMap = (list, key) => {
      const m = new Map();
      for (const it of list) {
        const o = m.get(it[key]);
        if (o) {
          o.prompt += it.prompt; o.completion += it.completion; o.total += it.total;
          o.costCny = Number((o.costCny + it.costCny).toFixed(6)); o.calls += it.calls;
        } else m.set(it[key], { ...it });
      }
      const sortFn = key === 'day'
        ? (a, b) => (a.day < b.day ? -1 : 1)
        : (a, b) => b.total - a.total;
      return Array.from(m.values()).sort(sortFn);
    };
    const usedToday = base.quota.usedToday + dev.quota.usedToday;
    return ok(res, {
      range: base.range,
      total: mergeAgg(base.total, dev.total),
      allTime: mergeAgg(base.allTime, dev.allTime),
      quota: {
        daily: base.quota.daily,
        usedToday,
        remainToday: Math.max(0, base.quota.daily - usedToday),
      },
      byDay: mergeMap([...base.byDay, ...dev.byDay], 'day'),
      byModel: mergeMap([...base.byModel, ...dev.byModel], 'model'),
      ownerType: owner.ownerType,
      mergedDevice: owner.deviceId, // 已并入的本机匿名段标识
    });
  },

  /** GET /api/v1/token/quota */
  'GET /token/quota': async (req, res) => ok(res, tokenMeter.getQuota()),

  /** POST /api/v1/token/quota  { daily } （管理端） */
  'POST /token/quota': async (req, res, q, body) => {
    const daily = Number((body || {}).daily);
    if (!Number.isFinite(daily) || daily <= 0) return fail(res, 1001, 'daily 必须为正数');
    return ok(res, tokenMeter.setQuota(daily));
  },

  /** POST /api/v1/token/estimate  { text } —— 端上预估消耗，避免超配额 */
  'POST /token/estimate': async (req, res, q, body) => {
    const text = String((body || {}).text || '');
    const prompt = tokenMeter.estimate(text);
    const { daily } = tokenMeter.getQuota();
    const today = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const day = `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`;
    const used = (require('../services/store').collection('tokens', []).all())
      .filter((x) => x.day === day)
      .reduce((a, b) => a + b.total, 0);
    return ok(res, { promptEstimate: prompt, quotaDaily: daily, usedToday: used, remainToday: Math.max(0, daily - used) });
  },
};
