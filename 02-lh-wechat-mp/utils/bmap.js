/**
 * 鲤慧 LiHui · 百度地图端封装（2026-10-07 改为服务端中转）
 *
 * 变更原因：直连百度用的端上 AK 报「APP Referer 校验失败 / 被禁用」——
 * 微信小程序的请求 Referer 固定为 servicewechat.com/{appid}，百度控制台
 * 白名单一旦没配就全挂，且端上明文持 AK 本身就是泄露面。
 *
 * 现在全部走服务端中转（/map/* 端点，AK 只存服务端 .env，附缓存与限流），
 * 与 utils/api.js 同一通道（云托管 callContainer / request 自适应）。
 * 导出签名与返回形状与旧直连版完全一致，调用页（index/route）零改动。
 */
const config = require('./config.js')
const { get } = require('./request.js')
const api = require('./api.js')

/** 地址 → 坐标（服务端 ret_coordtype=gcj02，坐标系一致） */
function geocode(address, city) {
  return api.geocode(address, city).then((d) => ({
    lng: Number(d.lng),
    lat: Number(d.lat),
    level: d.level || ''
  }))
}

/** 坐标 → 地址 */
function reverseGeocode(lng, lat) {
  return api.reverseGeocode(lng, lat).then((d) => ({
    formatted: d.formatted || '',
    city: d.city || '',
    district: d.district || '',
    province: d.province || ''
  }))
}

/** 输入联想（服务端已拍平为 {name,district,lng,lat}，坐标系 gcj02） */
function suggest(keyword, city) {
  return get('/map/suggest', { keyword, city: city || '' }, { cacheTtl: 5 * 60 * 1000 }).then((list) =>
    (list || []).map((x) => ({
      name: x.name,
      district: x.district,
      lng: x.lng !== undefined ? Number(x.lng) : null,
      lat: x.lat !== undefined ? Number(x.lat) : null
    }))
  )
}

/** 周边 POI（服务端已带 RRF 融合 + 地址补查 + 个性化排序，形状兼容） */
function poiSearch(query, lng, lat, radius) {
  return api.poiSearch(query, lng, lat, radius).then((d) => ({
    total: (d && d.total) || 0,
    items: ((d && d.items) || []).map((x) => ({
      uid: x.uid,
      name: x.name,
      address: x.address,
      lng: Number(x.lng),
      lat: Number(x.lat),
      distance: x.distance !== undefined && x.distance !== null ? Number(x.distance) : null,
      tag: x.tag || '',
      rating: x.rating || null
    }))
  }))
}

/**
 * 兼容透传：旧版把百度原始响应透给调用方；现在无直连能力。
 * 仅映射已知路径到服务端端点，未映射路径直接报错（避免滥用透传通道）。
 */
const PATH_MAP = {
  '/geocoding/v3/': (p) => get('/map/geocode', { address: p.address, city: p.city || '' }),
  '/reverse_geocoding/v3/': (p) => {
    // 旧直连参数是 location:'lat,lng'，兼容 lat,lng 与 {lng,lat} 两种
    let lng = p.lng, lat = p.lat
    if (p.location && typeof p.location === 'string') {
      const [a, b] = p.location.split(',')
      lat = lat || Number(a); lng = lng || Number(b)
    }
    return get('/map/reverse-geocode', { lng, lat })
  },
  '/place/v2/search': (p) => {
    let lng = p.lng, lat = p.lat
    if (p.location && typeof p.location === 'string') {
      const [a, b] = p.location.split(',')
      lat = lat || Number(a); lng = lng || Number(b)
    }
    return get('/map/poi/search', { query: p.query, lng, lat, radius: p.radius })
  }
}

function call(pathname, params) {
  const fn = PATH_MAP[pathname]
  if (!fn) return Promise.reject(new Error(`该接口已改为服务端中转，未映射路径：${pathname}（请改用 geocode/reverseGeocode/suggest/poiSearch）`))
  return fn(params || {})
}

module.exports = { call, geocode, reverseGeocode, suggest, poiSearch }
