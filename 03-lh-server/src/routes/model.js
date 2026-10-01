/**
 * 鲤慧 LiHui · 用户自定义模型 / API 路由
 */
const { ok, fail, clientIp } = require('../utils/http');
const modelRegistry = require('../services/modelRegistry');

/** 仅本机请求可查看明文 Key（防止局域网/公网越权窃取用户配置的 API Key） */
function isLocalReq(req) {
  const ip = clientIp(req);
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || !ip;
}

module.exports = {
  /** GET /api/v1/model/list */
  'GET /model/list': async (req, res, q) => {
    return ok(res, { items: modelRegistry.list({ reveal: q.reveal === 'true' && isLocalReq(req) }), presets: modelRegistry.PRESETS.map((p) => ({ ...p, apiKey: '' })) });
  },

  /** POST /api/v1/model/save */
  'POST /model/save': async (req, res, q, body) => {
    const b = body || {};
    if (!b.model) return fail(res, 1001, 'model（模型名）必填');
    if (!b.name) return fail(res, 1001, 'name（显示名）必填');
    const item = modelRegistry.save(b);
    return ok(res, { ...item, apiKey: item.apiKey ? item.apiKey.slice(0, 4) + '****' : '' });
  },

  /** POST /api/v1/model/test  { id } */
  'POST /model/test': async (req, res, q, body) => {
    const b = body || {};
    if (b.id && !modelRegistry.get(b.id)) return fail(res, 1001, '模型不存在');
    // 支持「不入库先测试」：直接传 provider/baseUrl/apiKey/model
    if (!b.id && b.baseUrl) {
      const tmp = modelRegistry.save({ ...b, name: b.name || '__tmp_test__', isDefault: false, enabled: true });
      const r = await modelRegistry.test(tmp.id);
      modelRegistry.remove(tmp.id);
      return ok(res, r);
    }
    const r = await modelRegistry.test(b.id || (modelRegistry.active() || {}).id);
    return ok(res, r);
  },

  /** POST /api/v1/model/default  { id } */
  'POST /model/default': async (req, res, q, body) => {
    if (!body || !body.id) return fail(res, 1001, 'id 必填');
    const r = modelRegistry.setDefault(body.id);
    if (!r) return fail(res, 1001, '模型不存在');
    return ok(res, { id: r.id, name: r.name, model: r.model });
  },

  /** POST /api/v1/model/remove  { id } */
  'POST /model/remove': async (req, res, q, body) => {
    if (!body || !body.id) return fail(res, 1001, 'id 必填');
    return ok(res, { removed: !!modelRegistry.remove(body.id) });
  },

  /** GET /api/v1/model/active */
  'GET /model/active': async (req, res) => {
    const a = modelRegistry.active();
    if (!a) return ok(res, null);
    return ok(res, { id: a.id, name: a.name, provider: a.provider, model: a.model, baseUrl: a.baseUrl, hasKey: !!a.apiKey });
  },
};
