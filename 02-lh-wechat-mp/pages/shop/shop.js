/**
 * 鲤慧 · 商城列表（类目 + 关键词 + 距离排序）
 * 这里只负责选品；下单在 detail 页，支付在第三方平台完成。
 */
const api = require('../../utils/api.js')
const app = getApp()

Page({
  data: {
    keyword: '',
    categories: [],
    curCat: '',
    list: [],
    loading: true,
    thirdName: '携程 / 美团'
  },

  async onLoad() {
    try {
      const c = await api.shopCategories()
      // 「全部」永远排在最前
      this.setData({ categories: [{ key: '', name: '全部', icon: '🗂️' }].concat(c.items || []) })
    } catch (e) {
      console.warn('[鲤慧-商城] 类目加载失败', e)
    }
    this.load()
  },

  onShow() {
    // 切回页面时若定位已更新，重新算一次距离
    if (this.data.list.length && app.globalData.location) this.load()
  },

  async load() {
    this.setData({ loading: true })
    const loc = app.globalData.location || {}
    try {
      const d = await api.shopItems({
        category: this.data.curCat,
        keyword: this.data.keyword,
        lng: loc.lng,
        lat: loc.lat
      })
      this.setData({ list: d.items || [], loading: false })
    } catch (e) {
      this.setData({ loading: false })
      wx.showToast({ title: (e && (e.msg || e.errMsg)) || '商品加载失败', icon: 'none', duration: 2200 })
    }
  },

  onCatTap(e) {
    this.setData({ curCat: e.currentTarget.dataset.k })
    this.load()
  },

  onKeyword(e) {
    this.setData({ keyword: e.detail.value })
  },

  onSearch() {
    this.load()
  },

  clearKeyword() {
    this.setData({ keyword: '' })
    this.load()
  },

  goDetail(e) {
    wx.navigateTo({ url: '/pages/shop/detail?id=' + encodeURIComponent(e.currentTarget.dataset.id) })
  },

  onShareAppMessage() {
    return { title: '鲤慧商城 · 酒店门票本地服务，一键下单', path: '/pages/shop/shop' }
  }
})
