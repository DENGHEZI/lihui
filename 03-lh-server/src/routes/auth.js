/**
 * 鲤慧 LiHui · 鉴权路由（登录 / 注册 / 当前身份）
 *  - POST /api/v1/auth/login   { username, password } → { token, user }
 *  - POST /api/v1/auth/register { username, password, role? } → { token, user }（自注册仅 user）
 *  - GET  /api/v1/auth/me      （需 user 角色，middleware 已保证 req.auth 存在）
 */
const { ok, fail } = require('../utils/http');
const auth = require('../services/auth');
const config = require('../config');

module.exports = {
  /** POST /api/v1/auth/login */
  'POST /auth/login': async (req, res, q, body) => {
    const { username, password } = body || {};
    if (!username || !password) return fail(res, 1001, 'username 与 password 必填');
    const r = auth.authenticate(username, password);
    if (r.error) return fail(res, 4010, r.error, 401);
    return ok(res, {
      token: r.token,
      user: r.user,
      expiresInMs: (config.auth && config.auth.tokenTtlMs) || 7 * 24 * 3600 * 1000,
    });
  },

  /** POST /api/v1/auth/register —— 公开自注册仅允许 role=user；申请 admin 须由已登录管理员发起 */
  'POST /auth/register': async (req, res, q, body) => {
    if (config.auth && config.auth.allowRegister === false) {
      return fail(res, 4031, '公开注册已关闭（请联系管理员创建账号）', 403);
    }
    const { username, password, role } = body || {};
    const wantAdmin = String(role || '').toLowerCase() === 'admin';
    if (wantAdmin) {
      const me = auth.fromRequest(req);
      if (!me || me.role < auth.ROLE.admin) {
        return fail(res, 4031, '仅管理员可创建 admin 账号', 403);
      }
    }
    const r = auth.createUser({ username, password, role: wantAdmin ? 'admin' : 'user' });
    if (r.error) return fail(res, 1001, r.error, 400);
    // 注册即登录，返回令牌
    const login = auth.authenticate(username, password);
    if (login.error) return fail(res, 5000, '注册成功但自动登录失败', 500);
    return ok(res, { token: login.token, user: login.user });
  },

  /** GET /api/v1/auth/me（需 user 角色）—— 返回完整资料（含昵称/头像） */
  'GET /auth/me': async (req, res) => {
    const a = req.auth;
    if (!a) return fail(res, 4010, '未登录或令牌无效', 401);
    // 从库里读实时资料（令牌里只有 uid/username/role，昵称头像改过要最新值）
    const u = auth.getUserById(a.uid);
    return ok(res, u ? auth.publicUser(u) : { uid: a.uid, username: a.username, role: auth.ROLE_NAME[a.role] || 'guest' });
  },

  /**
   * POST /api/v1/auth/profile { nickname?, avatar? }（需 user 角色）
   *  · nickname：1~24 字符
   *  · avatar：png/jpg/webp 的 dataURL（base64 ≤ 190KB），传空串清除回落默认
   * 头像不需要文件上传通道——base64 直存用户记录，端上 <image> 直接显示。
   */
  'POST /auth/profile': async (req, res, q, body) => {
    const a = req.auth;
    if (!a) return fail(res, 4010, '未登录或令牌无效', 401);
    const b = body || {};
    if (b.nickname === undefined && b.avatar === undefined) {
      return fail(res, 1001, 'nickname / avatar 至少传一个');
    }
    const r = auth.updateProfile(a.uid, { nickname: b.nickname, avatar: b.avatar });
    if (r.error) return fail(res, 1001, r.error, 400);
    return ok(res, { user: r.user });
  },
};
