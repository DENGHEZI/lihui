/**
 * 鲤慧 LiHui · 设备指纹与本地 Token
 */
const KEY_DEVICE = 'lh_device_id'
const KEY_PLAN = 'lh_plan'
const KEY_ACTION_LOG = 'lh_action_log'

function randomId() {
	let s = ''
	const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
	for (let i = 0; i < 16; i++) s += chars[Math.floor(Math.random() * chars.length)]
	return s
}

export function ensureDeviceId() {
	let id = ''
	try {
		id = uni.getStorageSync(KEY_DEVICE)
	} catch (e) {}
	if (!id) {
		id = 'dev_' + Date.now().toString(36) + randomId().slice(0, 8)
		try {
			uni.setStorageSync(KEY_DEVICE, id)
		} catch (e) {}
	}
	return id
}

export function getDeviceId() {
	try {
		return uni.getStorageSync(KEY_DEVICE) || ensureDeviceId()
	} catch (e) {
		return ensureDeviceId()
	}
}

export function getPlan() {
	try {
		return uni.getStorageSync(KEY_PLAN) || 'pro'
	} catch (e) {
		return 'pro'
	}
}

export function setPlan(plan) {
	try {
		uni.setStorageSync(KEY_PLAN, plan)
	} catch (e) {}
}

/** 本地操作日志（桌面应用操作的可追溯记录，保留 7 天） */
export function logAction(action) {
	try {
		const list = uni.getStorageSync(KEY_ACTION_LOG) || []
		const now = Date.now()
		const kept = list.filter((x) => now - x.ts < 7 * 24 * 3600 * 1000)
		kept.push({ ...action, ts: now })
		uni.setStorageSync(KEY_ACTION_LOG, kept.slice(-200))
	} catch (e) {}
}

export function getActionLog() {
	try {
		return uni.getStorageSync(KEY_ACTION_LOG) || []
	} catch (e) {
		return []
	}
}
