/**
 * 鲤慧 LiHui · 15 分钟生活圈共享件
 * 七类设施口径（含养老） + 百度配额熔断 + 单类设施检索
 * （life 路由与 isochrone 等时圈引擎共用；独立成模块避免循环依赖：
 *   life.js → isochrone.js → lifeShared.js，life.js → lifeShared.js）
 */
const baiduMap = require('./baiduMap');
const logger = require('../utils/logger');

/** 七类设施口径（权重合计 1.0；need = 15 分钟内达标线「处数」，用于旧版体检计分）
 *  2026-10-10 新增养老类：响应《国家积极应对人口老龄化中长期规划》与 TD/T 1062—2021
 *  将「养老服务」列入基础保障型服务要素的口径；关键词用「养老」宽词干兜底
 *  （养老院/养老服务中心/康养中心等名称各异，窄词易漏检），另列敬老院/老年公寓/
 *  老年食堂/日间照料四个典型业态补全类型覆盖度。 */
const CATEGORIES = [
  { key: 'medical', name: '医疗', weight: 0.23, keywords: ['医院', '社区卫生服务中心', '药店'], need: 2 },
  { key: 'education', name: '教育', weight: 0.13, keywords: ['幼儿园', '小学', '中学'], need: 1 },
  { key: 'market', name: '商业', weight: 0.18, keywords: ['超市', '菜市场', '便利店'], need: 2 },
  { key: 'food', name: '餐饮', weight: 0.09, keywords: ['餐厅', '早餐店'], need: 3 },
  { key: 'transit', name: '交通', weight: 0.18, keywords: ['公交', '地铁站', '停车场'], need: 1 },
  { key: 'leisure', name: '休闲', weight: 0.09, keywords: ['公园', '广场', '体育'], need: 1 },
  { key: 'elder', name: '养老', weight: 0.1, keywords: ['养老', '敬老院', '老年公寓', '老年食堂', '日间照料'], need: 1 },
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
/* —— /life/report 与 isochrone 七类检索口径相近，重复请求不再重烧配额与延迟 */
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
 * （原先在 life.js 内，等时圈引擎也要按同一口径取七类设施，故上移共享）
 * 成功结果写入 5min 共享缓存；失败/熔断不写（下次重试真实检索）
 *
 * 2026-10-10 提速与修复：
 *  - 类内整体 12s 超时（此前单请求最坏 9s×retry2 轮 ≈ 36s/类，拖垮整份体检）
 *  - 二次确认只发前 2 个关键词（受控并发，防百度 401 并发超限后的重试雪崩）
 *  - 出口统一 POI 去重（uid 优先 + 同名同址合并），评分计数不再受脏数据影响
 */
/* ------------------------------------------------------------------ */
/* 类间错峰节奏：按百度 QPS 上限动态计算（环境变量 BAIDU_QPS，默认 3）   */
/* —— 2026-10-10 七类口径后 150ms 错峰 = 瞬时 ~6.7 QPS，超 3 QPS 上限   */
/*    触发百度 401 并发超限 → 10 分钟熔断 → 类目失败（地图黑点主因）。   */
/*    334ms × 7 类 ≈ 3 QPS 贴上限内；配额提升后可调大 BAIDU_QPS 自动加速 */
/* ------------------------------------------------------------------ */
const BAIDU_QPS = Math.max(1, Number(process.env.BAIDU_QPS) || 3);
const CAT_STAGGER_MS = Math.ceil(1000 / BAIDU_QPS);
function catStagger(i) {
  return i * CAT_STAGGER_MS;
}

const CAT_TIMEOUT_MS = 12 * 1000;
function withCatTimeout(p) {
  return Promise.race([
    p,
    new Promise((resolve) => setTimeout(() => resolve(null), CAT_TIMEOUT_MS)),
  ]);
}

async function fetchCategory(c, lng, lat, radius, stagger = 0) {
  const ck = `full:${c.key}:${Number(lng).toFixed(4)},${Number(lat).toFixed(4)}:${Math.round(radius)}`;
  const cached = poiCacheGet(ck);
  if (cached) return cached;
  if (isQuotaBlocked()) return { items: [], failed: true, quota: true };
  if (stagger) await new Promise((r) => setTimeout(r, stagger)); // 类间错峰，防百度 QPS 瞬时超限
  const finish = (items) => {
    const deduped = dedupePOIs(items);
    const ret = { items: deduped, failed: false };
    poiCacheSet(ck, ret);
    return ret;
  };
  try {
    const r = await withCatTimeout(baiduMap.poiSearch({ query: c.keywords.join('|'), lng, lat, radius, pageSize: 20 }));
    if (r === null) return { items: [], failed: true, timeout: true }; // 超时：不再叠加二次确认
    if ((r.items || []).length) return finish(r.items);
  } catch (e) {
    noteQuotaError(e);
  }
  if (isQuotaBlocked()) return { items: [], failed: true, quota: true };
  /* 二次确认：只取前 2 个关键词（受控并发）。联合词已覆盖全部关键词语义，
     前 2 词命中即可确认该类存在；两词皆空才判「确实没有」。 */
  const parts = await Promise.all(
    c.keywords.slice(0, 2).map((k) =>
      withCatTimeout(baiduMap.poiSearch({ query: k, lng, lat, radius, pageSize: 20 }).catch((e) => {
        noteQuotaError(e);
        return null;
      }))
    )
  );
  for (const p of parts) {
    if (p && (p.items || []).length) return finish(p.items);
  }
  return { items: [], failed: true, quota: isQuotaBlocked() };
}

/* ------------------------------------------------------------------ */
/* 评分纯函数（从 life.js localDiagnose 抽出，便于单元测试与口径统一）    */
/* ------------------------------------------------------------------ */
/**
 * POI 去重（纯函数）：修复评分虚高的「重复计数」BUG。
 *  - 第一遍按 uid 去重（百度 POI 唯一标识）
 *  - 第二遍按 name@量化坐标(~11m) 合并「同店不同 uid」的脏数据（同连锁店被
 *    百度收录多条记录时，uid 各不相同但名称与坐标一致）
 *  - 同名不同址的正规连锁分店保留（坐标量化后不同即不合并）
 * @returns {Array} 去重后的新数组（不改入参）
 */
function dedupePOIs(items) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  const byUid = new Map();
  for (const it of list) {
    const uid = String((it && it.uid) || '').trim();
    const k = uid ? 'uid:' + uid : 'raw:' + byUid.size;
    if (!byUid.has(k)) byUid.set(k, it);
  }
  const seenGeo = new Set();
  const out = [];
  for (const it of byUid.values()) {
    const lng = Number(it && it.lng), lat = Number(it && it.lat);
    const geo = Number.isFinite(lng) && Number.isFinite(lat)
      ? lng.toFixed(4) + ',' + lat.toFixed(4)
      : String((it && it.address) || '');
    const key = String((it && it.name) || '').trim() + '@@' + geo;
    if (seenGeo.has(key)) continue;
    seenGeo.add(key);
    out.push(it);
  }
  return out;
}

