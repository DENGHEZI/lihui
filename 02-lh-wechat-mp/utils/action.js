/**
 * 鲤慧 LiHui · 小程序导航 / 外部跳转（v2）
 *
 * 安全设计：
 *  - 地点导航主路径：wx.openLocation 打开微信内置地图（零依赖、100% 可用，
 *    用户可在内置地图中自选百度/高德/腾讯 App 继续 navigation）
 *  - 平台跳转：仅允许「白名单」内、AppID 已核实的第三方小程序（防止历史
 *    上错误 AppID 误跳美团的事故再次发生）；白名单外一律回落复制
 *
 * 白名单 AppID 来源（微信开放社区 / 官方社区实战帖核实，2026-10）：
 *  - 美团外卖  wx2c348cf579062e56
 *  - 饿了么    wxece3a9a4c82f58c9
 *  - 滴滴出行  wxaf35009675aa0b2a
 */
const api = require('./api.js')

/** 已核实的第三方平台白名单（跳转前必须用户确认，微信强制要求） */
const PLATFORM_WHITELIST = [
  { key: 'meituan', app: '美团外卖', appId: 'wx2c348cf579062e56' },
  { key: 'eleme', app: '饿了么', appId: 'wxece3a9a4c82f58c9' },
  { key: 'didi', app: '滴滴出行', appId: 'wxaf35009675aa0b2a' }
]

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

/**
 * 平台跳转：白名单内 → navigateToMiniProgram；白名单外 → 复制兜底
 * @returns {Promise<{app:string, jumped:boolean}>}
 */
function jumpToApp(opts) {
  opts = opts || {}
  const wanted = String(opts.app || '').trim()
  const hit =
    PLATFORM_WHITELIST.find((p) => p.app === wanted) ||
    PLATFORM_WHITELIST.find((p) => wanted.includes(p.app) || p.app.includes(wanted))

  if (!hit) {
    // 白名单外：复制目的地，提示用户自行打开对应平台
    return wx.setClipboardData
      ? new Promise((resolve) => {
          wx.setClipboardData({
            data: String(opts.destination || wanted || ''),
            success: () => {
              wx.showToast({ title: '暂未接入「' + (wanted || '该平台') + '」，已复制名称', icon: 'none', duration: 2200 })
              resolve({ app: 'clipboard', jumped: false })
            },
            fail: () => resolve({ app: 'clipboard', jumped: false }),
          })
        })
      : Promise.resolve({ app: 'clipboard', jumped: false })
  }

  return new Promise((resolve) => {
    wx.navigateToMiniProgram({
      appId: hit.appId,
      path: '',
      envVersion: 'release',
      success: () => resolve({ app: hit.app, jumped: true }),
      fail: (e) => {
        wx.setClipboardData({
          data: String(opts.destination || ''),
          success: () => wx.showToast({ title: '打开失败，已复制目的地', icon: 'none' }),
          fail: () => {},
        })
        console.warn('[鲤慧-跳转] navigateToMiniProgram fail:', e)
        resolve({ app: hit.app, jumped: false })
      },
    })
  })
}

/** 当前可跳转的平台清单（供页面展示「推荐平台」） */
function listPlatforms() {
  return PLATFORM_WHITELIST.map((p) => ({ app: p.app, key: p.key }))
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

module.exports = { openNavigation, jumpToApp, listPlatforms, searchInMap, callPhone }
