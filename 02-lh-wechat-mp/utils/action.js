/**
 * 鲤慧 LiHui · 小程序外部跳转
 *  - 微信内：navigateToMiniProgram 跳到百度地图/高德小程序
 *  - 其他：提示用户复制地址或手动打开
 */
const api = require('./api.js')

/* 常用地图小程序 AppID */
const MINI = {
  百度地图: { appId: 'wxde8ac0a21135c07d', path: 'pages/index/index' },
  高德地图: { appId: 'wxde8ac0a21135c07d', path: 'pages/index/index' }
}

function jumpToApp(payload) {
  return api.openApp(payload).then((info) => {
    return new Promise((resolve) => {
      const target = MINI[info.app]
      if (target) {
        wx.navigateToMiniProgram({
          appId: target.appId,
          path: target.path,
          success: () => resolve(true),
          fail: () => {
            wx.showModal({
              title: '跳转失败',
              content: `未能打开「${info.app}」。\n可复制以下地址到地图 App 搜索：\n${payload.keyword || payload.destination || ''}`,
              showCancel: false
            })
            resolve(false)
          }
        })
        return
      }
      wx.setClipboardData({
        data: info.uri || '',
        success: () => {
          wx.showToast({ title: '已复制跳转地址', icon: 'none' })
          resolve(true)
        },
        fail: () => resolve(false)
      })
    })
  })
}

function navigateTo(destinationName, origin, mode) {
  return jumpToApp({
    app: '百度地图',
    type: 'direction',
    origin: origin ? `${origin.lat},${origin.lng}` : '我的位置',
    destination: destinationName,
    mode: mode || 'walking'
  })
}

function searchInMap(keyword, city) {
  return jumpToApp({ app: '百度地图', type: 'search', keyword, city })
}

function callPhone(number) {
  wx.makePhoneCall({ phoneNumber: String(number), fail: () => {} })
}

module.exports = { jumpToApp, navigateTo, searchInMap, callPhone, MINI }
