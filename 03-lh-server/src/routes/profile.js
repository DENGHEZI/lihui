/**
 * 鲤慧 LiHui · 用户画像路由(自动学习 · memory · 个性化定制)
 * 锚定方式（V1.0.14 账号锚定）：登录用户按 user:<uid> 计入账号（独立沙箱，
 * 换设备登录数据不丢）；未登录按设备匿名兜底（裸 deviceId，兼容历史数据）。
 * 匿名键不含手机号/轨迹/身份信息。
 */
const { ok, fail } = require('../utils/http');
const userProfile = require('../services/userProfile');
const auth = require('../services/auth');

const ownerOf = (req, q, body) => auth.resolveOwner(req, { ...(q || {}), ...(body || {}) });

module.exports = {
  /** POST /api/v1/profile/track  { deviceId?, event, payload? }
   *  event: search | chat_topic | poi_click | navigate | care_toggle | model_switch
   *  登录用户：数据计入账号沙箱（user:<uid>），body.deviceId 被忽略 */
  'POST /profile/track': async (req, res, q, body) => {
    const owner = ownerOf(req, q, body);
    const { event, payload } = body || {};
    if (!owner.ownerKey || owner.ownerKey === 'anonymous') return fail(res, 1001, 'deviceId 必填(header x-device-id 或 body)');
    if (!event) return fail(res, 1001, 'event 必填');
    userProfile.track(owner.ownerKey, event, payload || {});
    return ok(res, { learned: true, ownerType: owner.ownerType });
  },

  /** GET /api/v1/profile/me?deviceId= —— 端上展示「已学到的偏好」（登录即账号沙箱视角） */
  'GET /profile/me': async (req, res, q) => {
    const owner = ownerOf(req, q, {});
    if (!owner.ownerKey || owner.ownerKey === 'anonymous') return fail(res, 1001, 'deviceId 必填');
    return ok(res, { ...userProfile.snapshot(owner.ownerKey), ownerType: owner.ownerType });
  },

  /** POST /api/v1/profile/reset  { deviceId? } —— 一键清除我的画像(隐私)；登录清账号沙箱 */
  'POST /profile/reset': async (req, res, q, body) => {
    const owner = ownerOf(req, q, body);
    if (!owner.ownerKey || owner.ownerKey === 'anonymous') return fail(res, 1001, 'deviceId 必填');
    return ok(res, { cleared: userProfile.reset(owner.ownerKey), ownerType: owner.ownerType });
  },
};
