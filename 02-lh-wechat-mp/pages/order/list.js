/**
 * 鲤慧 · 我的订单（本地缓存 + 服务端双写，离线也能看）
 */
const api = require('../../utils/api.js')
const { getDeviceId } = require('../../utils/token.js')
const theme = require('../../utils/theme.js')
const LOCAL_ORDERS = 'lh_orders'

const STATUS_TEXT = { pending: '待支付', paid: '已下单', done: '已完成', cancelled: '已取消' }

Page({
  data: { list: [], cur: '' },
  STATUS_TEXT,

  onShow() {
    theme.apply(this)
    this.load()
  },

  async load() {
    // 本地优先，秒开
    let local = []
    try {
      local = wx.getStorageSync(LOCAL_ORDERS) || []
    } catch (e) {}
    this.setData({ list: this.flat(local) })

    // 服务端回来后合并覆盖（以 no 为准，本地有则保留本地状态）
    try {
      const r = await api.orderList({ deviceId: getDeviceId() })
      const merged = this.merge(local, r.items || [])
      wx.setStorageSync(LOCAL_ORDERS, merged)
      this.setData({ list: this.flat(merged) })
    } catch (e) {
      console.warn('[鲤慧-订单] 服务端拉取失败，用本地数据', e)
    }
  },

  flat(list) {
    return list.slice().sort((a, b) => String(b.createdAt) < String(a.createdAt) ? -1 : 1).map((o) => ({
      ...o,
      statusText: STATUS_TEXT[o.status] || o.status
    }))
  },

  merge(local, remote) {
    const map = new Map()
    for (const o of remote) map.set(o.no, o)
    for (const o of local) {
      const hit = map.get(o.no)
      // 本地还在「待支付」而服务端已更新，以服务端为准；否则保留本地（用户在第三方已付）
      map.set(o.no, hit && o.status === 'pending' ? hit : o)
    }
    return [...map.values()]
  },

  onTab(e) {
    this.setData({ cur: e.currentTarget.dataset.k })
    this.load()
  },

  /** 列表筛选（按当前 tab） */
  applyFilter() {
    const cur = this.data.cur
    const list = this.data.list.filter((o) => !cur || o.status === cur)
    this.setData({ list: cur ? list : this.flat(this.data.list) })
  },

  goDetail(e) {
    wx.navigateTo({ url: '/pages/order/detail?no=' + e.currentTarget.dataset.no })
  },

  goShop() {
    wx.navigateTo({ url: '/pages/shop/shop' })
  },

  /** 去第三方支付 */
  async gotoPay(e) {
    const no = e.currentTarget.dataset.no
    const order = this.data.list.find((x) => x.no === no)
    if (!order) return
    const s = order.supplier || {}
    if (s.appId) {
      wx.navigateToMiniProgram({
        appId: s.appId,
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
      success: () => wx.showToast({ title: '已复制关键词，去平台搜索下单', icon: 'none', duration: 2400 })
    })
  },

  cancel(e) {
    const no = e.currentTarget.dataset.no
    wx.showModal({
      title: '取消订单',
      content: '取消后鲤慧不再保留这条记录，确定吗？',
      confirmColor: '#F5222D',
      success: async (r) => {
        if (!r.confirm) return
        try {
          await api.orderStatus(no, 'cancelled')
        } catch (err) {}
        this.patchLocal(no, { status: 'cancelled', statusText: '已取消' })
        wx.showToast({ title: '已取消', icon: 'none' })
      }
    })
  },

  async finish(e) {
    const no = e.currentTarget.dataset.no
    try {
      await api.orderStatus(no, 'done')
    } catch (err) {}
    this.patchLocal(no, { status: 'done', statusText: '已完成' })
    wx.showToast({ title: '已标记完成', icon: 'none' })
  },

  patchLocal(no, patch) {
    let list = []
    try {
      list = wx.getStorageSync(LOCAL_ORDERS) || []
    } catch (e) {}
    list = list.map((o) => (o.no === no ? { ...o, ...patch } : o))
    wx.setStorageSync(LOCAL_ORDERS, list)
    this.setData({ list: this.flat(list) })
  }
})
