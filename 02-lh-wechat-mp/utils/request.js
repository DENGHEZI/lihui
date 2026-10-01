/**
 * 鲤慧 LiHui · 微信小程序请求封装
 */
const config = require('./config.js')
const { getDeviceId, getPlan } = require('./token.js')

let lastTokenCost = 0

function request(path, { method = 'GET', data = {}, loading = false, loadingText = '加载中' } = {}) {
  if (loading) wx.showLoading({ title: loadingText, mask: true })
  return new Promise((resolve, reject) => {
    wx.request({
      url: config.BASE_URL + path,
      method,
      data,
      timeout: 20000,
      header: {
        'Content-Type': 'application/json',
        'X-Device-Id': getDeviceId(),
        'X-Plan': getPlan()
      },
      success: (res) => {
        const body = res.data || {}
        if (body.code === 0) {
          lastTokenCost = Number((res.header && res.header['X-Token-Cost']) || res.header && res.header['x-token-cost']) || 0
          resolve(body.data)
          return
        }
        if (body.code === 1003) {
          wx.showModal({ title: '额度用尽', content: body.msg || '今日 Token 配额已用完', showCancel: false })
        } else if (body.code === 3002) {
          wx.showModal({
            title: '还没有可用模型',
            content: '请先到「我的 → 模型与语音设置」添加一个模型',
            confirmText: '去设置',
            success: (r) => {
              if (r.confirm) wx.navigateTo({ url: '/pages/settings/settings' })
            }
          })
        } else {
          wx.showToast({ title: body.msg || '请求失败', icon: 'none', duration: 2200 })
        }
        reject(body)
      },
      fail: (err) => {
        wx.showToast({ title: '网络异常，请确认服务端已启动且域名已加入白名单', icon: 'none', duration: 2600 })
        reject(err)
      },
      complete: () => {
        if (loading) wx.hideLoading()
      }
    })
  })
}

const get = (path, data, opts) => request(path, Object.assign({ method: 'GET', data }, opts || {}))
const post = (path, data, opts) => request(path, Object.assign({ method: 'POST', data }, opts || {}))

module.exports = { request, get, post, getLastTokenCost: () => lastTokenCost }
