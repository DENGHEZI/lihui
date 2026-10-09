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
  return { id: u.id, username: u.username, role: ROLE_NAME[u.role] || 'guest', createdAt: u.createdAt };
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
  const token = issueToken({ uid: u.id, username: u.username, role: u.role });
  return { token, user: publicUser(u) };
}

/* ---------------- 启动播种（默认管理员） ---------------- */
function bootstrapSeed() {
  if (users().all().length > 0) return;
  const name = (config.auth && config.auth.adminUser) || 'admin';
  const pass = (config.auth && config.auth.adminPass) || 'lihui-admin-2026';
  const u = {
    id: store.uid('u'),
    username: name,
    passwordHash: hashPassword(pass),
    role: ROLE.admin,
    createdAt: new Date().toISOString(),
    seeded: true,
  };
  users().add(u);
  logger.info('auth', `已播种默认管理员 "${name}"（角色 admin）。建议尽快配置 LH_ADMIN_PASS 修改口令，并设 LH_AUTH_ALLOW_REGISTER=false。`);
}

/* ---------------- 请求解析 ---------------- */
function fromRequest(req) {
  const h = (req.headers && req.headers['authorization']) || '';
  if (h.startsWith('Bearer ')) {
    const t = verifyToken(h.slice(7).trim());
    if (t) return t;
  }
  return null; // 未登录或令牌无效 → 视为 guest
}

module.exports = {
  ROLE,
  ROLE_NAME,
  hashPassword,
  verifyPassword,
  issueToken,
  verifyToken,
  createUser,
  authenticate,
  getUserByName,
  getUserById,
  publicUser,
  fromRequest,
  bootstrapSeed,
};
