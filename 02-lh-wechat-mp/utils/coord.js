/**
 * 坐标系工具：WGS-84 ↔ GCJ-02（火星）↔ BD-09（百度）
 * 与服务端 03-lh-server/src/utils/coord.js 保持同一套实现
 *
 * 为什么要这层：
 *   wx.getLocation({ type:'gcj02' }) 拿到的是火星坐标，而百度地图接口默认按
 *   BD-09（百度坐标系）解释入参坐标。两者在中国大陆相差约 500~1000 米，
 *   直接混用会造成「检索圆心偏 500~900m / POI 打点偏 / 距离算错」——
 *   正是"定位不够准"的主要元凶。
 *
 * 策略：小程序端全链路统一 GCJ-02
 *   1) 端上定位结果统一为 GCJ-02（IP 锚定的百度 BD-09 结果在这里换算）
 *   2) 所有百度接口显式声明坐标系（coord_type=3 / coordtype=gcj02）
 *   3) 服务端同向处理，返回坐标也是 GCJ-02
 *
 * ⚠️ 网上流传的「极坐标 hack」版换算在 lng≈112、lat≈28 这类大陆坐标上
 *    实测误差可达 4~5 公里，这里不用；改用椭球偏移实现，往返闭合 < 2m。
 */
const PI = Math.PI
const A = 6378245.0 // 克拉索夫斯基椭球长半轴
const EE = 0.00669342162296594323 // 偏心率平方

function outOfChina(lng, lat) {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271
}

function transformLat(x, y) {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x))
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0
  ret += ((20.0 * Math.sin(y * PI) + 40.0 * Math.sin((y / 3.0) * PI)) * 2.0) / 3.0
  ret += ((160.0 * Math.sin((y / 12.0) * PI) + 320 * Math.sin((y * PI) / 30.0)) * 2.0) / 3.0
  return ret
}

function transformLng(x, y) {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x))
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0
  ret += ((20.0 * Math.sin(x * PI) + 40.0 * Math.sin((x / 3.0) * PI)) * 2.0) / 3.0
  ret += ((150.0 * Math.sin((x / 12.0) * PI) + 300.0 * Math.sin((x * PI) / 30.0)) * 2.0) / 3.0
  return ret
}

function wgs84ToGcj02(lng, lat) {
  if (outOfChina(lng, lat)) return { lng, lat }
  let dLat = transformLat(lng - 105.0, lat - 35.0)
  let dLng = transformLng(lng - 105.0, lat - 35.0)
  const radLat = (lat / 180.0) * PI
  let magic = Math.sin(radLat)
  magic = 1 - EE * magic * magic
  const sqrtMagic = Math.sqrt(magic)
  dLat = (dLat * 180.0) / (((A * (1 - EE)) / (magic * sqrtMagic)) * PI)
  dLng = (dLng * 180.0) / ((A / sqrtMagic) * Math.cos(radLat) * PI)
  return { lng: lng + dLng, lat: lat + dLat }
}

function gcj02ToWgs84(lng, lat) {
  if (outOfChina(lng, lat)) return { lng, lat }
  const g = wgs84ToGcj02(lng, lat)
  return { lng: lng * 2 - g.lng, lat: lat * 2 - g.lat }
}

function gcj02ToBd09(lng, lat) {
  const w = gcj02ToWgs84(lng, lat)
  return { lng: w.lng + 0.0065, lat: w.lat + 0.006 }
}

function bd09ToGcj02(bdLng, bdLat) {
  const w = { lng: Number(bdLng) - 0.0065, lat: Number(bdLat) - 0.006 }
  return wgs84ToGcj02(w.lng, w.lat)
}

/** BD-09 → GCJ-02 安全版：坐标非法时返回 null */
function safeGcj02(lng, lat) {
  if (!isFinite(Number(lng)) || !isFinite(Number(lat))) return null
  const g = bd09ToGcj02(lng, lat)
  if (!isFinite(g.lng) || !isFinite(g.lat)) return null
  return g
}

module.exports = { gcj02ToBd09, bd09ToGcj02, safeGcj02, wgs84ToGcj02, gcj02ToWgs84 }
