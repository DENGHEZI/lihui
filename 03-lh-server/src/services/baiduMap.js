/**
 * 鲤慧 LiHui · 百度地图 Web 服务 API 封装
 *  - 服务端统一注入 ak（绝不下发到客户端）
 *  - 统一坐标系 bd09ll、统一返回 {lng, lat}
 *  - 全部接口带 TTL 缓存与降级兜底
 * 官方文档：https://lbsyun.baidu.com/faq/api
 */
const config = require('../config');
const { fetchJSON } = require('../utils/http');
const { Cache } = require('../utils/cache');
const logger = require('../utils/logger');

const cache = new Cache(800);
const BASE = () => config.baidu.base;
const AK = () => config.baidu.ak;

/** bd09ll 拼接：百度要求 location=lat,lng */
const LL = (lat, lng) => `${lat},${lng}`;

async function call(pathname, params, { ttl = 0, cacheKey = '' } = {}) {
  const key = cacheKey || pathname + '?' + new URLSearchParams(params).toString();
  if (ttl > 0) {
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
  }
  const qs = new URLSearchParams({ ...params, ak: AK(), output: 'json' }).toString();
  const url = `${BASE()}${pathname}?${qs}`;
  const raw = await fetchJSON(url, { timeout: 9000, retry: 1 });
  // 百度统一状态码：0 成功
  if (raw && raw.status !== undefined && raw.status !== 0) {
    const msg = raw.message || raw.msg || 'baidu api error';
    logger.warn('baidu', `${pathname} status=${raw.status} ${msg}`);
    const err = new Error(msg);
    err.baiduStatus = raw.status;
    throw err;
  }
  if (ttl > 0) cache.set(key, raw, ttl);
  return raw;
}

/* ------------------------------------------------------------------ */
/* IP 定位                                                             */
/* ------------------------------------------------------------------ */
async function ipLocate(ip) {
  const safeIp = !ip || ip === '127.0.0.1' ? '' : ip;
  const raw = await call(
    '/location/ip',
    { ip: safeIp, coor: 'bd09ll' },
    { ttl: config.cache.ip, cacheKey: `ip:${safeIp || 'auto'}` }
  );
  const c = raw.content || {};
  const p = (c.point || {}) || {};
  const ad = c.address_detail || {};
  return {
    ip: c.ip || ip || '',
    city: c.address || '',
    province: ad.province || '',
    district: ad.district || '',
    isp: ad.isp || '',
    point: p.x !== undefined ? { lng: Number(p.x), lat: Number(p.y) } : null,
    // 百度 IP 定位粒度只到城市，confidence 用「是否有坐标」估算
    confidence: p.x !== undefined ? 0.75 : 0.35,
    source: 'baidu-ip',
  };
}

/* ------------------------------------------------------------------ */
/* 地理编码 / 逆地理编码                                                */
/* ------------------------------------------------------------------ */
async function geocode(address, city = '') {
  const raw = await call('/geocoding/v3/', { address, city }, { ttl: config.cache.geocode });
  const r = raw.result || {};
  const loc = r.location || {};
  return {
    address: address,
    lng: Number(loc.lng),
    lat: Number(loc.lat),
    precision: r.precise === 1,
    confidence: r.confidence || 0,
    level: r.level || '',
    formatted: `${r.level || ''}${address}`,
  };
}

async function reverseGeocode(lng, lat) {
  const raw = await call(
    '/reverse_geocoding/v3/',
    { location: LL(lat, lng), coordtype: 'bd09ll', extensions_poi: 1 },
    { ttl: config.cache.reverseGeocode }
  );
  const r = raw.result || {};
  const ad = r.addressComponent || {};
  const poi = (r.pois && r.pois[0]) || {};
  return {
    formatted: r.formatted_address || `${ad.province || ''}${ad.city || ''}${ad.district || ''}${ad.street || ''}`,
    province: ad.province || '',
    city: ad.city || '',
    district: ad.district || '',
    town: ad.town || '',
    street: ad.street || '',
    streetNumber: ad.street_number || '',
    adcode: ad.adcode || '',
    business: r.business || '',
    nearbyPoi: poi.name || '',
    lng,
    lat,
  };
}

