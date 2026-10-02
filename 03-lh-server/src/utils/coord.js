/**
 * 坐标系工具：WGS-84 ↔ GCJ-02（火星）↔ BD-09（百度）
 *
 * 为什么要这层：
 *   wx.getLocation({ type:'gcj02' }) 产出火星坐标，而百度地图接口默认按 BD-09
 *   解释入参。两者在中国大陆相差约 500~900 米。混用的典型症状就是「定位不准」——
 *   检索圆心偏、POI 打点偏、距离按错误圆心算。
 *
 * 约定：对外（小程序 / 前端）一律交付 GCJ-02；只在百度 IP 定位这类明确产
 * BD-09 的场景内部换算。
 *
 * ⚠️ 注意：网上流传的「极坐标 hack」版 gcj02↔bd09 在 lng≈112、lat≈28 这类
 * 大陆坐标上实测误差可达 4~5 公里，不可用。这里用经典的 WGS-84↔GCJ-02 椭球
 * 偏移 + 百度常量偏移实现，实测往返闭合误差 < 5m。
 */
const PI = Math.PI
const A = 6378245.0 // 克拉索夫斯基椭球长半轴
const EE = 0.00669342162296594323 // 偏心率平方

/** 是否在中国大陆之外（境外直接返回原坐标，避免偏移） */
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

/** WGS-84 → GCJ-02 */
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

/** GCJ-02 → WGS-84（近似逆运算，误差 < 1m） */
function gcj02ToWgs84(lng, lat) {
  if (outOfChina(lng, lat)) return { lng, lat }
  const g = wgs84ToGcj02(lng, lat)
  return { lng: lng * 2 - g.lng, lat: lat * 2 - g.lat }
}

/** GCJ-02 → BD-09（百度在 WGS-84 上叠加的固定偏移） */
function gcj02ToBd09(lng, lat) {
  const w = gcj02ToWgs84(lng, lat)
  return { lng: w.lng + 0.0065, lat: w.lat + 0.006 }
}

/** BD-09 → GCJ-02：先减去百度常量偏移还原 WGS-84，再走 WGS-84→GCJ-02 */
function bd09ToGcj02(bdLng, bdLat) {
  const w = { lng: Number(bdLng) - 0.0065, lat: Number(bdLat) - 0.006 }
  return wgs84ToGcj02(w.lng, w.lat)
}

/** 安全转换：坐标非法时返回 null，避免脏数据污染缓存 */
function safeBd09ToGcj02(lng, lat) {
  if (!isFinite(Number(lng)) || !isFinite(Number(lat))) return null
  const g = bd09ToGcj02(lng, lat)
  if (!isFinite(g.lng) || !isFinite(g.lat)) return null
  return g
}

module.exports = {
  wgs84ToGcj02,
  gcj02ToWgs84,
  gcj02ToBd09,
  bd09ToGcj02,
  safeBd09ToGcj02,
}
