/**
 * 鲤慧 LiHui · 用户自定义模型 / 语音 / 平台适配 API
 */
import { get, post } from './request.js'

/* ---------------- 模型 ---------------- */
export function listModels(reveal) {
	return get('/model/list', reveal ? { reveal: 'true' } : {})
}
export function saveModel(model) {
	return post('/model/save', model)
}
export function testModel(payload) {
	return post('/model/test', payload)
}
export function setDefaultModel(id) {
	return post('/model/default', { id })
}
export function removeModel(id) {
	return post('/model/remove', { id })
}
export function activeModel() {
	return get('/model/active')
}

/* ---------------- 语音 ---------------- */
export function getVoiceConfig() {
	return get('/voice/config')
}
export function saveVoiceConfig(cfg) {
	return post('/voice/config', cfg)
}
export function tts(text, opts) {
	return post('/voice/tts', { text, ...(opts || {}) })
}

/* ---------------- 平台 ---------------- */
export function publicConfig() {
	return get('/config/public')
}
export function health() {
	return get('/health')
}

/* ---------------- 位置 ---------------- */
/**
 * 获取位置：优先端上 GPS，失败或精度不足时回落 IP 锚定
 * @returns {Promise<{lng, lat, city, district, source, accuracy}>}
 */
export function getLocation() {
	return new Promise((resolve) => {
		uni.getLocation({
			type: 'gcj02',
			geocode: true,
			success: (res) => {
				resolve({
					lng: res.longitude,
					lat: res.latitude,
					city: (res.address && res.address.city) || '',
					district: (res.address && res.address.district) || '',
					accuracy: res.accuracy || 50,
					source: 'gps'
				})
			},
			fail: () => {
				// GPS 不可用 → IP 锚定
				import('./map.js').then((m) => {
					m.locateByIp().then((d) => {
						resolve({
							lng: d.point ? d.point.lng : 112.938814,
							lat: d.point ? d.point.lat : 28.228209,
							city: d.city || '',
							district: d.district || '',
							accuracy: 2000,
							source: 'ip'
						})
					}).catch(() => {
						resolve({ lng: 112.938814, lat: 28.228209, city: '长沙市', district: '', accuracy: 5000, source: 'fallback' })
					})
				})
			}
		})
	})
}
