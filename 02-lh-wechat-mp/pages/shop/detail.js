/**
 * 鲤慧 · 商品详情 + 下单
 *
 * 流程：选规格/日期/数量 → 填联系人手机 → 提交 → 生成订单（留在鲤慧）
 *       → 用户点「去支付」跳携程/美团小程序完成付款（鲤慧只做留痕，不收钱）
 */
const api = require('../../utils/api.js')
const { getDeviceId } = require('../../utils/token.js')
const app = getApp()

/** 本地订单缓存 key（离线也能看「我的订单」） */
const LOCAL_ORDERS = 'lh_orders'

function todayStr(offset = 0) {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

Page({
  data: {
    item: null,
    specs: [],
    spec: '',
    qty: 1,
    date: '',
    today: todayStr(),
    maxDate: todayStr(180),
    name: '',
    phone: '',
    remark: '',
    total: 0,
    submitting: false
  },

  async onLoad(q) {
    if (!q || !q.id) {
      wx.showToast({ title: '商品不存在', icon: 'none' })
      setTimeout(() => wx.navigateBack(), 800)
      return
    }
    try {
      const item = await api.shopItem(decodeURIComponent(q.id))
      if (!item) throw new Error('商品不存在或已下架')
      const specs = item.specs || []
      this.setData({
        item,
        specs,
        spec: specs[0] || ''
      })
      this.recalc()
      // 已在「我的」页填过的联系人/手机自动带过来
      const profile = wx.getStorageSync('lh_profile') || {}
      if (profile.name) this.setData({ name: profile.name })
      if (profile.phone) this.setData({ phone: profile.phone })
    } catch (e) {
      wx.showToast({ title: (e && e.msg) || '商品加载失败', icon: 'none' })
      setTimeout(() => wx.navigateBack(), 1000)
    }
  },

  recalc() {
    const { item, qty } = this.data
    if (!item) return
    this.setData({ total: Number(item.price) * Number(qty) })
  },

  pickSpec(e) {
    this.setData({ spec: e.currentTarget.dataset.s })
  },

  onName(e) {
    this.setData({ name: e.detail.value })
  },

  onPhone(e) {
    this.setData({ phone: e.detail.value })
  },

  onRemark(e) {
    this.setData({ remark: e.detail.value })
  },

  onDate(e) {
    this.setData({ date: e.detail.value })
  },

  onQtyMinus() {
    if (this.data.qty <= 1) return
    this.setData({ qty: this.data.qty - 1 }, () => this.recalc())
  },

  onQtyPlus() {
    if (this.data.qty >= 99) return
    this.setData({ qty: this.data.qty + 1 }, () => this.recalc())
  },

  async submit() {
    const { item, qty, spec, date, name, phone, remark, submitting } = this.data
    if (submitting) return
    if (!name.trim()) return wx.showToast({ title: '请填写联系人', icon: 'none' })
    if (!/^1[3-9]\d{9}$/.test(phone.trim())) return wx.showToast({ title: '请填写正确手机号', icon: 'none' })

    this.setData({ submitting: true })
    const loc = app.globalData.location || {}
    try {
      const order = await api.orderCreate({
        itemId: item.id,
        spec,
        qty,
        date,
        name: name.trim(),
        phone: phone.trim(),
        remark: remark.trim(),
        lng: loc.lng,
        lat: loc.lat
      })
      // 本地留一份 + 记住联系人，下次下单少填一遍
      this.saveLocal(order)
      wx.setStorageSync('lh_profile', { name: name.trim(), phone: phone.trim() })

      wx.showModal({
        title: '下单成功',
        content: `订单号 ${order.no}\n鲤慧已为你记录，接下来到${order.supplier.platformName || '第三方'}完成支付即可。`,
        confirmText: '去支付',
        cancelText: '稍后再说',
        success: (r) => {
          if (r.confirm) this.gotoPlatform(order)
          else wx.redirectTo({ url: '/pages/order/detail?no=' + order.no })
        }
      })
    } catch (e) {
      wx.showToast({ title: (e && (e.msg || e.errMsg)) || '下单失败，请重试', icon: 'none', duration: 2400 })
    } finally {
      this.setData({ submitting: false })
    }
  },

  saveLocal(order) {
    try {
      const list = wx.getStorageSync(LOCAL_ORDERS) || []
      if (!list.some((x) => x.no === order.no)) {
        wx.setStorageSync(LOCAL_ORDERS, [order].concat(list))
      }
    } catch (e) {}
  },

  /** 跳第三方平台（携程 / 美团小程序），失败则复制关键词兜底 */
  gotoPlatform(order) {
    const s = (order && order.supplier) || {}
    if (s.appId) {
      wx.navigateToMiniProgram({
        appId: s.appId,
        success: () => {},
        fail: () => this.copyKeyword(order)
      })
      return
    }
    this.copyKeyword(order)
  },

  copyKeyword(order) {
    const kw = (order.supplier && order.supplier.keyword) || order.itemName || ''
    wx.setClipboardData({
      data: kw,
      success: () => wx.showToast({ title: '已复制「' + kw + '」，去平台搜索下单', icon: 'none', duration: 2600 })
    })
  },

  onShareAppMessage() {
    const item = this.data.item || {}
    return { title: item.name || '鲤慧商城', path: '/pages/shop/shop' }
  }
})
