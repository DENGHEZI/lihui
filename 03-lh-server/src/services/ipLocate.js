/**
 * 鲤慧 LiHui · IP 自动锚定
 * 策略链：真实公网 IP → 百度 IP 定位 → 端上 GPS 校正回写 → 内置城市兜底
 */
const baiduMap = require('./baiduMap');
const { Cache } = require('../utils/cache');
const { isPrivateIp } = require('../utils/http');
const { safeBd09ToGcj02 } = require('../utils/coord');
const logger = require('../utils/logger');

const cache = new Cache(1000);
const CORRECTION = new Map(); // ip -> {lng,lat,accuracy,ts}  端上 GPS 校正结果

const isLocal = (ip) => !ip || ip === '127.0.0.1' || ip === '::1' || isPrivateIp(ip);

/**
 * 自动锚定
 * @param {string} ip 客户端 IP（可为内网地址）
 * @param {object} opts { fallbackCity }
 */
async function locate(ip, opts = {}) {
  const out = {
    ip: ip || '',
    local: isLocal(ip),
    city: '',
    province: '',
    district: '',
    isp: '',
    point: null,
    confidence: 0,
    source: '',
    cached: false,
  };

  // 1) 端上 GPS 校正优先（同一 IP 30 分钟内）
  const corr = ip ? CORRECTION.get(ip) : null;
  if (corr && Date.now() - corr.ts < 30 * 60 * 1000) {
    out.point = { lng: corr.lng, lat: corr.lat };
    out.pointCoord = 'gcj02'; // 端上报的是 GCJ-02，后续不再换算
    out.confidence = 0.98;
    out.source = 'client-gps';
  }

  // 2) 缓存
  const ck = `loc:${ip || 'local'}`;
  if (!out.point) {
    const hit = cache.get(ck);
    if (hit) {
      return { ...hit, cached: true };
    }
  }

  // 3) 百度 IP 定位
  if (!out.point) {
    try {
      const r = await baiduMap.ipLocate(isLocal(ip) ? '' : ip);
      Object.assign(out, r, { local: isLocal(ip) });
      out.confidence = r.confidence;
      out.source = 'baidu-ip';
    } catch (e) {
      logger.warn('ipLocate', `baidu ip locate failed: ${e.message}`);
    }
  }

  // 4) 兜底
  if (!out.point) {
    const fb = baiduMap.fallbackLocate(opts.fallbackCity || '长沙市');
    Object.assign(out, fb, { ip: ip || '', local: isLocal(ip) });
  }

  // 5) 用坐标补一次逆地理，拿到区县（提升端上展示精度）
  //    ⚠️ 百度 IP 定位产出的是 BD-09，此处必须按 bd09ll 反查，否则反查点偏移 500~900m
  if (out.point && !out.district) {
    const revCoord = out.pointCoord === 'gcj02' ? 'gcj02' : 'bd09ll';
    try {
      const rev = await baiduMap.reverseGeocode(out.point.lng, out.point.lat, revCoord);
      out.city = out.city || rev.city;
      out.province = out.province || rev.province;
      out.district = rev.district || '';
      out.districtName = rev.formatted;
    } catch (_) {}
  }

  // 6) 对外统一 GCJ-02：百度 IP 定位给的是 BD-09，先换算再下发，
  //    否则端上拿它当 GCJ-02 用，等于又引入 500~900m 偏差
  // 端上报上来的 GPS 已是 GCJ-02（source=client-gps），不能重复换算
  if (out.point && out.pointCoord !== 'gcj02') {
    const g = safeBd09ToGcj02(out.point.lng, out.point.lat);
    if (g) out.point = g;
  }

  if (out.city || out.point) cache.set(ck, out, 30 * 60 * 1000);
  return out;
}

/** 端上 GPS 校正回写 */
function report(ip, lng, lat, accuracy = 50) {
  if (!ip) return false;
  CORRECTION.set(ip, { lng: Number(lng), lat: Number(lat), accuracy: Number(accuracy), ts: Date.now() });
  cache.del(`loc:${ip}`);
  return true;
}

module.exports = { locate, report };
