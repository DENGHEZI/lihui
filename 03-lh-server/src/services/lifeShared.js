/**
 * 鲤慧 LiHui · 15 分钟生活圈共享件
 * 六类设施口径 + 百度配额熔断 + 单类设施检索
 * （life 路由与 isochrone 等时圈引擎共用；独立成模块避免循环依赖：
 *   life.js → isochrone.js → lifeShared.js，life.js → lifeShared.js）
 */
const baiduMap = require('./baiduMap');
const logger = require('../utils/logger');

/** 六类设施口径（权重合计 1.0；need = 15 分钟内达标线「处数」，用于旧版体检计分） */
const CATEGORIES = [
  { key: 'medical', name: '医疗', weight: 0.25, keywords: ['医院', '社区卫生服务中心', '药店'], need: 2 },
  { key: 'education', name: '教育', weight: 0.15, keywords: ['幼儿园', '小学', '中学'], need: 1 },
  { key: 'market', name: '商业', weight: 0.2, keywords: ['超市', '菜市场', '便利店'], need: 2 },
  { key: 'food', name: '餐饮', weight: 0.1, keywords: ['餐厅', '早餐店'], need: 3 },
  { key: 'transit', name: '交通', weight: 0.2, keywords: ['公交', '地铁站', '停车场'], need: 1 },
  { key: 'leisure', name: '休闲', weight: 0.1, keywords: ['公园', '广场', '体育'], need: 1 },
];

/* ------------------------------------------------------------------ */
/* 配额熔断：百度 302(天配额超限)/401(并发超限) 后 10 分钟内短路检索     */
/* ------------------------------------------------------------------ */
let quotaBlockedUntil = 0;
function isQuotaBlocked() {
  return Date.now() < quotaBlockedUntil;
}
function noteQuotaError(e) {
  if (e && (e.baiduStatus === 302 || e.baiduStatus === 401)) {
    quotaBlockedUntil = Date.now() + 10 * 60 * 1000;
    logger.warn('life', `baidu quota blocked (status=${e.baiduStatus}), 熔断 10 分钟`);
    return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* POI 共享缓存：同（类目前缀 + 量化坐标 + 半径）5 分钟内直接复用结果    */
/* —— /life/report 与 isochrone 六类检索口径相近，重复请求不再重烧配额与延迟 */
/* 调用方对 items 只读（filter/map 生成新数组），缓存存引用即可          */
/* ------------------------------------------------------------------ */
const POI_CACHE_TTL = 5 * 60 * 1000;
const poiCache = new Map(); // key → { at, val }
function poiCacheGet(key) {
  const hit = poiCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > POI_CACHE_TTL) {
    poiCache.delete(key);
    return null;
  }
  return hit.val;
}
function poiCacheSet(key, val) {
  if (poiCache.size >= 128) poiCache.delete(poiCache.keys().next().value); // 简单防膨胀：清最旧
  poiCache.set(key, { at: Date.now(), val });
}

/**
 * 单类设施检索：RRF 融合一轮 → 全部关键词逐路二次确认 → 仍失败标记 failed 供降权处理
 * （原先在 life.js 内，等时圈引擎也要按同一口径取六类设施，故上移共享）
 * 成功结果写入 5min 共享缓存；失败/熔断不写（下次重试真实检索）
 */
async function fetchCategory(c, lng, lat, radius, stagger = 0) {
  const ck = `full:${c.key}:${Number(lng).toFixed(4)},${Number(lat).toFixed(4)}:${Math.round(radius)}`;
  const cached = poiCacheGet(ck);
  if (cached) return cached;
  if (isQuotaBlocked()) return { items: [], failed: true, quota: true };
  if (stagger) await new Promise((r) => setTimeout(r, stagger)); // 类间错峰，防百度 QPS 瞬时超限
  try {
    const r = await baiduMap.poiSearch({ query: c.keywords.join('|'), lng, lat, radius, pageSize: 20 });
    if ((r.items || []).length) {
      const ret = { items: r.items, failed: false };
      poiCacheSet(ck, ret);
      return ret;
    }
  } catch (e) {
    noteQuotaError(e);
  }
  if (isQuotaBlocked()) return { items: [], failed: true, quota: true };
  const parts = await Promise.all(
    c.keywords.map((k) =>
      baiduMap.poiSearch({ query: k, lng, lat, radius, pageSize: 20 }).catch((e) => {
        noteQuotaError(e);
        return null;
      })
    )
  );
  for (const p of parts) {
    if (p && (p.items || []).length) {
      const ret = { items: p.items, failed: false };
      poiCacheSet(ck, ret);
      return ret;
    }
  }
  return { items: [], failed: true, quota: isQuotaBlocked() };
}

module.exports = { CATEGORIES, isQuotaBlocked, noteQuotaError, poiCacheGet, poiCacheSet, fetchCategory };
