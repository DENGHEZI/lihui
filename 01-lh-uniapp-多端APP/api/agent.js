/**
 * 鲤慧 LiHui · Agent 对话 API
 */
import { get, post } from './request.js'
import { getDeviceId, getPlan } from '../utils/token.js'
import { getCareMode } from '../utils/care.js'

function newSessionId() {
	return 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

export function chat({ text, sessionId, lng, lat, careMode, plan }) {
	return post('/agent/chat', {
		text,
		sessionId: sessionId || newSessionId(),
		deviceId: getDeviceId(),
		careMode: careMode === undefined ? getCareMode() : careMode,
		plan: plan || getPlan(),
		lng,
		lat
	})
}

export function listSessions() {
	return get('/agent/sessions')
}

export function clearSession(sessionId) {
	return post('/agent/sessions/clear', { sessionId })
}

/** 鲤慧当前会哪些技能（按套餐过滤） */
export function listTools(plan) {
	return get('/agent/tools', { plan: plan || getPlan() })
}

export { newSessionId }
