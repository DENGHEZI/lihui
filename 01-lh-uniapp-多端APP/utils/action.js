/**
 * 鲤慧 LiHui · 外部应用跳转（赛题：模型给出地址后可自动跳转到相应界面）
 *  - App（Android / HarmonyOS / iOS）：plus.runtime.openURL
 *  - 微信小程序：wx.navigateToMiniProgram
 *  - H5：location.href
 */
import { openApp } from '../api/life.js'
import { logAction } from './token.js'

/**
 * 打开外部应用
 * @param {object} payload { app, type, origin, destination, keyword, mode, city }
 */
export async function jumpToApp(payload) {
	const info = await openApp(payload)
	if (!info) throw new Error('未获取到跳转信息')

	logAction({ action: 'open_app', app: info.app, uri: info.uri })

	// #ifdef APP-PLUS
	return new Promise((resolve) => {
		plus.runtime.openURL(info.uri, () => {
			uni.showToast({ title: `未安装「${info.app}」`, icon: 'none' })
			resolve(false)
		})
		resolve(true)
	})
	// #endif

	// #ifdef MP-WEIXIN
	if (info.miniProgram && info.miniProgram.appId) {
		return new Promise((resolve) => {
			wx.navigateToMiniProgram({
				appId: info.miniProgram.appId,
				success: () => resolve(true),
				fail: () => {
					uni.showToast({ title: '跳转失败，请手动打开地图应用', icon: 'none' })
					resolve(false)
				}
			})
		})
	}
	// #endif

	// #ifdef H5
	try {
		window.location.href = info.uri
		return true
	} catch (e) {
		return false
	}
	// #endif

	return false
}

/** 一键导航到某坐标/名称 */
export function navigateTo(destinationName, origin, mode) {
	return jumpToApp({
		app: '百度地图',
		type: 'direction',
		origin: origin ? `${origin.lat},${origin.lng}` : '我的位置',
		destination: destinationName,
		mode: mode || 'walking'
	})
}

/** 在地图上搜索关键词 */
export function searchInMap(keyword, city) {
	return jumpToApp({ app: '百度地图', type: 'search', keyword, city })
}

/** 拨打电话（适老场景） */
export function callPhone(number) {
	uni.makePhoneCall({ phoneNumber: String(number), fail: () => {} })
}
