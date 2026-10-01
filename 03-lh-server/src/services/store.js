/**
 * 鲤慧 LiHui · 本地 JSON 持久化（零依赖）
 * 所有数据落 data/*.json，可平滑迁移到云数据库
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

function read(name, fallback) {
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
}

function write(name, data) {
  const f = fileOf(name);
  try {
    fs.writeFileSync(f, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (e) {
    logger.error('store', `write ${name} failed: ${e.message}`);
    return false;
  }
}

function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** 集合式读写（数组） */
function collection(name, seed = []) {
  return {
    all() {
      const d = read(name, null);
      if (!Array.isArray(d)) {
        write(name, seed);
        return seed.slice();
      }
      return d;
    },
    save(list) {
      return write(name, list);
    },
    add(item) {
      const list = this.all();
      if (!item.id) item.id = uid(name.slice(0, 2));
      list.push(item);
      this.save(list);
      return item;
    },
    update(id, patch) {
      const list = this.all();
      const i = list.findIndex((x) => x.id === id);
      if (i < 0) return null;
      list[i] = { ...list[i], ...patch, id };
      this.save(list);
      return list[i];
    },
    remove(id) {
      const list = this.all();
      const next = list.filter((x) => x.id !== id);
      this.save(next);
      return list.length !== next.length;
    },
    find(pred) {
      return this.all().find(pred);
    },
  };
}

module.exports = { read, write, uid, collection, ensureDir, dataDir: config.dataDir };
