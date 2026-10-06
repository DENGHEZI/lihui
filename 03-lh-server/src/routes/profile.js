/**
 * 鲤慧 LiHui · 用户画像路由(自动学习 · memory · 个性化定制)
 * 设备匿名(deviceId 由端上生成),不含手机号/轨迹/身份信息。
 */
const { ok, fail } = require('../utils/http');
const userProfile = require('../services/userProfile');

const devOf = (req, q, body) =>
  (body && body.deviceId) || q.deviceId || req.headers['x-device-id'] || '';

module.exports = {
  /** POST /api/v1/profile/track  { deviceId?, event, payload? }
   *  event: search | chat_topic | poi_click | navigate | care_toggle | model_switch */
  'POST /profile/track': async (req, res, q, body) => {
    const deviceId = devOf(req, q, body);
    const { event, payload } = body || {};
    if (!deviceId) return fail(res, 1001, 'deviceId 必填(header x-device-id 或 body)');
    if (!event) return fail(res, 1001, 'event 必填');
    userProfile.track(deviceId, event, payload || {});
    return ok(res, { learned: true });
  },

  /** GET /api/v1/profile/me?deviceId= —— 端上展示「已学到的偏好」 */
  'GET /profile/me': async (req, res, q) => {
    const deviceId = devOf(req, q, {});
    if (!deviceId) return fail(res, 1001, 'deviceId 必填');
    return ok(res, userProfile.snapshot(deviceId));
  },

  /** POST /api/v1/profile/reset  { deviceId? } —— 一键清除我的画像(隐私) */
  'POST /profile/reset': async (req, res, q, body) => {
    const deviceId = devOf(req, q, body);
    if (!deviceId) return fail(res, 1001, 'deviceId 必填');
    return ok(res, { cleared: userProfile.reset(deviceId) });
  },
};
