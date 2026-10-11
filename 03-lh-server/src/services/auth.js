/**
 * 鲤慧 LiHui · RBAC 鉴权核心（零依赖，纯 Node 标准库）
 *
 * 角色：guest(0, 匿名) < user(1) < admin(2)
 *  - 密码：crypto.scrypt 加盐哈希（timingSafeEqual 防时序）
 *  - 令牌：HMAC-SHA256 签名的不透明 token（类 JWT，无需第三方库），载荷含 iat/exp
 *  - 用户：store.collection('users') 持久化
 *  - 默认管理员：首次启动从 config.auth.adminUser/adminPass 播种（仅当库内无用户时）
 *
 * 设计要点：
 *  - 全程零 npm 依赖，契合「服务端纯 Node 标准库」约束。
 *  - 令牌无状态：服务端不存会话，吊销靠缩短 TTL 或轮换 LH_AUTH_SECRET。
 *  - 中间件（app.js）按 ROUTE_ROLE 表对路由施加最低角色；本文件只负责签发/校验/存储。
 */
const crypto = require('crypto');
const config = require('../config');
const store = require('./store');
const logger = require('../utils/logger');

const ROLE = { guest: 0, user: 1, admin: 2 };
const ROLE_NAME = { 0: 'guest', 1: 'user', 2: 'admin' };

/* ---------------- 令牌签名密钥 ---------------- */
function tokenSecret() {
  const s = (config.auth && config.auth.secret) || process.env.LH_AUTH_SECRET || '';
  if (s && s.length >= 16) return s;
  // 无配置时的退化密钥：仅本地开发，重启即失效（告警）
  logger.warn('auth', '未配置 LH_AUTH_SECRET，使用进程内退化密钥（重启失效，生产务必配置 ≥16 位密钥）');
  return 'lihui-dev-secret-' + (process.env.LH_DATA_DIR || 'default');
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlStr(s) {
  return Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

/* ---------------- 密码哈希（scrypt） ---------------- */
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 64);
  return b64url(salt) + ':' + b64url(hash);
}
function verifyPassword(pw, stored) {
  if (typeof stored !== 'string' || !stored.includes(':')) return false;
  const [saltB64, hashB64] = stored.split(':');
  let salt, expected;
  try {
    salt = fromB64url(saltB64);
    expected = fromB64url(hashB64);
  } catch (_) {
    return false;
  }
  let actual;
  try {
    actual = crypto.scryptSync(String(pw), salt, 64);
  } catch (_) {
    return false;
  }
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

/* ---------------- 令牌签发 / 校验 ---------------- */
function issueToken({ uid, username, role }) {
  const secret = tokenSecret();
  const ttl = (config.auth && config.auth.tokenTtlMs) || 7 * 24 * 3600 * 1000;
  const now = Date.now();
  const claims = { uid, u: username, r: role, iat: now, exp: now + ttl };
  const payload = b64urlStr(JSON.stringify(claims));
  const sig = b64url(crypto.createHmac('sha256', secret).update(payload).digest());
  return `${payload}.${sig}`;
}
function verifyToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const secret = tokenSecret();
  let expect;
  try {
    expect = b64url(crypto.createHmac('sha256', secret).update(payload).digest());
  } catch (_) {
    return null;
  }
  if (sig.length !== expect.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  } catch (_) {
    return null;
  }
  let claims;
  try {
    claims = JSON.parse(fromB64url(payload).toString('utf8'));
  } catch (_) {
    return null;
  }
  if (!claims || !claims.uid || typeof claims.r !== 'number') return null;
  if (!claims.exp || Date.now() > claims.exp) return null;
  return { uid: claims.uid, username: claims.u, role: claims.r, rank: claims.r, exp: claims.exp };
}

/* ---------------- 用户存储 ---------------- */
function users() {
  return store.collection('users', []);
}
function getUserByName(name) {
  return users().find((u) => u.username === String(name));
}
function getUserById(id) {
  return users().find((u) => u.id === id);
}
function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    role: ROLE_NAME[u.role] || 'guest',
    createdAt: u.createdAt,
    nickname: u.nickname || '',
    avatar: u.avatar || '',
  };
}

/* ---------------- 个人资料（昵称 / 头像，2026-10） ----------------
 * 头像以 dataURL（base64）直接存用户记录：
 *  · 量级合适——单枚压缩后头像 ~几十 KB，users.json 是低频写的小库；
 *  · 零依赖——不引文件路由 / 静态目录，端上 <image src="{{dataURL}}"> 可直接显示。
 * 上限：base64 全长 ≤ 256KB（约 190KB 二进制），超限拒绝，防止 users.json 被撑爆。 */
