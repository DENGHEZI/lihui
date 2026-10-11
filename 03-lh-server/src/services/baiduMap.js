/**
 * 鲤慧 LiHui · 百度地图 Web 服务 API 封装
 *  - 服务端统一注入 ak（绝不下发到客户端）
 *  - ⚠️ 对外坐标系统一 GCJ-02（小程序 wx.getLocation 也是 GCJ-02）：
 *    所有百度接口显式声明 coord_type / coordtype，避免入参被误读成 BD-09
 *  - 全部接口带 TTL 缓存与降级兜底
 * 官方文档：https://lbsyun.baidu.com/faq/api
 */
const config = require('../config');
const { fetchJSON } = require('../utils/http');
const { Cache } = require('../utils/cache');
const logger = require('../utils/logger');
const { safeBd09ToGcj02 } = require('../utils/coord');
const security = require('../utils/security');

const cache = new Cache(800);
const BASE = () => config.baidu.base;
const AK = () => akPool.current();

/* ------------------------------------------------------------------ */
/* AK 池：多钥匙自动轮换（Key「过一段时间掉」的工程化解法）              */
/* ------------------------------------------------------------------
 * 背景：单 AK 模式下，日配额打满（302/4）/ 被风控停用（201/210/240）/
 * 服务禁用（3）任一发生 → 全部地图能力瘫痪，只能等百度 0 点重置或人工去控制台解锁。
 *
 * 方案：BAIDU_AK 支持逗号分隔多把钥匙，例如 `BAIDU_AK=ak1,ak2,ak3`。
 *  - 正常时固定用第一把（配额集中省着用）；
 *  - 某 AK 返回「AK 级失败」（配额/封禁/权限类错误码）→ 标记冷却 10 分钟，
 *    立即无缝切换下一把，端上无感知；
 *  - 冷却到期自动恢复轮询（配额 0 点重置后能自动回归）；
 *  - 全部 AK 都在冷却时退化为「取最早解冻的」，失败总好过没有。
 *  - /map/ak-status 诊断接口可随时查看每把钥匙的健康状态。
 */
const AK_COOLDOWN_MS = 10 * 60 * 1000;
const AK_FAIL_STATUS = new Set([3, 4, 201, 210, 240, 241, 302, 401, 403]); // 权限/配额/封禁/禁用类
const AK_FAIL_MSG_RE = /配额|超限|quota|权限|封禁|禁用|delist|APP.{0,6}(校验|不存在|被封)/i;

const akPool = (() => {
  const raw = String(config.baidu.ak || '').split(',').map((s) => s.trim()).filter(Boolean);
  const pool = raw.map((value) => ({
    value,
    mask: value.slice(0, 4) + '****' + value.slice(-4),
    failCount: 0,
    cooldownUntil: 0,
    lastErr: '',
  }));
  let cursor = 0;
  return {
    size: pool.length,
    /** 当前可用 AK：优先未冷却的，全冷却则取最早解冻的 */
    current() {
      if (!pool.length) return '';
      const now = Date.now();
      const ready = pool.filter((a) => a.cooldownUntil <= now);
      if (ready.length) {
        // 固定用第一把健康的（游标只在故障切换时推进，保证配额集中）
        return ready[0].value;
      }
      return pool.reduce((a, b) => (a.cooldownUntil <= b.cooldownUntil ? a : b)).value;
    },
    /** 标记某 AK 失败并进入冷却 */
    fail(value, reason) {
      const a = pool.find((x) => x.value === value);
      if (!a) return;
      a.failCount += 1;
      a.lastErr = String(reason || '').slice(0, 80);
      a.cooldownUntil = Date.now() + AK_COOLDOWN_MS;
      logger.warn('baidu', `AK ${a.mask} 进入冷却 ${AK_COOLDOWN_MS / 60000}min（${a.lastErr}）`);
    },
    /** 成功一次即清零失败计数 */
    ok(value) {
      const a = pool.find((x) => x.value === value);
      if (a && a.failCount) {
        a.failCount = 0;
        a.lastErr = '';
        a.cooldownUntil = 0;
      }
    },
    health() {
      return pool.map((a) => ({
        ak: a.mask,
        ok: a.cooldownUntil <= Date.now(),
        failCount: a.failCount,
        cooldownRemainMs: Math.max(0, a.cooldownUntil - Date.now()),
        lastErr: a.lastErr,
      }));
    },
  };
})();

