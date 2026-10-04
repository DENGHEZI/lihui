/**
 * 鲤慧 LiHui · 30 分钟生活圈 API
 */
import { get, post } from './request.js'

/** 生活圈体检报告 */
export function lifeReport(lng, lat, radius) {
	return get('/life/report', { lng, lat, radius: radius || 1200 })
}

/** 个性化生活圈方案 */
export function customizePlan({ lng, lat, preference }) {
	return post('/life/customize', { lng, lat, preference: preference || {} })
}

/** 用户反馈 */
export function submitFeedback(payload) {
	return post('/feedback', payload)
}

/** Token 消耗统计 */
export function tokenStats(range) {
	return get('/token/stats', { range: range || '7d' })
}

/** Token 预估 */
export function tokenEstimate(text) {
	return post('/token/estimate', { text })
}

/** 打开外部应用（返回 URI Scheme） */
export function openApp(payload) {
	return post('/action/open-app', payload)
}

/** 桌面应用操作方案 */
export function desktopOperate(payload) {
	return post('/action/desktop-operate', payload)
}
