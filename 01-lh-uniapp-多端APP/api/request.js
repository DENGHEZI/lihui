/**
 * 鲤慧 LiHui · 统一请求封装
 *  - 自动带 X-Device-Id
 *  - 统一错误提示与降级
 *  - 记录服务端返回的 Token 消耗
 */
import config from '../utils/config.js'
import { getDeviceId, getPlan } from '../utils/token.js'

let lastTokenCost = 0
export function getLastTokenCost() {
	return lastTokenCost
}

export function request(path, { method = 'GET', data = {}, showLoading = false, loadingText = '加载中', timeout = 20000 } = {}) {
	if (showLoading) uni.showLoading({ title: loadingText, mask: true })
	return new Promise((resolve, reject) => {
		uni.request({
			url: config.BASE_URL + path,
			method,
			data,
			timeout,
			header: {
				'Content-Type': 'application/json',
				'X-Device-Id': getDeviceId(),
				'X-Plan': getPlan()
			},
			success: (res) => {
				const body = res.data || {}
				if (body.code === 0) {
					lastTokenCost = Number(res.header && res.header['X-Token-Cost']) || 0
					resolve(body.data)
					return
				}
				// 业务错误
				if (body.code === 1003) {
					uni.showModal({
						title: '额度用尽',
						content: body.msg || '今日 Token 配额已用完，可在「我的」查看消耗详情',
						showCancel: false
					})
				} else if (body.code === 3002) {
					uni.showModal({
						title: '还没有可用模型',
						content: '请先到「我的 → 模型设置」里添加一个模型',
						confirmText: '去设置',
						success: (r) => {
							if (r.confirm) uni.navigateTo({ url: '/pages/settings/settings' })
						}
					})
				} else {
					uni.showToast({ title: body.msg || '请求失败', icon: 'none', duration: 2200 })
				}
				reject(body)
			},
			fail: (err) => {
				uni.showToast({ title: '网络异常，请检查服务端是否启动', icon: 'none', duration: 2500 })
				reject(err)
			},
			complete: () => {
				if (showLoading) uni.hideLoading()
			}
		})
	})
}

export function get(path, data, opts) {
	return request(path, { method: 'GET', data, ...(opts || {}) })
}

export function post(path, data, opts) {
	return request(path, { method: 'POST', data, ...(opts || {}) })
}
