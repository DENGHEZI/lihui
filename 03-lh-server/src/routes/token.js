/**
 * 鲤慧 LiHui · Token 计量与配额路由
 */
const { ok, fail, clientIp } = require('../utils/http');
const tokenMeter = require('../services/tokenMeter');

module.exports = {
  /** GET /api/v1/token/stats?range=7d */
  'GET /token/stats': async (req, res, q) => {
    const deviceId = q.deviceId || req.headers['x-device-id'] || '';
    return ok(res, tokenMeter.stats({ range: q.range || '7d', deviceId }));
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