const NICKNAME_MAX = 24;
const AVATAR_MAX_CHARS = 256 * 1024;
const AVATAR_RE = /^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/;

function updateProfile(uid, patch = {}) {
  const u = getUserById(uid);
  if (!u) return { error: '用户不存在' };
  const p = {};
  if (patch.nickname !== undefined) {
    const nick = String(patch.nickname || '').trim();
    if (!nick) return { error: '昵称不能为空' };
    if (nick.length > NICKNAME_MAX) return { error: `昵称最多 ${NICKNAME_MAX} 个字符` };
    p.nickname = nick;
  }
  if (patch.avatar !== undefined) {
    const av = String(patch.avatar || '');
    if (av === '') {
      p.avatar = ''; // 允许清空头像，回落默认「鲤」字
    } else {
      if (!AVATAR_RE.test(av)) return { error: '头像必须是 png/jpg/webp 图片（dataURL）' };
      if (av.length > AVATAR_MAX_CHARS) return { error: '头像太大（超过 190KB），请换小图' };
      p.avatar = av;
    }
  }
  if (!Object.keys(p).length) return { error: '没有要修改的内容' };
  const out = users().update(uid, p);
  return { user: publicUser(out || u) };
}
function createUser({ username, password, role }) {
  username = String(username || '').trim();
  if (username.length < 3) return { error: '用户名至少 3 个字符' };
  if (String(password || '').length < 6) return { error: '密码至少 6 个字符' };
  if (getUserByName(username)) return { error: '用户名已存在' };
  const r = role === 'admin' ? ROLE.admin : ROLE.user;
  const u = {
    id: store.uid('u'),
    username,
    passwordHash: hashPassword(password),
    role: r,
    createdAt: new Date().toISOString(),
  };
  users().add(u);
  return { user: publicUser(u) };
}

/**
 * 校验登录凭据，返回 { token, user } 或 { error }。
 */
function authenticate(username, password) {
  const u = getUserByName(String(username || '').trim());
  if (!u || !verifyPassword(password, u.passwordHash)) {
    return { error: '用户名或密码错误' };
  }
  if (u.disabled) return { error: '账号已被停用，请联系管理员' };
  const token = issueToken({ uid: u.id, username: u.username, role: u.role });
  return { token, user: publicUser(u) };
}

/* ---------------- 用户管理（V1.1 · admin 专属，/admin/users 端点配套） ---------------- */
/** 全量用户列表（含停用状态；绝不外泄 passwordHash） */
function listUsers() {
  return users()
    .all()
    .map((u) => ({
      ...publicUser(u),
      disabled: !!u.disabled,
      seeded: !!u.seeded,
    }));
}

/** 停用 / 恢复账号。返回 { error } 或 { user }。 */
function setUserDisabled(id, disabled) {
  const u = getUserById(id);
  if (!u) return { error: '用户不存在' };
  if (u.seeded) return { error: '播种管理员不可停用（如需回收请改口令）' };
  const out = users().update(id, { disabled: !!disabled });
  return { user: publicUser(out || u) };
}

/** 删除账号。守卫：不能删自己、不能删播种管理员、不能删最后一个 admin。 */
function deleteUser(id, actorId) {
  const u = getUserById(id);
  if (!u) return { error: '用户不存在' };
  if (actorId && id === actorId) return { error: '不能删除当前登录的自己' };
  if (u.seeded) return { error: '播种管理员不可删除' };
  if (u.role === ROLE.admin) {
    const admins = users().all().filter((x) => x.role === ROLE.admin && !x.disabled);
    if (admins.length <= 1) return { error: '不能删除最后一个可用管理员' };
  }
  users().remove(id);
  return { removed: u.username };
}

/* ---------------- 启动播种（默认管理员） ---------------- */
/* issue #5：V1.0.28 及之前版本曾以公开常量 'lihui-admin-2026' 作为默认口令 ——
 * 生产漏配 LH_ADMIN_PASS 即成公开后门。现口径：
 *  ① 播种时未配置口令 → 自动生成随机口令，仅在启动日志打印一次；
 *  ② 检测到仍在用旧公开默认口令的账号 → 用 LH_ADMIN_PASS（若已配置）强制重置。 */
