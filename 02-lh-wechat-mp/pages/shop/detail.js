/**
 * 鲤慧 · 商品详情 + 下单
 *
 * 流程：选规格/日期/数量 → 填联系人手机 → 提交 → 生成订单（留在鲤慧）
 *       → 用户点「去支付」跳携程/美团小程序完成付款（鲤慧只做留痕，不收钱）
 */
const api = require('../../utils/api.js')
const { getDeviceId } = require('../../utils/token.js')
const theme = require('../../utils/theme.js')
const app = getApp()

/** 本地订单缓存 key（离线也能看「我的订单」） */
const LOCAL_ORDERS = 'lh_orders'

function todayStr(offset = 0) {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

Page({
  onShow() {
    theme.apply(this)
  },

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
    submitting: false,
    // 真实价是否已从携程/美团拉到（false = 展示的是参考价，页面会标「参考」）
    priceReal: false,
    priceReason: ''
  },

  onLoad(q) {
    this.fetch(q)
  },

  async fetch(q) {
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
      // 真实 POI 没有成交价，详情里问一次服务端：配了携程/美团 key 就给真实价，
      // 没配就回落参考价（前端会把「参考」角标显示出来，不伪装成实价）
      this.loadPrice(item)
    } catch (e) {
      wx.showToast({ title: (e && e.msg) || '商品加载失败', icon: 'none' })
      setTimeout(() => wx.navigateBack(), 1000)
    }
  },

  async loadPrice(item) {
    if (!item) return
    if (Number(item.price) > 0) {
      this.setData({ priceReal: false })
      return
    }
    try {
      const p = await api.shopPrice(item.id)
      // p.price：优先携程/美团真实价，没有就是参考价（p.estimated = true / source='estimate'）
      const patch = { priceReal: p.source === 'supplier', priceReason: p.message || '', estUnitPrice: p.price }
      if (Number(p.price) > 0) {
        patch.price = p.price
        patch.estUnitPrice = p.price
        patch.unit = p.unit || item.unit || ''
      }
      // 总价交给 recalc() 统一算（落到分），避免这里再算一遍又出现浮点尾数
      this.setData(patch, () => this.recalc())
    } catch (e) {
      this.setData({ priceReal: false })
    }
  },

  /**
   * 单价 × 数量 = 总价。
   * ⚠️ 两处硬性要求（客户反馈「订单金额不对」就是踩在这）：
   *   1) 单价口径必须和订单落库一致 —— recalc 算出的就是接下来要传给服务端的 unitPrice，
   *      服务端不再自己 estimate()，否则「页面显示 386 / 订单写 358」这种对不上。
   *   2) 金额必须落到「分」—— 128.5 × 3 不能出现 385.49999999999994。
   */
  recalc() {
    const { item, qty } = this.data
    if (!item) return
    // 真实 POI 的 item.price 可能是 null（百度不给价），此时用参考价兜底
    const unit = Number(item.price) > 0 ? Number(item.price) : Number(this.data.estUnitPrice || 0)
    const q = Number(qty) || 1
    const priceSource = Number(item.price) > 0
      ? 'catalog'
      : this.data.priceReal
      ? 'supplier'
      : 'estimate'
    this.setData({
      unitPrice: Math.round(unit * 100) / 100,
      total: Math.round(unit * q * 100) / 100,
      priceSource
    })
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
    // unitPrice 直接取 recalc() 的结果，保证「页面显示多少 = 订单记多少」
    const { item, qty, spec, date, name, phone, remark, submitting, unitPrice, priceSource } = this.data
    if (submitting) return
    if (!(unitPrice > 0)) {
      wx.showToast({ title: '单价还没拿到，请稍候再提交', icon: 'none', duration: 2200 })
      return
    }
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
        lat: loc.lat,
        unitPrice,
        priceSource
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
