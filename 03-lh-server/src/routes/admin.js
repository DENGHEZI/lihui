/**
 * 鲤慧 LiHui · 管理端用户管理路由（V1.1）
 * 全部 admin 专属（ROUTE_ROLE 闸门）；每个变更操作写 RBAC 审计日志（services/audit.js）。
 */
const { ok, fail } = require('../utils/http');
const auth = require('../services/auth');
const audit = require('../services/audit');
const { clientIp } = require('../utils/http');

function actor(req) {
  return req.auth || { uid: 'loopback', username: 'loopback', role: auth.ROLE.admin };
}

module.exports = {
  /** GET /api/v1/admin/users —— 全量用户列表（含停用状态，不含口令哈希） */
  'GET /admin/users': async (req, res) => {
    const me = actor(req);
    audit.log('user.list', { actor: me.username, actorRole: auth.ROLE_NAME[me.role], route: 'GET /admin/users', ip: clientIp(req).ip });
    return ok(res, { users: auth.listUsers(), total: auth.listUsers().length });
  },

  /** POST /api/v1/admin/users/disable  body: { id, disabled } */
  'POST /admin/users/disable': async (req, res, q, body) => {
    const me = actor(req);
    const id = String((body || {}).id || '').trim();
    const disabled = !!(body || {}).disabled;
    if (!id) return fail(res, 1001, 'id 必填');
    if (id === me.uid) return fail(res, 4032, '不能停用当前登录的自己');
    const r = auth.setUserDisabled(id, disabled);
    if (r.error) return fail(res, 4004, r.error);
    audit.log(disabled ? 'user.disable' : 'user.enable', {
      actor: me.username,
      actorRole: auth.ROLE_NAME[me.role],
      target: r.user.username + '(' + id + ')',
      route: 'POST /admin/users/disable',
      ip: clientIp(req).ip,
    });
    return ok(res, r.user);
  },

  /** POST /api/v1/admin/users/delete  body: { id } */
  'POST /admin/users/delete': async (req, res, q, body) => {
    const me = actor(req);
    const id = String((body || {}).id || '').trim();
    if (!id) return fail(res, 1001, 'id 必填');
    const r = auth.deleteUser(id, me.uid);
    if (r.error) return fail(res, 4004, r.error);
    audit.log('user.delete', {
      actor: me.username,
      actorRole: auth.ROLE_NAME[me.role],
      target: r.removed + '(' + id + ')',
      route: 'POST /admin/users/delete',
      ip: clientIp(req).ip,
    });
    return ok(res, { removed: r.removed });
  },

  /** GET /api/v1/admin/audit?n=100 —— 审计日志（新→旧） */
  'GET /admin/audit': async (req, res, q) => {
    const me = actor(req);
    const n = Math.min(500, Math.max(1, Number(q && q.n) || 100));
    return ok(res, { events: audit.recent(n) });
  },
};