const LEGACY_DEFAULT_PASS = 'lihui-admin-2026';
function migrateLegacyDefaultPass() {
  const pass = (config.auth && config.auth.adminPass) || '';
  if (!pass) return;
  const legacy = users().all().find((u) => {
    try {
      return u && u.passwordHash && verifyPassword(LEGACY_DEFAULT_PASS, u.passwordHash);
    } catch (_) {
      return false;
    }
  });
  if (legacy) {
    users().update(legacy.id, { passwordHash: hashPassword(pass) });
    logger.warn('auth', `安全修复：账号 "${legacy.username}" 曾使用公开默认口令，已用 LH_ADMIN_PASS 重置。请用新口令重新登录。`);
  }
}
function bootstrapSeed() {
  migrateLegacyDefaultPass();
  if (users().all().length > 0) return;
  const name = (config.auth && config.auth.adminUser) || 'admin';
  let pass = (config.auth && config.auth.adminPass) || '';
  const generated = !pass;
  if (generated) pass = 'lh-' + crypto.randomBytes(9).toString('base64url');
  const u = {
    id: store.uid('u'),
    username: name,
    passwordHash: hashPassword(pass),
    role: ROLE.admin,
    createdAt: new Date().toISOString(),
    seeded: true,
  };
  users().add(u);
  if (generated) {
    logger.warn('auth', `未配置 LH_ADMIN_PASS，已自动生成随机管理员口令（仅此一次打印，请立即保存）: ${pass}`);
    logger.warn('auth', `建议尽快在环境变量写入 LH_ADMIN_PASS 固定口令，并设 LH_AUTH_ALLOW_REGISTER=false。`);
  } else {
    logger.info('auth', `已播种管理员 "${name}"（口令来自 LH_ADMIN_PASS）。建议设 LH_AUTH_ALLOW_REGISTER=false。`);
  }
}

/* ---------------- 请求解析 ---------------- */
function fromRequest(req) {
  // ① 标准 Authorization 头（本地 / 云托管直连 / 小程序 callContainer 通道）
  const h = (req.headers && req.headers['authorization']) || '';
  if (h.startsWith('Bearer ')) {
    const t = verifyToken(h.slice(7).trim());
    if (t) return t;
  }
  // ② X-Auth-Token 自定义头兜底（V1.0.14）：部分反向代理会剥标准 Authorization 头，
  //    自定义头按 RFC 透传不受影响（线上实测 X-Device-Id 到达而 Authorization 被剥）
  const alt = (req.headers && (req.headers['x-auth-token'] || req.headers['x-authorization'])) || '';
  if (alt) {
    const t = verifyToken(String(alt).replace(/^Bearer\s+/i, '').trim());
    if (t) return t;
  }
  return null; // 未登录或令牌无效 → 视为 guest
}

/* ---------------- 账号锚定（V1.0.14） ----------------
 * 用户数据的归属键：登录用户按「账号」锚定（user:<uid>），未登录按设备兜底（裸 deviceId，
 * 兼容历史 profiles/consents/tokenMeter 数据，零迁移）。
 * 效果：注册用户拥有独立数据沙箱——画像 / 同意 / Token 用量全部计入账号，
 * 换设备登录同一账号数据不丢；设备/联网信号只影响匿名态，不再锚定注册用户。
 * @param {object} req 已经过 app.js 鉴权中间件（req.auth 已挂载）
 * @param {object} [body] POST body（匿名时兜底取 body.deviceId）
 * @returns {{ ownerKey:string, ownerType:'user'|'device', userId:string|null, deviceId:string, username:string }}
 */
function resolveOwner(req, body) {
  const deviceId = String(
    (req.headers && req.headers['x-device-id']) ||
    (body && body.deviceId) ||
    ''
  ).trim() || 'anonymous';
  const a = req && req.auth;
  if (a && a.uid && a.uid !== 'loopback') {
    return { ownerKey: 'user:' + a.uid, ownerType: 'user', userId: a.uid, username: a.username || '', deviceId };
  }
  return { ownerKey: deviceId, ownerType: 'device', userId: null, username: '', deviceId };
}

module.exports = {
  ROLE,
  ROLE_NAME,
  hashPassword,
  verifyPassword,
  issueToken,
  verifyToken,
  createUser,
  updateProfile,
  authenticate,
  listUsers,
  setUserDisabled,
  deleteUser,
  getUserByName,
  getUserById,
  publicUser,
  fromRequest,
  resolveOwner,
  bootstrapSeed,
};
