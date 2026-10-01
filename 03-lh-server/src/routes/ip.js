/**
 * 鲤慧 LiHui · IP 自动锚定路由
 */
const { ok, fail, clientIp } = require('../utils/http');
const ipLocate = require('../services/ipLocate');

module.exports = {
  /**
   * GET /api/v1/ip/locate
   * 自动锚定用户 IP —— 无需任何参数
   */
  'GET /ip/locate': async (req, res, q) => {
    const { ip, local } = clientIp(req);
    const data = await ipLocate.locate(ip, { fallbackCity: q.city });
    data.local = local;
    return ok(res, data);
  },

  /** GET /api/v1/ip/raw  —— 只回显识别到的 IP（调试用） */
  'GET /ip/raw': async (req, res) => {
    const { ip, local } = clientIp(req);
    return ok(res, { ip, local, headers: { xff: req.headers['x-forwarded-for'] || '', xri: req.headers['x-real-ip'] || '' } });
  },

  /**
   * POST /api/v1/loc/report
   * 端上 GPS 校正回传
   */
  'POST /loc/report': async (req, res, q, body) => {
    const ip = (body && body.ip) || clientIp(req).ip;
    if (body.lng === undefined || body.lat === undefined) return fail(res, 1001, 'lng/lat 必填');
    ipLocate.report(ip, body.lng, body.lat, body.accuracy);
    return ok(res, { updated: true, ip });
  },
};
