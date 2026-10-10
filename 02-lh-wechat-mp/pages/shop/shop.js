/**
 * 鲤慧 · 商城列表（类目 + 关键词 + 距离排序）
 * 这里只负责选品；下单在 detail 页，支付在第三方平台完成。
 */
const api = require('../../utils/api.js')
const theme = require('../../utils/theme.js')
const profile = require('../../utils/profile.js')
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
      { key: 'hot', name: '本城热门', sub: '按你的城市推荐' }
    ],
    curSource: 'near',
    from: '',
    quotaHit: false,
    quotaMessage: '',
    realLinked: '',
    // 定位状态条：让"距离不对"这类问题当场可见——
    // 定位漂了（GPS 缓存/WiFi 漂移/手动城市/IP 估计）时，用户能看到来源与精度并一键重新定位
    locDesc: '',
    locWarn: false,
    relocating: false
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
    theme.apply(this)
    // 切回页面时若定位已更新，重新算一次距离（只在「附近」tab，热门 tab 与定位无关）
    // 2026-10-10：列表为空且带空态提示时也重拉 —— 限流窗口期拉空过的页面，切回来自动自愈，
    // 不再「空一次就一直空」（原条件 list.length 为空时永远不重试）
    if (this.data.curSource === 'near' && !this.data.loading &&
        (this.data.list.length || this.data.emptyHint)) this.load()
  },

  /** 下拉刷新：只清商城相关缓存（shop 前缀），不动其他业务数据 */
  async onPullDownRefresh() {
    try { const { clearCachePrefix } = require('../../utils/request.js'); clearCachePrefix('/shop/') } catch (e) {}
    this.setData({ curCat: this.data.curCat })
    await this.load()
    wx.stopPullDownRefresh()
  },

  onSourceTap(e) {
    const k = e.currentTarget.dataset.k
    if (k === this.data.curSource) return
    this.setData({ curSource: k, list: [], emptyHint: '', quotaHit: false })
    this.load()
  },

  /** 定位来源 → 用户能看懂的文案；精度差/非真 GPS 的标橙提醒 */
  applyLocState(loc) {
    if (!loc || !isFinite(Number(loc.lng))) {
      this.setData({ locDesc: '未获取到定位', locWarn: true })
      return
    }
    const acc = Number(loc.accuracy)
    let desc = ''
    let warn = false
    if (loc.source === 'gps') {
      desc = `GPS 定位 ±${isFinite(acc) ? Math.round(acc) : '?'}m`
    } else if (loc.source === 'gps-coarse') {
      desc = `粗定位 ±${isFinite(acc) ? Math.round(acc) : '?'}m`
      warn = true
    } else if (loc.source === 'manual') {
      desc = `手动城市${loc.city ? '·' + loc.city : ''}`
      warn = true
    } else {
      desc = 'IP 估计（城市级）'
      warn = true
    }
    this.setData({ locDesc: desc, locWarn: warn })
  },

  /** 一键重新定位：强刷 GPS（顺带清掉手动城市），成功后重拉列表 */
  async onRelocate() {
    if (this.data.relocating) return
    this.setData({ relocating: true })
    try {
      const loc = await app.getLocation({ force: true })
      if (loc && isFinite(Number(loc.lng))) {
        wx.showToast({ title: '已重新定位', icon: 'success', duration: 1200 })
      } else {
        wx.showToast({ title: '定位失败，检查定位权限', icon: 'none' })
      }
    } catch (e) {
      wx.showToast({ title: '定位失败，检查定位权限', icon: 'none' })
    }
    this.setData({ relocating: false })
    this.load()
  },

  async load() {
    this.setData({ loading: true })
    let loc = app.globalData.location || {}
    // 定位为主：进商城默认「附近真实」，定位尚未就绪时最多等 4s；
    // 仍拿不到坐标才自动切「本城热门」兜底，并明确告知（下次定位更新 onShow 会切回）
    if (this.data.curSource === 'near' && !isFinite(Number(loc.lng))) {
      const ok = await this.waitLoc(4000)
      if (!ok) {
        this.setData({ curSource: 'hot', list: [], emptyHint: '', quotaHit: false })
        wx.showToast({ title: '未获取到定位，已展示本城热门', icon: 'none', duration: 2400 })
        return this.load()
      }
      loc = app.globalData.location || {}
    }
    this.applyLocState(loc)
    this.syncHotTabName(loc)
    const mode = this.data.curSource
    try {
      // 真实店源：服务端已用百度 POI 建过目录，这里只取列表（省百度配额）
      // ⚠️ hot（本城热门）也要带坐标：服务端拿它当城市级检索圆心，GPS 在哪个城市就拉哪个城市的热门
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

  /** 轮询等待 app 全局定位就绪（50ms 间隔，最多 ms 毫秒） */
  waitLoc(ms) {
    return new Promise((resolve) => {
      const t0 = Date.now()
      const tick = () => {
        const l = app.globalData.location
        if (l && isFinite(Number(l.lng))) return resolve(true)
        if (Date.now() - t0 >= ms) return resolve(false)
        setTimeout(tick, 50)
      }
      tick()
    })
  },

  /** 热门 tab 城市名动态化：GPS 在哪个城市，tab 就显示「XX热门」；拿不到市名则保持「本城热门」 */
  syncHotTabName(loc) {
    const m = String((loc && loc.city) || '').match(/([\u4e00-\u9fa5]{2,8}市)/)
    const name = m ? m[1] + '热门' : '本城热门'
    if (name !== this.data.sources[1].name) this.setData({ 'sources[1].name': name })
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
    const kw = (this.data.keyword || '').trim()
    if (kw) profile.track('search', { query: kw, category: 'shop' }) // 画像埋点：商城搜索词
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
