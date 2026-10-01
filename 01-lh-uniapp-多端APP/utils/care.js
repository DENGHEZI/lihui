/**
 * 鲤慧 LiHui · 关怀模式（老年人）
 * 大字、高对比、慢速语音、单步引导
 */
const KEY_CARE = 'lh_care_mode'
const KEY_LOCATION = 'lh_last_location'

export function getCareMode() {
	try {
		return !!uni.getStorageSync(KEY_CARE)
	} catch (e) {
		return false
	}
}

export function setCareMode(on) {
	try {
		uni.setStorageSync(KEY_CARE, !!on)
	} catch (e) {}
	// 同步注入全局 class（H5 / App 端有效）
	try {
		if (typeof document !== 'undefined' && document.body) {
			document.body.className = on ? 'care-mode' : ''
		}
	} catch (e) {}
	return !!on
}

export function toggleCareMode() {
	return setCareMode(!getCareMode())
}

/** 缓存最近一次定位，避免每次冷启动都重新拉取 */
export function saveLastLocation(loc) {
	try {
		uni.setStorageSync(KEY_LOCATION, { ...loc, ts: Date.now() })
	} catch (e) {}
}

export function getLastLocation(maxAgeMs = 30 * 60 * 1000) {
	try {
		const loc = uni.getStorageSync(KEY_LOCATION)
		if (loc && Date.now() - loc.ts < maxAgeMs) return loc
	} catch (e) {}
	return null
}