/* ------------------------------------------------------------------ */
/* 地点检索                                                            */
/* ------------------------------------------------------------------ */
async function poiSearch({ query, lng, lat, radius = 1200, pageNum = 0, pageSize = 20, city = '' }) {
  // 复合关键词（如「医院|药店」）：百度 place 检索不认 |，拆开逐个查再合并
  const words = String(query || '').split('|').map((s) => s.trim()).filter(Boolean);
  if (words.length > 1) {
    const parts = await Promise.all(
      words.slice(0, 3).map((w) =>
        poiSearch({ query: w, lng, lat, radius, pageNum, pageSize: 10, city }).catch(() => ({ total: 0, items: [] }))
      )
    );
    const seen = new Set();
    const merged = [];
    for (const p of parts) {
      for (const it of p.items || []) {
        const k = it.uid || `${it.name}@${it.address}`;
        if (k && !seen.has(k)) {
          seen.add(k);
          merged.push(it);
        }
      }
    }
    merged.sort((a, b) => (a.distance === null ? 1e9 : a.distance) - (b.distance === null ? 1e9 : b.distance));
    return { total: merged.length, items: merged.slice(0, pageSize) };
  }
  const params = {
    query,
    page_size: pageSize,
    page_num: pageNum,
    scope: 2,
    filter: '',
  };
  if (lng !== undefined && lat !== undefined) {
    params.location = LL(lat, lng);
    params.radius = radius;
  } else {
    params.region = city || '全国';
  }
  const raw = await call('/place/v2/search', params, { ttl: config.cache.poi });
  const list = raw.results || [];
  return {
    total: raw.total || list.length,
    items: list.map((x) => {
      const l = x.location || {};
      return {
        uid: x.uid || '',
        name: x.name || '',
        address: x.address || '',
        lng: Number(l.lng),
        lat: Number(l.lat),
        distance: x.detail_info && x.detail_info.distance !== undefined ? Number(x.detail_info.distance) : null,
        tag: x.detail_info && x.detail_info.tag ? x.detail_info.tag : '',
        type: x.detail_info && x.detail_info.type ? x.detail_info.type : '',
        telephone: (x.telephone || '').replace(/^"/, ''),
        rating: x.detail_info && x.detail_info.overall_rating ? x.detail_info.overall_rating : null,
      };
    }),
  };
}

/* ------------------------------------------------------------------ */
/* 路线规划                                                            */
/* ------------------------------------------------------------------ */
const ROUTE_PATH = {
  walking: '/directionlite/v1/walking',
  riding: '/directionlite/v1/riding',
  driving: '/directionlite/v1/driving',
  transit: '/directionlite/v1/transit',
};

async function route({ mode = 'walking', origin, destination, realtime = false }) {
  const pathname = ROUTE_PATH[mode] || ROUTE_PATH.walking;
  const params = { origin, destination };
  if (mode === 'driving') {
    params.tactics = realtime ? 11 : 0; // 11 = 实时路况避堵
    params.road_type = 0;
    params.ret_coordtype = 'bd09ll';
  }
  if (mode === 'transit') {
    params.ret_coordtype = 'bd09ll';
  }
  const raw = await call(pathname, params, { ttl: config.cache.route });
  const r = raw.result || {};
  const routes = r.routes || [];
  const first = routes[0] || {};
  const legs = first.legs || first.steps || [];
  const steps = (first.steps || []).map((s) => ({
    instruction: s.instruction || '',
    distance: Number(s.distance || 0),
    duration: Number(s.duration || 0),
    path: s.path || '',
  }));
  return {
    mode,
    distance: Number(first.distance || r.distance || 0),
    duration: Number(first.duration || r.duration || 0),
    trafficLight: Number(first.traffic_light || 0),
    congestion: first.congestion || '',
    steps,
    polyline: steps.map((s) => s.path).filter(Boolean).join(';'),
    alternatives: routes.slice(1, 4).map((x) => ({
      distance: Number(x.distance || 0),
      duration: Number(x.duration || 0),
    })),
    legCount: legs.length,
  };
}

/* ------------------------------------------------------------------ */
/* 天气                                                               */
/* ------------------------------------------------------------------ */
async function weather({ district = '', lng, lat }) {
  const params = { data_type: 'all' };
  if (district) params.district_id = district;
  else if (lng !== undefined) params.location = `${lng},${lat}`; // ⚠️ 天气接口是「经度,纬度」顺序，与其它接口相反
  const raw = await call('/weather/v1/', params, { ttl: config.cache.weather });
  const w = raw.result || {};
  const now = (w.now || {}) || {};
  return {
    city: (w.location && w.location.city) || '',
    temperature: now.temp !== undefined ? Number(now.temp) : null,
    feelsLike: now.feels_like !== undefined ? Number(now.feels_like) : null,
    text: now.text || '',
    windDir: now.wind_dir || '',
    windClass: now.wind_class || '',
    humidity: now.rh !== undefined ? Number(now.rh) : null,
    aqi: now.aqi !== undefined ? Number(now.aqi) : null,
    pm25: now.pm25 !== undefined ? Number(now.pm25) : null,
    tips: (w.index && w.index[0] && w.index[0].des) || '',
    forecast: (w.forecasts || []).slice(0, 5).map((f) => ({
      date: f.date,
      high: f.high,
      low: f.low,
      textDay: f.text_day,
      textNight: f.text_night,
      aqi: f.aqi,
    })),
  };
}

/* ------------------------------------------------------------------ */
/* 输入联想                                                            */
/* ------------------------------------------------------------------ */
async function suggest(keyword, city = '') {
  const raw = await call('/place/v2/suggestion', { query: keyword, region: city, city_limit: false });
  return (raw.result || []).map((x) => ({
    name: x.name,
    district: x.district,
    lng: x.location && Number(x.location.lng),
    lat: x.location && Number(x.location.lat),
  }));
}

/* ------------------------------------------------------------------ */
/* 降级兜底数据（百度接口不可用时保证端上不白屏）                        */
/* ------------------------------------------------------------------ */
const FALLBACK_CITIES = [
  { city: '长沙市', province: '湖南省', lng: 112.938814, lat: 28.228209 },
  { city: '北京市', province: '北京市', lng: 116.404269, lat: 39.915119 },
  { city: '上海市', province: '上海市', lng: 121.473662, lat: 31.231732 },
  { city: '广州市', province: '广东省', lng: 113.264435, lat: 23.129163 },
  { city: '深圳市', province: '广东省', lng: 114.057868, lat: 22.543099 },
  { city: '成都市', province: '四川省', lng: 104.066301, lat: 30.572961 },
  { city: '杭州市', province: '浙江省', lng: 120.15507, lat: 30.274085 },
  { city: '武汉市', province: '湖北省', lng: 114.298572, lat: 30.584355 },
];

function fallbackLocate(cityName) {
  const hit = FALLBACK_CITIES.find((c) => c.city.includes(cityName || '')) || FALLBACK_CITIES[0];
  return {
    ip: '',
    city: hit.city,
    province: hit.province,
    district: '',
    isp: '',
    point: { lng: hit.lng, lat: hit.lat },
    confidence: 0.3,
    source: 'fallback',
  };
}

module.exports = {
  ipLocate,
  geocode,
  reverseGeocode,
  poiSearch,
  route,
  weather,
  suggest,
  fallbackLocate,
  FALLBACK_CITIES,
  _cache: cache,
};
