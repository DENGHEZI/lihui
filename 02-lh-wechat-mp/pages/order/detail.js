/**
 * 鲤慧 · 订单详情
 */
const api = require('../../utils/api.js')

const theme = require('../../utils/theme.js')
const STATUS_TEXT = { pending: '待支付', paid: '已下单', done: '已完成', cancelled: '已取消' }

Page({
  onShow() {
    theme.apply(this)
  },

  data: { order: null },

  async onLoad(q) {
    if (!q || !q.no) {
      wx.showToast({ title: '订单不存在', icon: 'none' })
      setTimeout(() => wx.navigateBack(), 700)
      return
    }
    this._no = q.no
    this.loadLocal()
    try {
      const o = await api.orderDetail(q.no)
      if (o) o.statusText = STATUS_TEXT[o.status] || o.status
      this.setData({ order: o })
    } catch (e) {
      console.warn('[鲤慧-订单] 详情拉取失败，用本地数据', e)
    }
  },

  loadLocal() {
    try {
      const list = wx.getStorageSync('lh_orders') || []
      const hit = list.find((x) => x.no === this._no)
      if (hit && !this.data.order) {
        hit.statusText = STATUS_TEXT[hit.status] || hit.status
        this.setData({ order: hit })
      }
    } catch (e) {}
  },

  gotoPay() {
    const s = (this.data.order && this.data.order.supplier) || {}
    if (s.appId) {
      wx.navigateToMiniProgram({ appId: s.appId, fail: () => this.copyKeyword() })
      return
    }
    this.copyKeyword()
  },

  copyKeyword() {
    const o = this.data.order
    const kw = (o && o.supplier && o.supplier.keyword) || (o && o.itemName) || ''
    wx.setClipboardData({
      data: kw,
      success: () => wx.showToast({ title: '已复制「' + kw + '」，去平台搜索下单', icon: 'none', duration: 2600 })
    })
  },

  cancel() {
    wx.showModal({
      title: '取消订单',
      content: '确定取消这条订单吗？',
      confirmColor: '#F5222D',
      success: async (r) => {
        if (!r.confirm) return
        try {
          await api.orderStatus(this._no, 'cancelled')
        } catch (e) {}
        this.apply('cancelled')
        wx.showToast({ title: '已取消', icon: 'none' })
      }
    })
  },

  async finish() {
    try {
      await api.orderStatus(this._no, 'done')
    } catch (e) {}
    this.apply('done')
    wx.showToast({ title: '已标记完成', icon: 'none' })
  },

  apply(status) {
    const o = this.data.order
    if (!o) return
    o.status = status
    o.statusText = STATUS_TEXT[status] || status
    this.setData({ order: o })
    // 同步本地
    try {
      const list = wx.getStorageSync('lh_orders') || []
      wx.setStorageSync(
        'lh_orders',
        list.map((x) => (x.no === o.no ? { ...x, status } : x))
      )
    } catch (e) {}
  },

  onShareAppMessage() {
    return { title: '我的鲤慧订单', path: '/pages/order/list' }
  }
})
