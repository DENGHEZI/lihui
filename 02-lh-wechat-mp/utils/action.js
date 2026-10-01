/**
 * 鲤慧 LiHui · 小程序导航 / 外部跳转
 *
 * ⚠️ 安全设计（v1.1）：
 *  - 导航主路径：wx.openLocation 打开微信内置地图（用户可在内置地图中
 *    直接发起导航，并自选百度/高德/腾讯地图 App）——零依赖、100% 可用
 *  - 不再使用 navigateToMiniProgram + 硬编码 AppID
 *    （历史事故：错误 AppID 被误跳到美团小程序）
 */
const api = require('./api.js')

/** 打开内置地图并定位到目的地（用户点「导航」即可开始路线导航） */
function openNavigation(name, lng, lat, address) {
  return new Promise((resolve) => {
    if (!isFinite(Number(lng)) || !isFinite(Number(lat))) {
      wx.showToast({ title: '目的地坐标无效', icon: 'none' })
      resolve(false)
      return
    }
    wx.openLocation({
      latitude: Number(lat),
      longitude: Number(lng),
      name: name || '目的地',
      address: address || '',
      scale: 18,
      success: () => resolve(true),
      fail: () => {
        wx.setClipboardData({
          data: name || '',
          success: () => wx.showToast({ title: '已复制目的地，可粘贴到地图 App', icon: 'none' }),
          fail: () => {},
        })
        resolve(false)
      },
    })
  })
}

/** 兜底：复制文本到地图 App 搜索（不再做小程序间跳转，避免误跳） */
function jumpToApp() {
  return Promise.resolve({ app: 'clipboard' })
}

function searchInMap(keyword) {
  return new Promise((resolve) => {
    wx.setClipboardData({
      data: String(keyword || ''),
      success: () => {
        wx.showToast({ title: '已复制，去地图 App 搜索', icon: 'none' })
        resolve(true)
      },
      fail: () => resolve(false),
    })
  })
}

function callPhone(number) {
  wx.makePhoneCall({ phoneNumber: String(number), fail: () => {} })
}

module.exports = { openNavigation, jumpToApp, searchInMap, callPhone }
