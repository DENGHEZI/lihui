/**
 * 鲤慧 LiHui · 统一存储层（零依赖，双驱动）
 *
 * 所有业务数据（集合与文档）统一经由本模块读写，驱动可切换：
 *   - json（默认）：沿用 data/<name>.json 单文件，原子写（tmp+rename），单实例零改动兼容
 *   - sqlite：Node 22.13+ 内置 node:sqlite（无 npm 依赖），单库 docs 表 + WAL 模式，
 *     支持单机多进程（LH_WORKERS）与多实例共享卷部署 —— 分布式部署的基础设施
 *
 * 关键语义（两驱动一致，全部同步 API，调用点零改造）：
 *   read(name, fallback)        缺失/损坏返回 fallback
 *   write(name, data)           原子覆盖，返回 bool
 *   update(name, fn, fallback)  原子读改写：json=同步 RMW（单线程内无交错）；
 *                               sqlite=BEGIN IMMEDIATE 事务（跨进程安全）
 *   collection(name, seed)      数组集合；增删改全部走 update（跨进程原子）
 *
 * 平滑迁移（sqlite 首次启用时自动执行）：
 *   初始化时把 data/*.json（旧 JSON 存量）幂等导入 docs 表（已存在的 doc 跳过），
 *   之后 json 文件仅作为「种子/回退源」，SQLite 成为权威存储；
 *   切回 LH_STORE=json 即回旧存储（切走期间的增量不会回写 json，回切前请先备份）。
 *
 * 环境变量：
 *   LH_STORE=json|sqlite   存储驱动（默认 json）
 *   LH_DB_PATH=<路径>      sqlite 库文件（默认 data/lihui.db；多实例部署指向共享卷挂载点）
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('../utils/logger');

function ensureDir(p) {
  try {
    fs.mkdirSync(p, { recursive: true });
  } catch (_) {}
}
ensureDir(config.dataDir);

function fileOf(name) {
  return path.join(config.dataDir, name.endsWith('.json') ? name : name + '.json');
}

function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/* ================= JSON 驱动（原始行为，单实例） ================= */
const jsonApi = {
  driver: 'json',
  read(name, fallback) {
    const f = fileOf(name);
    try {
      if (!fs.existsSync(f)) return fallback;
      const txt = fs.readFileSync(f, 'utf8').trim();
      if (!txt) return fallback;
      return JSON.parse(txt);
    } catch (e) {
      logger.warn('store', `read ${name} failed: ${e.message}`);
      return fallback;
    }
  },
  write(name, data) {
    const f = fileOf(name);
    try {
      // 原子写：先写临时文件再 rename 覆盖。
      // 直接 writeFileSync 时，进程被杀/并发写/磁盘抖动都可能留下半个 JSON，
      // 下次 read 直接 JSON.parse 失败 → 静默回退 fallback，数据「凭空消失」。
      const tmp = f + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmp, f);
      return true;
    } catch (e) {
      logger.error('store', `write ${name} failed: ${e.message}`);
      return false;
    }
  },
  update(name, fn, fallback) {
    // 同步读改写：Node 单线程内 read→fn→write 三步之间不会交错，
    // 单进程内等价于原子操作；跨进程请用 sqlite 驱动（BEGIN IMMEDIATE）。
    try {
      const cur = this.read(name, fallback);
      const next = fn(cur);
      if (next === undefined) return true; // fn 视为「本次不改」
      return this.write(name, next);
    } catch (e) {
      logger.error('store', `update ${name} failed: ${e.message}`);
      return false;
    }
  },
};

/* ================= SQLite 驱动（node:sqlite 内置，多进程/多实例） ================= */
let db = null;
let stmtGet = null;
let stmtPut = null;
let stmtCount = null;

