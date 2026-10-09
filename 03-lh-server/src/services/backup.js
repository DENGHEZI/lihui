/**
 * 鲤慧 LiHui · 备份与恢复（零依赖）
 *
 * 背景：Docker 卷持久化 ≠ 备份 —— 误删 / 数据损坏 / 误操作覆盖后无路可退。
 * 本模块补上「定期备份 → 轮转保留 → 校验恢复」闭环：
 *   - create():   把 data/ 顶层 *.json（及 sqlite 库三件套）gzip 打包到
 *                 data/backups/<时间戳>/，写 manifest.json（文件清单 + sha256 + 字节数）
 *   - list():     备份列表（名称/时间/体积/文件数）
 *   - restore():  按 manifest 逐文件 gunzip + sha256 校验后覆盖回 data/
 *                 （只覆盖清单内文件，绝不动清单外文件 —— 恢复不引入未知内容）
 *   - start():    定时备份（LH_BACKUP_INTERVAL_H 小时，默认 24；0=关闭），保留 LH_BACKUP_KEEP 份（默认 14）
 *
 * 恢复演练（建议每月一次）：见 docs/backup-recovery.md。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const config = require('../config');
const logger = require('../utils/logger');

const NAME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/; // 2026-10-09T16-10-00，同时防路径穿越

function backupRoot() {
  return path.join(config.dataDir, 'backups');
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** 待备份文件：data/ 顶层 *.json + sqlite 库（含 -wal/-shm）。返回绝对路径数组 */
function sourceFiles() {
  let names = [];
  try {
    names = fs
      .readdirSync(config.dataDir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.json'))
      .map((e) => e.name);
  } catch (_) {}
  if (config.store.driver === 'sqlite') {
    for (const suffix of ['', '-wal', '-shm']) {
      const p = config.store.dbPath + suffix;
      if (fs.existsSync(p)) names.push(path.basename(p));
    }
  }
  return names.map((n) => path.join(config.dataDir, n));
}

/** 立即备份一次。返回 { name, dir, files, bytes } */
function create() {
  const name = stamp();
  const dir = path.join(backupRoot(), name);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = { name, at: Date.now(), driver: config.store.driver, files: [], bytes: 0 };
  for (const src of sourceFiles()) {
    const rel = path.basename(src);
    try {
      const raw = fs.readFileSync(src);
      const gz = zlib.gzipSync(raw);
      fs.writeFileSync(path.join(dir, rel + '.gz'), gz);
      manifest.files.push({ file: rel, bytes: raw.length, gzBytes: gz.length, sha256: sha256(raw) });
      manifest.bytes += gz.length;
    } catch (e) {
      // 单文件失败不拖垮整次备份，但必须在 manifest 里留痕（恢复时可见）
      manifest.files.push({ file: rel, error: e.message });
      logger.warn('backup', `备份 ${rel} 失败: ${e.message}`);
    }
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  prune(Number(process.env.LH_BACKUP_KEEP) || 14);
  logger.info('backup', `备份完成 ${name}：${manifest.files.length} 个文件，${(manifest.bytes / 1024).toFixed(1)}KB`);
  return { name, dir, files: manifest.files.length, bytes: manifest.bytes };
}

/** 轮转：只保留最近 keep 份 */
function prune(keep = 14) {
  const dirs = list();
  for (const old of dirs.slice(keep)) {
    try {
      fs.rmSync(path.join(backupRoot(), old.name), { recursive: true, force: true });
      logger.info('backup', `轮转清理旧备份 ${old.name}`);
    } catch (_) {}
  }
}

/** 备份列表（新→旧） */
function list() {
  const root = backupRoot();
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const name of fs.readdirSync(root)) {
    const mf = path.join(root, name, 'manifest.json');
    try {
      if (!NAME_RE.test(name) || !fs.existsSync(mf)) continue;
      const m = JSON.parse(fs.readFileSync(mf, utf8));
      out.push({ name, at: m.at, driver: m.driver, files: m.files.length, bytes: m.bytes });
    } catch (_) {}
  }
  return out.sort((a, b) => (a.name < b.name ? 1 : -1));
}

/** 读取某备份的 manifest（含每个文件的 sha256） */
function manifestOf(name) {
  if (!NAME_RE.test(name)) throw new Error('非法备份名');
  const mf = path.join(backupRoot(), name, 'manifest.json');
  if (!fs.existsSync(mf)) throw new Error(`备份不存在: ${name}`);
  return JSON.parse(fs.readFileSync(mf, 'utf8'));
}

/** 恢复：校验 sha256 后解压覆盖回 data/。只覆盖清单内文件；返回恢复明细 */
function restore(name) {
  const m = manifestOf(name);
  const dir = path.join(backupRoot(), name);
  const results = [];
  for (const f of m.files) {
    if (f.error || !f.sha256) {
      results.push({ file: f.file, ok: false, reason: f.error || '备份时即失败' });
      continue;
    }
    const gzPath = path.join(dir, f.file + '.gz');
    try {
      const raw = zlib.gunzipSync(fs.readFileSync(gzPath));
      if (sha256(raw) !== f.sha256) {
        results.push({ file: f.file, ok: false, reason: 'sha256 校验不一致（备份损坏）' });
        continue;
      }
      fs.writeFileSync(path.join(config.dataDir, f.file), raw);
      results.push({ file: f.file, ok: true, bytes: raw.length });
    } catch (e) {
      results.push({ file: f.file, ok: false, reason: e.message });
    }
  }
  const okCount = results.filter((r) => r.ok).length;
  logger.warn('backup', `恢复 ${name}：${okCount}/${results.length} 个文件已覆盖回 ${config.dataDir}（建议重启服务使内存态生效）`);
  return { name, restored: okCount, total: results.length, results, restartHint: true };
}

let timer = null;
function intervalHours() {
  const n = Number(process.env.LH_BACKUP_INTERVAL_H);
  return Number.isFinite(n) && process.env.LH_BACKUP_INTERVAL_H !== undefined && process.env.LH_BACKUP_INTERVAL_H !== '' ? n : 24;
}

/** 距上次备份是否已超过间隔（启动时判断是否补一次） */
function dueForBackup() {
  const h = intervalHours();
  if (h <= 0) return false;
  const dirs = list();
  if (!dirs.length) return true;
  return Date.now() - dirs[0].at > h * 3600 * 1000;
}

function start() {
  const h = intervalHours();
  if (timer || h <= 0) return;
  timer = setInterval(() => {
    try {
      create();
    } catch (e) {
      logger.warn('backup', `定时备份失败: ${e.message}`);
    }
  }, h * 3600 * 1000);
  timer.unref();
  logger.info('backup', `定期备份已启动（每 ${h}h 一次，保留 ${Number(process.env.LH_BACKUP_KEEP) || 14} 份）`);
  if (dueForBackup()) setTimeout(() => { try { create(); } catch (_) {} }, 30000).unref();
}

module.exports = { create, list, restore, manifestOf, prune, start, dueForBackup, sourceFiles, backupRoot };
