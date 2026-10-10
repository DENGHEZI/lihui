/**
 * 鲤慧 LiHui · 隐私合规路由
 *   GET  /privacy/policy            隐私政策（版本化全文）
 *   POST /privacy/consent           记录用户同意 { deviceId, version? }
 *   GET  /privacy/consent           查询同意状态 ?deviceId=
 *   POST /privacy/withdraw          撤回同意（停采 + 立即删除画像）
 *   GET  /privacy/export            数据导出（可携权）?deviceId=
 *   POST /privacy/delete            数据删除（被遗忘权）{ deviceId }
 *
 * 锚定（V1.0.14 账号锚定）：带 Authorization 的请求一律按账号沙箱（user:<uid>）
 * 记录/导出/删除，body.deviceId 被忽略；未登录按设备匿名键（裸 deviceId，兼容历史数据）。
 */
const { ok, fail } = require('../utils/http');
const privacy = require('../services/privacy');
const auth = require('../services/auth');

module.exports = {
  'GET /privacy/policy': async (req, res) => ok(res, privacy.POLICY),

  'POST /privacy/consent': async (req, res, q, body) => {
    const owner = auth.resolveOwner(req, body);
    if (!owner.ownerKey || owner.ownerKey === 'anonymous') return fail(res, 4000, '缺少 deviceId', 400);
    const version = (body && body.version) || privacy.PRIVACY_VERSION;
    const r = privacy.setConsent(owner.ownerKey, version);
    return ok(res, { deviceId: owner.ownerKey, ownerType: owner.ownerType, version, consented: !!r, consent: r });
  },

  'GET /privacy/consent': async (req, res, q) => {
    const owner = auth.resolveOwner(req, q);
    const key = owner.ownerType === 'user' ? owner.ownerKey : (q.deviceId || owner.ownerKey);
    if (!key || key === 'anonymous') return fail(res, 4000, '缺少 deviceId', 400);
    const c = privacy.getConsent(key);
    return ok(res, { deviceId: key, ownerType: owner.ownerType, consented: !!c, consent: c, requireConsent: privacy.requireConsent() });
  },

  'POST /privacy/withdraw': async (req, res, q, body) => {
    const owner = auth.resolveOwner(req, body);
    if (!owner.ownerKey || owner.ownerKey === 'anonymous') return fail(res, 4000, '缺少 deviceId', 400);
    const r = privacy.withdraw(owner.ownerKey);
    return ok(res, { deviceId: owner.ownerKey, ownerType: owner.ownerType, ...r, note: '已停止采集并删除你的画像数据；个性化功能将回到默认状态' });
  },

  'GET /privacy/export': async (req, res, q) => {
    const owner = auth.resolveOwner(req, q);
    const key = owner.ownerType === 'user' ? owner.ownerKey : (q.deviceId || owner.ownerKey);
    if (!key || key === 'anonymous') return fail(res, 4000, '缺少 deviceId', 400);
    return ok(res, privacy.exportData(key));
  },

  'POST /privacy/delete': async (req, res, q, body) => {
    const owner = auth.resolveOwner(req, body);
    if (!owner.ownerKey || owner.ownerKey === 'anonymous') return fail(res, 4000, '缺少 deviceId', 400);
    if ((body && body.confirm) !== 'DELETE') {
      return fail(res, 4000, '请携带 confirm:"DELETE" 确认删除（不可恢复）', 400);
    }
    return ok(res, privacy.deleteData(owner.ownerKey));
  },
};
