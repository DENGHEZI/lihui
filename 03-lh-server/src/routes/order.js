/**
 * 鲤慧 · 订单路由（留痕 + 跳第三方下单；鲤慧不收钱、不做库存）
 */
const { ok, fail } = require('../utils/http');
const order = require('../services/order');
const store = require('../services/store');

const { create, listByDevice, get, updateStatus, upsertFromClient } = order;
const deviceOf = (req, body) => (body && body.deviceId) || req.headers['x-device-id'] || '';

module.exports = {
  /** POST /api/v1/order/create { itemId, qty, spec, date, name, phone, remark, lng, lat } */
  'POST /order/create': async (req, res, q, body) => {
    const b = body || {};
    if (!b.itemId) return fail(res, 1001, 'itemId 必填');
    if (b.name && String(b.name).length > 40) return fail(res, 1001, '联系人过长');
    if (b.phone && !/^1[3-9]\d{9}$/.test(String(b.phone))) return fail(res, 1001, '手机号格式不正确');
    try {
      const o = create({
        ...b,
        deviceId: deviceOf(req, b),
        qty: Number(b.qty) || 1,
      });
      return ok(res, o);
    } catch (e) {
      return fail(res, e.code || 5000, e.message || '下单失败');
    }
  },

  /** GET /api/v1/order/list?deviceId=&status=&page= */
  'GET /order/list': async (req, res, q) => {
    const list = listByDevice(deviceOf(req, { deviceId: q.deviceId }), q);
    return ok(res, list);
  },

  /** GET /api/v1/order/detail?no=LH2026... */
  'GET /order/detail': async (req, res, q) => {
    if (!q.no) return fail(res, 1001, 'no 必填');
    const o = get(q.no);
    if (!o) return fail(res, 1004, '订单不存在');
    return ok(res, o);
  },

  /** POST /api/v1/order/status { no, status: paid|done|cancelled } */
  'POST /order/status': async (req, res, q, body) => {
    const b = body || {};
    if (!b.no) return fail(res, 1001, 'no 必填');
    if (!['paid', 'done', 'cancelled'].includes(b.status)) return fail(res, 1001, 'status 非法');
    const o = updateStatus(b.no, b.status);
    if (!o) return fail(res, 1004, '订单不存在或已取消');
    return ok(res, o);
  },

  /** POST /api/v1/order/sync —— 端上离线订单回补（以 no 去重） */
  'POST /order/sync': async (req, res, q, body) => {
    const r = upsertFromClient((body && body.orders) || []);
    return ok(res, r);
  },

  /** GET /api/v1/order/status-map —— 端上展示用的状态字典 */
  'GET /order/status-map': async (req, res) => ok(res, { items: order.STATUS }),
};
