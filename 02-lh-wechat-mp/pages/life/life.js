const app = getApp()
const api = require('../../utils/api.js')
const { getCareMode, setCareMode } = require('../../utils/token.js')
const voice = require('../../utils/voice.js')

function colorOf(s) {
  if (s >= 85) return '#00B96B'
  if (s >= 60) return '#1677FF'
  if (s >= 40) return '#FF8A00'
  return '#F5222D'
}

Page({
  data: {
    center: { lng: 112.938814, lat: 28.228209 },
    centerText: '正在定位…',
    radius: 1200,
    careMode: false,
    report: null,
    plan: null,
    ringColor: '#1677FF',
    ringDeg: 0,
    rateName: '',
    rateResult: null,
    budgets: [
      { key: 'low', name: '节省' },
      { key: 'mid', name: '适中' },
      { key: 'high', name: '宽松' }
    ],
    pref: { budget: 'low', withElderly: true, needPark: true, maxWalkMinutes: 15 },
    /* 步行等时圈 */
    iso: null,
    isoLoading: false,
    isoMinutes: 15,
    isoPolygons: [],
    isoMarkers: [],
    isoScale: 15,
    isoCenter: { lng: 112.938814, lat: 28.228209 }
  },

  onLoad() {
    this.setData({ careMode: getCareMode() })
    this.init()
  },

  onShow() {
    this.setData({ careMode: getCareMode() })
  },

  onPullDownRefresh() {
    this.init().then(() => wx.stopPullDownRefresh())
  },

  async init() {
    const loc = await app.getLocation()
    this.setData({
      center: { lng: Number(loc.lng), lat: Number(loc.lat) },
      centerText: [loc.city, loc.district].filter(Boolean).join(' ') || '当前位置'
    })
    await this.loadReport()
  },

  async loadReport() {
    try {
      const r = await api.lifeReport(this.data.center.lng, this.data.center.lat, this.data.radius)
      r.categories = (r.categories || []).map((c) =>
        Object.assign({}, c, {
          // 检索失败的类显示「暂无数据」而不是 0 分，避免误导
          score: c.score === null || c.score === undefined ? (c.failed ? '—' : 0) : c.score,
          color: c.score === null || c.score === undefined ? '#8F959E' : colorOf(c.score),
          failedText: c.failed ? (r.quotaExhausted ? '（今日检索配额已用完，次日 0 点恢复）' : '（本次检索超时，不影响总分）') : '',
          nearestText: c.nearest ? '，最近 ' + c.nearest.name + ' ' + this.fmtDist(c.nearest.distance) : '，范围内未查到'
        })
      )
      r.shortboards = r.shortboards || []
      r.suggestions = (r.suggestions || []).map((x) => (typeof x === 'string' ? x : JSON.stringify(x)))
      this.setData({
        report: r,
        ringColor: colorOf(r.score),
        ringDeg: Math.round((r.score || 0) * 3.6)
      })
    } catch (e) {
      this.setData({ report: null })
      wx.showToast({ title: (e && e.msg) || '体检失败，下拉重试', icon: 'none' })
    }
  },

  /* ---------------- 步行等时圈 + 服务盲区 ---------------- */
  async loadIsochrone() {
    if (this.data.isoLoading) return
    this.setData({ isoLoading: true })
    try {
      const d = await api.lifeIsochrone(
        this.data.center.lng,
        this.data.center.lat,
        this.data.isoMinutes,
        5
      )
      const { polygons, markers } = this.buildIsoShapes(d)
      const reachKm = (d.summary && d.summary.maxReachM ? d.summary.maxReachM : 1500) * 2 / 1000
      const isoScale = reachKm < 0.6 ? 17 : reachKm < 1.2 ? 16 : reachKm < 2.5 ? 15 : reachKm < 5 ? 14 : 13
      this.setData({
        iso: d,
        isoPolygons: polygons,
        isoMarkers: markers,
        isoScale,
        isoCenter: this.data.center,
        isoLoading: false
      })
    } catch (e) {
      this.setData({ isoLoading: false })
      wx.showToast({ title: (e && e.msg) || '等时圈计算失败', icon: 'none' })
    }
  },

  /** 等时圈 → map 组件 shapes：主多边形 + 盲区格（红正方形 polygon，零 icon 依赖） */
  buildIsoShapes(d) {
    const isoPolygon = {
      points: (d.polygon || []).map((p) => ({ latitude: p.lat, longitude: p.lng })),
      strokeWidth: 2,
      strokeColor: '#1677FFCC',
      fillColor: '#1677FF1E',
      zIndex: 2
    }
    // 盲区格：按 grid 索引还原正方形（与 bbox 对齐），红色半透明
    const blind = (d.blindZones || []).map((z, idx) => {
      const n = d.grid
      const lons = (d.polygon || []).map((p) => p.lng)
      const lats = (d.polygon || []).map((p) => p.lat)
      const minLng = Math.min.apply(null, lons), maxLng = Math.max.apply(null, lons)
      const minLat = Math.min.apply(null, lats), maxLat = Math.max.apply(null, lats)
      const x0 = minLng + (z.i / n) * (maxLng - minLng)
      const x1 = minLng + ((z.i + 1) / n) * (maxLng - minLng)
      const y0 = minLat + (z.j / n) * (maxLat - minLat)
      const y1 = minLat + ((z.j + 1) / n) * (maxLat - minLat)
      return {
        points: [
          { latitude: y0, longitude: x0 },
          { latitude: y0, longitude: x1 },
          { latitude: y1, longitude: x1 },
          { latitude: y1, longitude: x0 }
        ],
        strokeWidth: 1,
        strokeColor: '#F53F3FAA',
        fillColor: '#F53F3F4D',
        zIndex: 3,
        _label: z.score
      }
    })
    // 家 marker：callout 显示覆盖分
    const markers = [{
      id: 1,
      latitude: d.center.lat,
      longitude: d.center.lng,
      width: 1,
      height: 1,
      alpha: 0,
      callout: {
        content: '🏠 家 · 覆盖 ' + (d.coverageScore == null ? '--' : d.coverageScore) + '分',
        display: 'ALWAYS',
        borderRadius: 8,
        padding: 6,
        fontSize: 12
      }
    }]
    return { polygons: [isoPolygon].concat(blind), markers }
  },

  onIsoMinutes(e) {
    this.setData({ isoMinutes: Number(e.currentTarget.dataset.m) || 15 })
    this.loadIsochrone()
  },

  async customize() {
    wx.showLoading({ title: '生成方案中' })
    try {
      const p = await api.customizePlan(this.data.center.lng, this.data.center.lat, this.data.pref)
      this.setData({ plan: p })
      wx.hideLoading()
      if (p && p.plan) voice.speak(p.plan.slice(0, 2).join('。'), { scene: 'chat', careMode: this.data.careMode })
    } catch (e) {
      wx.hideLoading()
    }
  },

  onRateInput(e) {
    this.setData({ rateName: e.detail.value })
  },

  async doRate() {
    const name = (this.data.rateName || '').trim()
    if (!name) {
      wx.showToast({ title: '请输入名称', icon: 'none' })
      return
    }
    wx.showLoading({ title: '评估中' })
    try {
      const r = await api.agentChat({
        text: '评价参考：' + name,
        lng: this.data.center.lng,
        lat: this.data.center.lat
      })
      wx.hideLoading()
      this.setData({
        rateResult: {
          dimensions: [
            { name: '便利度', hint: '基于 15 分钟步行可达性判断' },
            { name: '价格透明度', hint: '优先选择明码标价的商家' },
            { name: '服务态度', hint: '参考平台评价与口碑' },
            { name: '适老友好', hint: '无障碍通道、座椅、放大镜等' }
          ],
          advice: r.reply || '建议优先选择连锁品牌或社区卫生服务中心。'
        }
      })
    } catch (e) {
      wx.hideLoading()
    }
  },

  setBudget(e) {
    this.setData({ 'pref.budget': this.data.budgets[e.currentTarget.dataset.i].key })
  },
  onElderly(e) {
    this.setData({ 'pref.withElderly': e.detail.value })
  },
  onPark(e) {
    this.setData({ 'pref.needPark': e.detail.value })
  },
  onWalk(e) {
    this.setData({ 'pref.maxWalkMinutes': e.detail.value })
  },

  toggleCare() {
    const on = setCareMode(!this.data.careMode)
    this.setData({ careMode: on })
    this.loadReport()
  },

  jumpMap() {
    wx.switchTab({ url: '/pages/index/index' })
  },

  fmtDist(d) {
    if (d === null || d === undefined) return ''
    return Number(d) >= 1000 ? (Number(d) / 1000).toFixed(1) + 'km' : Math.round(Number(d)) + 'm'
  },

  onShareAppMessage() {
    return { title: '我的 15 分钟生活圈体检报告', path: '/pages/life/life' }
  }
})
