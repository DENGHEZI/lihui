/**
 * 鲤慧 LiHui · 地图能力 API（全部经服务端中转，端上不持有服务端 AK）
 */
import { get, post } from './request.js'

/** 自动锚定用户 IP —— 无需参数 */
export function locateByIp(city) {
	return get('/ip/locate', city ? { city } : {})
}

/** 端上 GPS 校正回传 */
export function reportLocation(lng, lat, accuracy) {
	return post('/loc/report', { lng, lat, accuracy: accuracy || 50 })
}

/** 地理编码：地址 → 坐标 */
export function geocode(address, city) {
	return get('/map/geocode', { address, city: city || '' })
}

/** 逆地理编码：坐标 → 地址 */
export function reverseGeocode(lng, lat) {
	return get('/map/reverse-geocode', { lng, lat })
}

/** 周边 POI 搜索 */
export function poiSearch(query, lng, lat, radius) {
	return get('/map/poi/search', {
		query,
		lng,
		lat,
		radius: radius || 1200,
		pageSize: 20
	})
}

/** 路线规划（端上传 lng,lat） */
export function planRoute({ mode = 'walking', origin, destination, realtime = false }) {
	return get('/map/route', {
		mode,
		origin: `${origin.lng},${origin.lat}`,
		destination: `${destination.lng},${destination.lat}`,
		realtime: realtime ? 'true' : 'false'
	})
}

/** 天气 */
export function weather({ lng, lat, district }) {
	return get('/map/weather', { lng, lat, district: district || '' })
}

/** 输入联想 */
export function suggest(keyword, city) {
	return get('/map/suggest', { keyword, city: city || '' })
}

/** 景点 / 休闲推荐 */
export function scenicRecommend(lng, lat, radius, tags) {
	return get('/map/scenic-recommend', { lng, lat, radius: radius || 3000, tags: tags || '' })
}
