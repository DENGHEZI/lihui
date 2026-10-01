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
    try {
      const data = await baiduMap.poiSearch({
        query: q.query,
        lng: q.lng !== undefined ? numOr(q.lng, undefined) : undefined,
        lat: q.lat !== undefined ? numOr(q.lat, undefined) : undefined,
        radius: numOr(q.radius, 1200),
        pageNum: numOr(q.pageNum, 0),
        pageSize: numOr(q.pageSize, 20),
        city: q.city || '',
      });
      return ok(res, data);
    } catch (e) {
      logger.warn('map', `poi search failed: ${e.message}`);
      return ok(res, { total: 0, items: [], degraded: true, hint: '百度接口暂不可用，已降级为空结果，请检查 AK 配额或网络。' });
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