function openSqlite() {
  try {
    const { DatabaseSync } = require('node:sqlite');
    const d = new DatabaseSync(config.store.dbPath);
    // WAL：读写不互斥 + 多进程并发安全；busy_timeout：写锁竞争时等待而非立刻报错
    d.exec('PRAGMA journal_mode = WAL;');
    d.exec('PRAGMA synchronous = NORMAL;');
    d.exec('PRAGMA busy_timeout = 5000;');
    d.exec('CREATE TABLE IF NOT EXISTS docs (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
    return d;
  } catch (e) {
    logger.error('store', `sqlite 驱动初始化失败（需 Node ≥22.13），已自动回退 json 驱动: ${e.message}`);
    return null;
  }
}

function prep() {
  if (!stmtGet) {
    stmtGet = db.prepare('SELECT value FROM docs WHERE name = ?');
    stmtPut = db.prepare(
      'INSERT INTO docs(name, value, updated_at) VALUES(?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
    );
    stmtCount = db.prepare('SELECT COUNT(*) AS c FROM docs');
  }
}

function getRaw(name) {
  prep();
  const row = stmtGet.get(String(name));
  return row === undefined ? undefined : JSON.parse(row.value);
}

function putRaw(name, value) {
  prep();
  stmtPut.run(String(name), JSON.stringify(value), Date.now());
}

/** 从旧 JSON 文件导入单个文档（幂等，仅当库里没有时）；返回导入值或 undefined */
function importLegacyOne(name) {
  const f = fileOf(name);
  try {
    if (!fs.existsSync(f)) return undefined;
    const txt = fs.readFileSync(f, 'utf8').trim();
    if (!txt) return undefined;
    const val = JSON.parse(txt);
    putRaw(name, val);
    return val;
  } catch (e) {
    logger.warn('store', `旧 JSON 导入 ${name} 失败（按缺失处理）: ${e.message}`);
    return undefined;
  }
}

/** 启动时全量导入 data/*.json 存量（幂等：库里已有的 doc 跳过） */
function importLegacyAll() {
  try {
    const files = fs.readdirSync(config.dataDir).filter((f) => f.endsWith('.json'));
    let n = 0;
    for (const f of files) {
      const name = f.replace(/\.json$/, '');
      if (getRaw(name) !== undefined) continue; // 已存在，跳过
      const txt = fs.readFileSync(path.join(config.dataDir, f), 'utf8').trim();
      if (!txt) continue;
      putRaw(name, JSON.parse(txt));
      n += 1;
    }
    if (n) logger.info('store', `sqlite 模式：已从旧 JSON 平滑导入 ${n} 个文档 → ${config.store.dbPath}`);
  } catch (e) {
    logger.warn('store', `旧 JSON 全量导入失败（忽略，首次读取时仍会按 doc 逐个补导）: ${e.message}`);
  }
}

const sqliteApi = {
  driver: 'sqlite',
  read(name, fallback) {
    try {
      const v = getRaw(name);
      if (v !== undefined) return v;
      // 库里没有 → 尝试从旧 JSON 导入（平滑迁移，透明回源）
      const legacy = importLegacyOne(name);
      return legacy === undefined ? fallback : legacy;
    } catch (e) {
      logger.warn('store', `sqlite read ${name} failed: ${e.message}`);
      return fallback;
    }
  },
  write(name, data) {
    try {
      putRaw(name, data);
      return true;
    } catch (e) {
      logger.error('store', `sqlite write ${name} failed: ${e.message}`);
      return false;
    }
  },
  update(name, fn, fallback) {
    // BEGIN IMMEDIATE：拿到写锁后再读，fn 改完写回，同一事务内跨进程原子
    try {
      db.exec('BEGIN IMMEDIATE');
      let cur = getRaw(name);
      if (cur === undefined) cur = importLegacyOne(name);
      if (cur === undefined) cur = typeof fallback === 'function' ? fallback() : fallback;
      const next = fn(cur);
      if (next !== undefined) putRaw(name, next);
      db.exec('COMMIT');
      return true;
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch (_) {}
      logger.error('store', `sqlite update ${name} failed: ${e.message}`);
      return false;
    }
  },
};

/* ================= 驱动选择 ================= */
let activeDriver = config.store.driver;
if (activeDriver === 'sqlite') {
  db = openSqlite();
  if (db) importLegacyAll();
  else activeDriver = 'json'; // node:sqlite 不可用（旧 Node）→ 无感回退
}
const api = activeDriver === 'sqlite' ? sqliteApi : jsonApi;

function stats() {
  const s = { driver: activeDriver, dataDir: config.dataDir };
  if (activeDriver === 'sqlite') {
    s.dbPath = config.store.dbPath;
    try {
      prep();
      s.docs = stmtCount.get().c;
    } catch (_) {}
  }
  return s;
}

/* ================= 集合（数组）语义 ================= */
/** 集合式读写（数组）。增删改统一走 update —— sqlite 模式下跨进程原子 */
function collection(name, seed = []) {
  return {
    all() {
      const d = api.read(name, null);
      if (!Array.isArray(d)) {
        api.write(name, seed);
        return seed.slice();
      }
      return d;
    },
    save(list) {
      return api.write(name, list);
    },
    add(item) {
      let added = null;
      api.update(
        name,
        (list) => {
          const arr = Array.isArray(list) ? list : seed.slice();
          if (!item.id) item.id = uid(name.slice(0, 2));
          arr.push(item);
          added = item;
          return arr;
        },
        seed
      );
      return added;
    },
    update(id, patch) {
      let out = null;
      api.update(
        name,
        (list) => {
          const arr = Array.isArray(list) ? list : seed.slice();
          const i = arr.findIndex((x) => x.id === id);
          if (i >= 0) {
            arr[i] = { ...arr[i], ...patch, id };
            out = arr[i];
          }
          return arr;
        },
        seed
      );
      return out;
    },
    remove(id) {
      let removed = false;
      api.update(
        name,
        (list) => {
          const arr = Array.isArray(list) ? list : seed.slice();
          const next = arr.filter((x) => x.id !== id);
          removed = next.length !== arr.length;
          return next;
        },
        seed
      );
      return removed;
    },
    find(pred) {
      return this.all().find(pred);
    },
  };
}

module.exports = {
  read: (name, fallback) => api.read(name, fallback),
  write: (name, data) => api.write(name, data),
  update: (name, fn, fallback) => api.update(name, fn, fallback),
  uid,
  collection,
  ensureDir,
  dataDir: config.dataDir,
  stats,
  driver: activeDriver,
};
