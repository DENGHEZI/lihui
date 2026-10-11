/**
 * 鲤慧 LiHui · 地图能力路由（百度地图 AK 中转，AK 不下发端上）
 */
const { ok, fail } = require('../utils/http');
const baiduMap = require('../services/baiduMap');
const addrFix = require('../services/addrFix');
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
let bmapSite = null;
try {
  bmapSite = require('../services/bmapSite');
} catch (_) {}
const config = require('../config');
const security = require('../utils/security');
const auth = require('../services/auth');
const userProfile = require('../services/userProfile');
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
  /* ---------------- 百度静态图代理(安全升级 2026-10-06) ----------------
   * 旧版 isochrone 直接把带 ak 的静态图 URL 下发端上 → AK 被扒(被盗主渠道之一)。
   * 现在端上只拿到本端点路径,AK 由这里在服务端注入后拉图回传二进制,密钥永不出门。
   * 参数全部走白名单校验(数值/受限字符),防止参数注入拼出非预期请求。 */
  'GET /map/staticimg': async (req, res, q) => {
    if (!config.baidu.ak) return fail(res, 5002, '百度 AK 未配置');
    const geoRe = /^-?\d{1,3}(\.\d+)?,-?\d{1,3}(\.\d+)?$/;
    const center = String(q.center || '').match(geoRe);
    if (!center) return fail(res, 1001, 'center 必填,格式 lng,lat');
    // markers 支持多点(lng,lat|lng,lat),逐段严格校验
    const markerList = String(q.markers || '').split('|').filter(Boolean);
    const markersOk = markerList.length > 0 && markerList.length <= 8 && markerList.every((m) => geoRe.test(m));
    const markers = markersOk ? String(q.markers) : null;
    const paths = String(q.paths || '');
    // paths 只允许 数字/逗号/分号/负号/小数点(静态图路径参数),长度 ≤1800(百度 URL 上限)
    if (!paths || paths.length > 1800 || !/^[-0-9.,;]+$/.test(paths)) {
      return fail(res, 1001, 'paths 非法');
    }
    const zoom = Math.max(3, Math.min(18, numOr(q.zoom, 15)));
    const w = Math.max(80, Math.min(1024, numOr(q.width, 640)));
    const h = Math.max(80, Math.min(1024, numOr(q.height, 480)));
    const pathStyles = /^0x[0-9A-Fa-f]{6},\d{1,2},(0(\.\d{1,2})?|1(\.0{1,2})?)$/.test(String(q.pathStyles || ''))
      ? String(q.pathStyles)
      : '0x1677FF,3,0.25';
    // ⚠️ markers/paths 百度要求 ; 与 | 裸放 URL(encodeURIComponent 会编成 %3B/%7C 导致返回空白占位图)。
    //    两参数均已过白名单(纯数字/逗号/分号/竖线/负号),可安全裸拼;center/zoom 等仍走编码。
    const url =
      'https://api.map.baidu.com/staticimage/v2?ak=' + encodeURIComponent(config.baidu.ak) +
      '&center=' + encodeURIComponent(center[0]) +
      '&zoom=' + zoom + '&width=' + w + '&height=' + h +
      (markers ? '&markers=' + markers : '') +
      '&paths=' + paths +
      '&pathStyles=' + pathStyles +
      // ⚠️ 静态图 v2 默认 coordtype=bd09ll：我们下发的 center/markers/paths 全是 GCJ-02
      //    （wx.getLocation gcj02 + directionlite ret_coord_type=gcj02），不声明会被按百度坐标解释，
      //    整张图（起点标记+路线折线）整体偏移 500~900m，表现为「位置和规划不一致」。2026-10-11 修复。
      '&coordtype=gcj02ll';
    if (!bmapSite || !bmapSite.fetchUrl) return fail(res, 5002, '静态图代理不可用');
    try {
      await security.baiduBucket.take(); // 与其他百度出站共享 QPS 令牌桶
      const r = await bmapSite.fetchUrl(url, null, 9000);
      const ct = r.headers['content-type'] || '';
      if (r.statusCode !== 200 || !/image/i.test(ct)) {
        logger.warn('map', `staticimg 上游异常 ${r.statusCode} ${ct}`);
        return fail(res, 5021, '静态图生成失败', 502);
      }
      res.writeHead(200, {
        'Content-Type': ct,
        'Cache-Control': 'public, max-age=86400',
        'Access-Control-Allow-Origin': config.server.corsOrigin,
      });
      return res.end(r.body);
    } catch (e) {
      logger.warn('map', `staticimg 异常 ${e.message}`);
      return fail(res, 5021, '静态图服务异常', 502);
    }
  },

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
    const devId = auth.resolveOwner(req).ownerKey; // 账号锚定：登录= user:<uid>，匿名= 设备键
    try {
      // 行为埋点:搜索入画像(自动学习用户常搜类目/关键词)
      userProfile.track(devId, 'search', { query: q.query, category: q.category });
      const data = await baiduMap.poiSearch(args);
      if (data && data.items && data.items.length) {
        // 地址补查：客户补报的地址覆盖命中条目；「地图上没有的地点」按关键词注入
        data.items = addrFix.applyToItems(data.items);
        data.items = addrFix.augment(data.items, {
          query: q.query,
          lng: args.lng,
          lat: args.lat,
          radius: args.radius,
        });
        // 个性化:常搜类目/去过的店同距离带加权上浮(距离仍是第一权重)
        data.items = userProfile.personalizeRank(data.items, devId);
        poiCacheSet(key, data);
      }
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

  /* ---------------- 地址补查（用户共创） ----------------
   * 客户发现地址缺失 / 不准 / 地图上没有的地点，一键补报；
   * 云端留存后，之后所有人的检索结果自动生效（详见 services/addrFix.js）。 */

  /** POST /api/v1/map/addr-fix { uid?, name, lng, lat, address, phone? } */
  'POST /map/addr-fix': async (req, res, q, body) => {
    const b = body || {};
    try {
      const rec = addrFix.submit({
        uid: b.uid,
        name: b.name,
        address: b.address,
        lng: b.lng,
        lat: b.lat,
        phone: b.phone,
        deviceId: b.deviceId || req.headers['x-device-id'] || 'anonymous',
      });
      logger.info('addr-fix', `${rec.merged ? '合并计票' : '新增'}: ${rec.name} @ ${rec.address}`);
      return ok(res, { id: rec.id, status: rec.status, merged: !!rec.merged, kind: rec.kind });
    } catch (e) {
      return fail(res, e.code || 5000, e.message || '提交失败');
    }
  },

  /** GET /api/v1/map/addr-fix/list?status=&kind=&page= —— 管理端审核/浏览 */
  'GET /map/addr-fix/list': async (req, res, q) => ok(res, addrFix.list(q)),

  /** POST /api/v1/map/addr-fix/status { id, status } —— 预留审核位 */
  'POST /map/addr-fix/status': async (req, res, q, body) => {
    const b = body || {};
    if (!b.id) return fail(res, 1001, 'id 必填');
    try {
      return ok(res, addrFix.setStatus(b.id, b.status));
    } catch (e) {
      return fail(res, e.code || 5000, e.message || '操作失败');
    }
  },

  /** GET /api/v1/map/addr-fix/summary —— 管理端看板 */
  'GET /map/addr-fix/summary': async (req, res) => ok(res, addrFix.summary()),

  /** GET /api/v1/map/ak-status —— AK 池健康诊断（多钥匙轮换状态） */
  'GET /map/ak-status': async (req, res) =>
    ok(res, {
      poolSize: baiduMap.akHealth().length,
      aks: baiduMap.akHealth(),
      hint:
        'BAIDU_AK 支持逗号分隔多把钥匙（.env 中配置该项，形如 ak1,ak2 逗号分隔）。' +
        '某把钥匙配额打满/被风控停用时自动冷却 10 分钟并切换下一把，无需人工干预。',
    }),
};
