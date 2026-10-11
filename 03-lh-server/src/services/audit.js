/**
 * 鲤慧 LiHui · RBAC 审计日志（V1.1，零依赖）
 *
 * 记录两类事件：
 *  ① 管理员显式操作（用户管理：停用/删除/角色变更等，含目标与详情）
 *  ② admin 级端点访问（app.js 中间件在角色闸门放行 admin 请求时落一条 access）
 *
 * 存储：data/audit.json 环形截断（保留最近 500 条），内存优先写避免并发覆盖。
 * 读取：GET /admin/audit（admin 专属）。
 */
const store = require('./store');
const logger = require('../utils/logger');

const FILE = 'audit';
const MEM = new Map(); // key → { ts, val }（单文件小库，Map 保插入序即可）
const MAX = 500;
let memKey = 'events';

function load() {
  if (MEM.has(memKey)) return MEM.get(memKey).val;
  let arr = [];
  try {
    const disk = store.read(FILE, []);
    if (Array.isArray(disk)) arr = disk;
  } catch (_) { /* 空库 */ }
  MEM.set(memKey, { ts: Date.now(), val: arr });
  return arr;
}

function persist(arr) {
  try {
    store.write(FILE, arr);
  } catch (e) {
    logger.warn('audit', `落盘失败（不影响内存）: ${e.message}`);
  }
}

/**
 * 写一条审计日志。
 * @param {string} action 动作名（如 'user.disable' / 'access' / 'user.delete'）
 * @param {object} [o] { actor, actorRole, target, detail, ip, route }
 */
function log(action, o = {}) {
  const arr = load();
  const entry = {
    ts: new Date().toISOString(),
    action: String(action || '').slice(0, 64),
    actor: String(o.actor || 'system').slice(0, 64),
    actorRole: o.actorRole == null ? undefined : String(o.actorRole).slice(0, 16),
    target: o.target == null ? undefined : String(o.target).slice(0, 96),
    route: o.route == null ? undefined : String(o.route).slice(0, 96),
    ip: o.ip == null ? undefined : String(o.ip).slice(0, 64),
    detail: o.detail == null ? undefined : String(o.detail).slice(0, 300),
  };
  arr.push(entry);
  while (arr.length > MAX) arr.shift();
  MEM.set(memKey, { ts: Date.now(), val: arr });
  persist(arr);
  logger.info('audit', `${entry.action} actor=${entry.actor}${entry.target ? ' target=' + entry.target : ''}`);
  return entry;
}

/** 最近 n 条（新→旧） */
function recent(n = 100) {
  const arr = load();
  return arr.slice(-Math.min(Math.max(1, n), MAX)).reverse();
}

module.exports = { log, recent };