/** bd09ll 拼接：百度要求 location=lat,lng */
const LL = (lat, lng) => `${lat},${lng}`;

/** 判定是否「AK 级失败」（该换钥匙了）：权限/配额/封禁类错误码或错误消息 */
function isAkLevelFailure(status, msg) {
  if (AK_FAIL_STATUS.has(Number(status))) return true;
  return AK_FAIL_MSG_RE.test(String(msg || ''));
}

async function call(pathname, params, { ttl = 0, cacheKey = '' } = {}) {
  const key = cacheKey || pathname + '?' + new URLSearchParams(params).toString();
  if (ttl > 0) {
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
  }
  // 出站令牌桶:高并发时在此排队(保护百度配额,防瞬间打爆)
  await security.baiduBucket.take();
  // AK 池轮换：当前钥匙失败且属 AK 级故障时自动换下一把重试
  let lastErr = null;
  for (let attempt = 0; attempt < Math.max(1, akPool.size); attempt++) {
    const ak = AK();
    // 蜜罐自检:出站 key 若被污染成蜜罐值,说明配置被篡改,立即告警
    if (security.HONEYPOTS.includes(ak)) {
      security.securityLog('honeypot-outbound', { detail: 'BAIDU_AK 疑似被替换为蜜罐值,请检查 .env' });
    }
    const qs = new URLSearchParams({ ...params, ak, output: 'json' }).toString();
    const url = `${BASE()}${pathname}?${qs}`;
    try {
      const raw = await fetchJSON(url, { timeout: 9000, retry: 1 });
      // 百度统一状态码：0 成功
      if (raw && raw.status !== undefined && raw.status !== 0) {
        const msg = raw.message || raw.msg || 'baidu api error';
        logger.warn('baidu', `${pathname} status=${raw.status} ${msg}`);
        if (attempt < akPool.size - 1 && isAkLevelFailure(raw.status, msg)) {
          akPool.fail(ak, `status=${raw.status} ${msg}`);
          continue; // 换下一把钥匙重试
        }
        const err = new Error(msg);
        err.baiduStatus = raw.status;
        throw err;
      }
      akPool.ok(ak);
      if (ttl > 0) cache.set(key, raw, ttl);
      return raw;
    } catch (e) {
      // 网络类错误（无 baiduStatus）不切钥匙：换 AK 解决不了断网
      if (e.baiduStatus === undefined) throw e;
      lastErr = e;
      if (attempt >= akPool.size - 1) throw e;
      if (isAkLevelFailure(e.baiduStatus, e.message)) {
        akPool.fail(ak, `status=${e.baiduStatus} ${e.message}`);
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error('baidu ak pool exhausted');
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

/**
 * 逆地理编码
 * @param {number} lng
 * @param {number} lat
 * @param {string} coordType 入参坐标系，默认 gcj02（小程序端）；百度 IP 定位结果属 bd09ll，需显式传入
 */
async function reverseGeocode(lng, lat, coordType = 'gcj02') {
  const raw = await call(
    '/reverse_geocoding/v3/',
    { location: LL(lat, lng), coordtype: coordType, extensions_poi: 1 },
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
  // 复合关键词（如「医院|药店」）：百度 place 检索不认 |，拆开逐路检索，
  // 再用 RRF（Reciprocal Rank Fusion, k=60）倒排融合 —— 多路同时召回且排名靠前的 POI 得分最高
  const words = String(query || '').split('|').map((s) => s.trim()).filter(Boolean);
  if (words.length > 1) {
    const parts = await Promise.all(
      words.slice(0, 3).map((w) =>
        poiSearch({ query: w, lng, lat, radius, pageNum, pageSize: 10, city }).catch(() => ({ items: [] }))
      )
    );
    const K = 60;
    const map = new Map();
    parts.forEach((p) => {
      (p.items || []).forEach((it, idx) => {
        const key = it.uid || `${it.name}@${it.address}`;
        if (!key) return;
        const cur = map.get(key) || { item: it, rrf: 0 };
        cur.rrf += 1 / (K + idx + 1);
        map.set(key, cur);
      });
    });
    const merged = [...map.values()]
      .sort((a, b) => b.rrf - a.rrf || ((a.item.distance === null ? 9e9 : a.item.distance) - (b.item.distance === null ? 9e9 : b.item.distance)))
      .slice(0, pageSize)
      .map((x) => x.item);
    return { total: merged.length, items: merged };
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
    // ⚠️ 不声明 coord_type 时百度按 BD-09 解释 location，检索圆心会整体偏移 500~900m
    params.coord_type = 3; // 3 = GCJ-02
  } else {
    params.region = city || '全国';
  }
  // ⚠️ ret_coord_type 默认 bd09ll。不显式声明就返回百度坐标，
  // 而端上 wx.getLocation 是 GCJ-02 —— 混用会让所有 POI 打点/距离/导航整体偏移 500~900m
  //（门店看着"在附近"其实差一个街区）。对外统一 GCJ-02，与 utils/coord.js 的约定一致。
  params.ret_coord_type = 'gcj02';
  // ⚠️ 2026-10 防御：place 的坐标参数若被判无效（百度参数改版的前兆），
  //   自动换无下划线参数名重试一次，避免检索功能整体静默失效
  let raw;
  try {
    raw = await call('/place/v2/search', params, { ttl: config.cache.poi });
  } catch (e) {
    if (e.baiduStatus === 2 && /coord/i.test(e.message || '')) {
      const retryParams = { ...params };
      delete retryParams.coord_type;
      retryParams.coordtype = 'gcj02';
      raw = await call('/place/v2/search', retryParams, { ttl: config.cache.poi });
    } else {
      throw e;
    }
  }
  const list = raw.results || [];
  return {
    total: raw.total || list.length,
    items: list.map((x) => {
      const l = x.location || {};
      // ⚠️ 地址回填：百度部分 POI（尤其小区/站台/新店）address 为空字符串，
      //    端上就会显示「地址未知」—— 客户反馈「一些地址没有出来」。
      //    用 province+city+area 拼一级行政区兜底（如「湖南省郴州市北湖区」），比空白强。
      const addrFallback = [x.province, x.city, x.area].filter(Boolean).join('');
      return {
        uid: x.uid || '',
        name: x.name || '',
        address: x.address || addrFallback || '',
        addressEstimated: !x.address && !!addrFallback, // 标记这是行政区级地址，不是门牌
        lng: Number(l.lng),
        lat: Number(l.lat),
        distance: x.detail_info && x.detail_info.distance !== undefined ? Number(x.detail_info.distance) : null,
        tag: x.detail_info && x.detail_info.tag ? x.detail_info.tag : '',
        type: x.detail_info && x.detail_info.type ? x.detail_info.type : '',
        // ★ 行政区 / 城市 / 电话要透传出去：订单留痕、供应商查价（要 city）、
        //   前端展示门店归属都靠它们。之前漏了，导致 catalog 里 district / phone 全空。
        province: x.province || '',
        city: x.city || '',
        district: x.area || '',
        street: x.street_name || '',
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
  // 统一声明入参坐标系为 GCJ-02（端上 location 与 POI 均为 GCJ-02）
  // ⚠️ 2026-10 实测（百度改版）：directionlite 的参数名是 coordtype（无下划线），
  //   旧写法 coord_type=3 现在一律报 status=2 "[coord_type] format is invalid"；
  //   取值用字符串 gcj02（实测 origin/destination 回显与入参一致，无偏移）。
  params.coordtype = 'gcj02';
  if (mode === 'driving') {
    params.tactics = realtime ? 11 : 0; // 11 = 实时路况避堵
    params.road_type = 0;
  }
  // ⚠️ 别设 ret_coordtype=bd09ll：origin/destination 传的是端上 wx.getLocation 的 GCJ-02
  //（坐标拼成 `${lat},${lng}`），返回再按 BD-09 解释一遍 → 起点/终点与路线折线全部错位。
  // 这里保持百度默认 gcj02，与端上坐标系一致。
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
  // ret_coord_type=gcj02：否则默认吐 BD-09，Agent / 前端拿到坐标会整体偏移
  const raw = await call('/place/v2/suggestion', {
    query: keyword,
    region: city,
    city_limit: false,
    ret_coord_type: 'gcj02',
  });
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
  call, // 导出给 isochrone 等高级封装复用（ak 注入 / status 校验 / 缓存）
  ipLocate,
  geocode,
  reverseGeocode,
  poiSearch,
  route,
  weather,
  suggest,
  fallbackLocate,
  FALLBACK_CITIES,
  akHealth: () => akPool.health(), // AK 池健康状态（/map/ak-status 诊断用）
  currentAk: () => akPool.current(), // 当前在用的 AK（staticimg 等不走 call() 的直拼 URL 场景必须用它，不能拿 config.baidu.ak 原始串——多 AK 时含逗号，百度判无效）
  _cache: cache,
};
