/**
 * 鲤慧 LiHui · 地图能力路由（百度地图 AK 中转，AK 不下发端上）
 */
const { ok, fail } = require('../utils/http');
const baiduMap = require('../services/baiduMap');
const logger = require('../utils/logger');

const numOr = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

/* ------------------------------------------------------------------ */
/* POI 结果短期兜底缓存                                                */
/* ------------------------------------------------------------------
 * 百度 place 是**日配额**计费，AK 打满会返回 302 天配额超限。
 * 那时候 /map/poi/search 直接吐空 → 端上表现为「附近一间店都没有 / 位置不对」，
 * 用户只会以为功能坏了，实际是配额问题。
 * 这里把最近成功的 POI 结果存起来：配额命中时回吐上一次结果并标 stale，
 * 至少让用户看到「有东西、且是几小时前的」，而不是白板。
 * 写入同时进内存 + 落盘；内存优先读，避免并发时 read-modify-write 互相覆盖。
 */
const store = require('../services/store');
const POI_MEM = new Map();
const POI_FILE = 'poi';
const POI_MAX_AGE = 6 * 60 * 60 * 1000; // 6 小时
const POI_MAX_KEYS = 300;

function poiKey(q) {
  const lng = q.lng !== undefined && isFinite(Number(q.lng)) ? Number(q.lng).toFixed(3) : '';
  const lat = q.lat !== undefined && isFinite(Number(q.lat)) ? Number(q.lat).toFixed(3) : '';
  return [q.query, lng, lat, q.radius || '', q.pageSize || ''].join('|');
}

function poiCacheSet(key, data) {
  POI_MEM.set(key, { ts: Date.now(), data });
  try {
    const all = store.read(POI_FILE, {});
    all[key] = { ts: Date.now(), data };
    const keys = Object.keys(all);
    if (keys.length > POI_MAX_KEYS) {
      // Map 是插入序，保留最近 POI_MAX_KEYS 条，防 data/poi.json 无限膨胀
      const trimmed = {};
      keys.slice(keys.length - POI_MAX_KEYS).forEach((k) => { trimmed[k] = all[k] });
      store.write(POI_FILE, trimmed);
    } else {
      store.write(POI_FILE, all);
    }
  } catch (e) {
    /* 落盘失败不影响内存兜底 */
  }
}

function poiCacheGet(key) {
  const hit = POI_MEM.get(key);
  if (hit && Date.now() - hit.ts < POI_MAX_AGE) return hit.data;
  if (hit) POI_MEM.delete(key);
  try {
    const all = store.read(POI_FILE, {});
    const disk = all[key];
    if (!disk || Date.now() - disk.ts >= POI_MAX_AGE) return null;
    POI_MEM.set(key, disk);
    return disk.data;
  } catch (e) {
    return null;
  }
}

