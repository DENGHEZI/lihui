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
    emptyHint: '',
    thirdName: '携程 / 美团',
    sources: [
      { key: 'near', name: '附近真实', sub: '按我的位置 3km' },
      { key: 'hot', name: '郴州热门', sub: '全城高频去处' }
    ],
    curSource: 'near',
    from: '',
    quotaHit: false,
    quotaMessage: '',
    realLinked: ''
  },

  async onLoad() {
    // 真实价格渠道状态（哪些平台已配 key）——拿到就显示「已接入真实价」
    try {
      const d = await api.shopSuppliers()
      const linked = (d.items || [])
        .filter((x) => x.enabled)
        .map((x) => x.name)
        .join(' / ')
      this.setData({ realLinked: linked })
    } catch (e) {
      console.warn('[鲤慧-商城] 渠道状态获取失败', e)
    }
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
    // 切回页面时若定位已更新，重新算一次距离（只在「附近」tab，热门 tab 与定位无关）
    if (this.data.curSource === 'near' && this.data.list.length && app.globalData.location) this.load()
  },

  onSourceTap(e) {
    const k = e.currentTarget.dataset.k
    if (k === this.data.curSource) return
    this.setData({ curSource: k, list: [], emptyHint: '', quotaHit: false })
    this.load()
  },

  async load() {
    this.setData({ loading: true })
    const loc = app.globalData.location || {}
    const mode = this.data.curSource
    try {
      // 真实店源：服务端已用百度 POI 建过目录，这里只取列表（省百度配额）
      const d = await api.shopSource(mode, loc.lng, loc.lat, {
        category: this.data.curCat,
        keyword: this.data.keyword
      })
      const items = d.items || []
      const fromMap = { cache: '本地缓存', disk: '上次同步', baidu: '百度实时' }
      this.setData({
        list: items,
        loading: false,
        from: `${mode === 'near' ? '附近' : '热门'} · ${fromMap[d.from] || '百度实时'} · ${d.syncedAt ? this.fmtTime(d.syncedAt) : ''}`,
        quotaHit: Boolean(d.quotaHit),
        quotaMessage: d.quotaMessage || '',
        emptyHint: items.length ? '' : '暂时没有匹配的商品，换一个类目或关键词试试'
      })
    } catch (e) {
      // 真实店源不可用时退示例目录，别白屏
      try {
        const d = await api.shopItems({
          category: this.data.curCat,
          keyword: this.data.keyword,
          lng: loc.lng,
          lat: loc.lat
        })
        const items = d.items || []
        this.setData({
          list: items,
          loading: false,
          from: '示例目录（真实同步失败）',
          quotaHit: false,
          emptyHint: items.length ? '' : '真实店源同步失败，当前没有可展示的商品'
        })
      } catch (e2) {
        this.setData({
          loading: false,
          emptyHint: (e && (e.msg || e.errMsg)) || '商品加载失败，请稍后重试'
        })
      }
    }
  },

  fmtTime(ts) {
    const d = new Date(Number(ts))
    const p = (n) => String(n).padStart(2, '0')
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  },

  onCatTap(e) {
    this.setData({ curCat: e.currentTarget.dataset.k })
    this.load()
  },

  onKeyword(e) {
    this.setData({ keyword: e.detail.value })
  },

  onSearch() {
    wx.hideKeyboard()
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
