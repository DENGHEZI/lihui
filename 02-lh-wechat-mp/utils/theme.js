/**
 * 鲤慧 LiHui · 明暗主题（白天 / 夜间）
 *
 * 页面接入（两步）：
 *   1. js：const theme = require('../../utils/theme.js')，onShow 里调用 theme.apply(this)
 *      （没有 onShow 的页面新增一个即可）
 *   2. wxml：根节点 class 加 {{theme === 'dark' ? 'theme-dark' : ''}}
 *
 * 变量在 app.wxss 定义：.theme-dark 会覆盖 --lh-* 色板，
 * 页面 wxss 一律用 var(--lh-*)，不要再硬编码 #FFF/#F4F5F7。
 */
const KEY = 'lh_theme'

function get() {
  try {
    return wx.getStorageSync(KEY) === 'dark' ? 'dark' : 'light'
  } catch (e) {
    return 'light'
  }
}

function set(t) {
  try {
    wx.setStorageSync(KEY, t === 'dark' ? 'dark' : 'light')
  } catch (e) {}
  return get()
}

function toggle() {
  return set(get() === 'dark' ? 'light' : 'dark')
}

/** 页面接入：写入 data.theme + 同步导航栏 / tabBar 配色 */
function apply(page) {
  const t = get()
  page.setData({ theme: t })
  try {
    if (t === 'dark') {
      wx.setNavigationBarColor({ frontColor: '#ffffff', backgroundColor: '#111318', fail: () => {} })
      wx.setTabBarStyle({
        color: '#7A828B',
        selectedColor: '#4C9AFF',
        backgroundColor: '#1C2027',
        borderStyle: 'black',
        fail: () => {}
      })
    } else {
      wx.setNavigationBarColor({ frontColor: '#000000', backgroundColor: '#EAF0FA', fail: () => {} })
      wx.setTabBarStyle({
        color: '#8F959E',
        selectedColor: '#1677FF',
        backgroundColor: '#FFFFFF',
        borderStyle: 'white',
        fail: () => {}
      })
    }
  } catch (e) {}
  return t
}

module.exports = { get, set, toggle, apply, KEY }