module.exports = {
  /** GET /api/v1/map/geocode?address=&city= */
  'GET /map/geocode': async (req, res, q) => {
    if (!q.address) return fail(res, 1001, 'address 必填');
    try {
      return ok(res, await baiduMap.geocode(q.address, q.city || ''));
    } catch (e) {
      return fail(res, 2002, `地址解析失败：${e.message}`);
    }
  },

  /** GET /api/v1/map/reverse-geocode?lng=&lat= */
  'GET /map/reverse-geocode': async (req, res, q) => {
    const lng = numOr(q.lng, NaN);
    const lat = numOr(q.lat, NaN);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return fail(res, 1001, 'lng/lat 必填且为数字');
    try {
      return ok(res, await baiduMap.reverseGeocode(lng, lat));
    } catch (e) {
      return fail(res, 2002, `逆地理编码失败：${e.message}`);
    }
  },

  /** GET /api/v1/map/poi/search?query=&lng=&lat=&radius=&pageNum=&pageSize= */
  'GET /map/poi/search': async (req, res, q) => {
    if (!q.query) return fail(res, 1001, 'query 必填');
    const args = {
      query: q.query,
      lng: q.lng !== undefined ? numOr(q.lng, undefined) : undefined,
      lat: q.lat !== undefined ? numOr(q.lat, undefined) : undefined,
      radius: numOr(q.radius, 1200),
      pageNum: numOr(q.pageNum, 0),
      pageSize: numOr(q.pageSize, 20),
      city: q.city || '',
    };
    const key = poiKey(q);
    try {
      const data = await baiduMap.poiSearch(args);
      if (data && data.items && data.items.length) poiCacheSet(key, data);
      return ok(res, data);
    } catch (e) {
      logger.warn('map', `poi search failed: ${e.message}`);
      // 配额/网络挂了 → 回吐最近一次成功结果（标 stale），不让端上白板
      const stale = poiCacheGet(key);
      if (stale) {
        return ok(res, {
          ...stale,
          stale: true,
          hint: `百度接口暂不可用（${e.message}），这是最近一次可用的结果，请稍后重试`,
        });
      }
      return ok(res, { total: 0, items: [], degraded: true, hint: `百度接口暂不可用：${e.message}` });
    }
  },

  /** GET /api/v1/map/route?mode=&origin=&destination=&realtime= */
  'GET /map/route': async (req, res, q) => {
    if (!q.origin || !q.destination) return fail(res, 1001, 'origin / destination 必填，格式 lng,lat');
    const mode = ['walking', 'riding', 'driving', 'transit'].includes(q.mode) ? q.mode : 'walking';
    // 端上传 lng,lat，百度要 lat,lng
    const fix = (s) => {
      const [a, b] = String(s).split(',').map(Number);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
      return `${b},${a}`;
    };
    const o = fix(q.origin);
    const d = fix(q.destination);
    if (!o || !d) return fail(res, 1001, 'origin / destination 格式应为 "lng,lat"');
    try {
      const data = await baiduMap.route({ mode, origin: o, destination: d, realtime: q.realtime === 'true' || q.realtime === true });
      return ok(res, data);
    } catch (e) {
      return fail(res, 2001, `路线规划失败：${e.message}`);
    }
  },

  /** GET /api/v1/map/weather?district=&lng=&lat= */
  'GET /map/weather': async (req, res, q) => {
    try {
      return ok(res, await baiduMap.weather({ district: q.district || '', lng: numOr(q.lng, undefined), lat: numOr(q.lat, undefined) }));
    } catch (e) {
      return fail(res, 2001, `天气查询失败：${e.message}`);
    }
  },

  /** GET /api/v1/map/suggest?keyword=&city= */
  'GET /map/suggest': async (req, res, q) => {
    if (!q.keyword) return fail(res, 1001, 'keyword 必填');
    try {
      return ok(res, await baiduMap.suggest(q.keyword, q.city || ''));
    } catch (e) {
      return ok(res, []);
    }
  },

  /** GET /api/v1/map/scenic-recommend?lng=&lat=&radius=&tags= */
  'GET /map/scenic-recommend': async (req, res, q) => {
    const lng = numOr(q.lng, NaN);
    const lat = numOr(q.lat, NaN);
    if (!Number.isFinite(lng)) return fail(res, 1001, 'lng/lat 必填');
    const tags = (q.tags || '公园,景点,博物馆,广场').split(',').map((s) => s.trim()).filter(Boolean);
    const radius = numOr(q.radius, 3000);
    try {
      const results = await Promise.all(
        tags.slice(0, 4).map((t) => baiduMap.poiSearch({ query: t, lng, lat, radius, pageSize: 5 }).catch(() => ({ items: [] })))
      );
      const merged = [];
      const seen = new Set();
      results.forEach((r, i) => {
        (r.items || []).forEach((it) => {
          if (seen.has(it.uid)) return;
          seen.add(it.uid);
          merged.push({ ...it, tag: tags[i] });
        });
      });
      merged.sort((a, b) => (a.distance || 9e9) - (b.distance || 9e9));
      return ok(res, { total: merged.length, items: merged.slice(0, 12), tags });
    } catch (e) {
      return ok(res, { total: 0, items: [], degraded: true });
    }
  },
};
