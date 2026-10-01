/**
 * 鲤慧 LiHui · 用户反馈路由（端上提交 → 管理端处理）
 */
const { ok, fail } = require('../utils/http');
const store = require('../services/store');

const col = store.collection('feedback', []);

module.exports = {
  /** POST /api/v1/feedback */
  'POST /feedback': async (req, res, q, body) => {
    const b = body || {};
    if (!b.content) return fail(res, 1001, 'content 必填');
    const item = col.add({
      id: store.uid('fb'),
      deviceId: b.deviceId || req.headers['x-device-id'] || 'anonymous',
      type: ['bug', 'feature', 'complaint', 'praise'].includes(b.type) ? b.type : 'bug',
      content: String(b.content).slice(0, 2000),
      contact: b.contact || '',
      screenshots: Array.isArray(b.screenshots) ? b.screenshots.slice(0, 6) : [],
      page: b.page || '',
      appVersion: b.appVersion || '',
      platform: b.platform || '',
      status: 'pending',
      reply: '',
      createdAt: new Date().toISOString(),
    });
    return ok(res, { id: item.id, status: item.status, createdAt: item.createdAt });
  },

  /** GET /api/v1/feedback/list?status=&page= */
  'GET /feedback/list': async (req, res, q) => {
    let list = col.all().slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    if (q.status) list = list.filter((x) => x.status === q.status);
    if (q.type) list = list.filter((x) => x.type === q.type);
    const total = list.length;
    const page = Number(q.page) || 1;
    const pageSize = Number(q.pageSize) || 20;
    return ok(res, { total, page, pageSize, items: list.slice((page - 1) * pageSize, page * pageSize) });
  },

  /** GET /api/v1/feedback/detail?id= */
  'GET /feedback/detail': async (req, res, q) => {
    const it = col.find((x) => x.id === q.id);
    if (!it) return fail(res, 1001, '反馈不存在');
    return ok(res, it);
  },

  /** POST /api/v1/feedback/handle  { id, status, reply } */
  'POST /feedback/handle': async (req, res, q, body) => {
    const b = body || {};
    if (!b.id) return fail(res, 1001, 'id 必填');
    const it = col.update(b.id, {
      status: ['pending', 'processing', 'resolved', 'rejected'].includes(b.status) ? b.status : 'processing',
      reply: b.reply || '',
      handledAt: new Date().toISOString(),
    });
    if (!it) return fail(res, 1001, '反馈不存在');
    return ok(res, it);
  },

  /** GET /api/v1/feedback/summary —— 管理端看板 */
  'GET /feedback/summary': async (req, res) => {
    const all = col.all();
    const by = (k) => all.reduce((a, b) => ((a[b[k]] = (a[b[k]] || 0) + 1), a), {});
    return ok(res, { total: all.length, byStatus: by('status'), byType: by('type'), latest: all.slice(-5).reverse() });
  },
};