/**
 * 单类设施评分（纯函数，不发请求）：
 *  - POI 先去重再计数（同 uid / 同名同址合并），杜绝重复 POI 推高数量达标度
 *  - 数量达标度 ratio   = min(1, 去重命中数 / need)     权重 0.6
 *  - 类型覆盖度 typeRatio = 命中关键词数 / 关键词总数    权重 0.4
 *  - 检索失败(failed)返回 null —— 该类不参与总分（区别于「确实没有」）
 * @returns {{ hitTypes:string[], score:number|null, count:number, total:number }}
 */
function scoreCategory(c, items, failed) {
  const deduped = dedupePOIs(items);
  const hitTypes = (c.keywords || []).filter((k) =>
    deduped.some((i) => (String((i && i.name) || '') + String((i && i.tag) || '') + String((i && i.type) || '')).includes(k))
  );
  if (failed) return { hitTypes, score: null, count: deduped.length, total: deduped.length };
  const ratio = Math.min(1, deduped.length / Math.max(c.need, 1));
  const typeRatio = hitTypes.length / Math.max((c.keywords || []).length, 1);
  return { hitTypes, score: Math.round((ratio * 0.6 + typeRatio * 0.4) * 100), count: deduped.length, total: deduped.length };
}

/**
 * 加权总分（纯函数）：只用「成功检索」的类做加权，权重归一化，
 * 杜绝偶发故障导致的评分跳水。
 * @param {Array<{name:string,weight:number,need:number,score:number|null,count:number}>} cats
 * @returns {{ score:number, level:string, shortboards:string[] }}
 */
function scoreSummary(cats) {
  const valid = (cats || []).filter((c) => c.score !== null && c.score !== undefined);
  const weightSum = valid.reduce((a, b) => a + b.weight, 0) || 1;
  const score = Math.round(valid.reduce((a, b) => a + b.score * (b.weight / weightSum), 0));
  const level = score >= 85 ? '优秀' : score >= 60 ? '良好' : score >= 40 ? '一般' : '较差';
  const shortboards = valid
    .filter((c) => c.score < 60)
    .map((c) => `${c.name}：15 分钟步行可达 ${c.count} 处，达标线 ${c.need} 类`);
  return { score, level, shortboards };
}

module.exports = { CATEGORIES, isQuotaBlocked, noteQuotaError, poiCacheGet, poiCacheSet, fetchCategory, dedupePOIs, scoreCategory, scoreSummary, catStagger, CAT_STAGGER_MS };
