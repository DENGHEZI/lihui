const app = getApp()
const api = require('../../utils/api.js')
const { getCareMode, setCareMode } = require('../../utils/token.js')
const theme = require('../../utils/theme.js')
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
    // 体检报告检索半径：默认 15 分钟档（赛题口径 1200m），与等时圈默认档一致
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
    /* 步行等时圈：默认 15 分钟（赛题口径）；30/45/60 为扩展档，客户可自行切换 */
    iso: null,
    isoLoading: false,
    isoEstimated: false,
    isoMinutes: 15,
    baiduBase: false,
    gapRows: [],
    standardName: '',
    standardIssuer: '',
    standardQuote: '',
    standardCoverage: null,
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
    const prevTheme = theme.get()
    theme.apply(this)
    // 从设置页切了主题回来 → 雷达图按新配色重绘
    if (prevTheme !== this.data.theme && this.data.report) this.drawRadar()
    this.setData({ careMode: getCareMode() })
    // 定位与上次展示差异 >200m 时静默重算（客户反馈「位置和地点没有变化」）
    const loc = app.globalData.location
    if (!loc || !Number.isFinite(Number(loc.lng))) return
    const c = this.data.center
    const R = 6371000
    const rad = (d) => (Number(d) * Math.PI) / 180
    const dLat = rad(loc.lat - c.lat)
    const dLng = rad(loc.lng - c.lng)
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(c.lat)) * Math.cos(rad(loc.lat)) * Math.sin(dLng / 2) ** 2
    const moved = 2 * R * Math.asin(Math.sqrt(a))
    if (moved > 200) {
      this._lastLocTs = loc.ts
      this.setData({
        center: { lng: Number(loc.lng), lat: Number(loc.lat) },
        centerText: [loc.city, loc.district].filter(Boolean).join(' ') || '当前位置'
      })
      this.loadReport()
      if (this.data.iso) this.loadIsochrone() // 已算过等时圈就跟着重算，别留着旧圈
    }
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
    this.loadStandards(loc.city)
    // 体检与等时圈并行发起、各自动态渲染：以前串行等待（体检完才算圈），
    // 首屏到等时圈出图 ≈ 两者耗时之和，现在 ≈ 两者中较慢的一个。
    // init 本身仍等两者都结束，保证下拉刷新动画覆盖完整数据周期。
    await Promise.all([
      this.loadReport(),
      !this.data.iso && !this.data.isoLoading ? this.loadIsochrone() : null
    ])
  },

  /** 各地管理规范（评分依据）：本地缓存 + 云端存储，按定位城市匹配适用标准 */
  async loadStandards(city) {
    try {
      const d = await api.lifeStandards(city)
      const s = d && d.standard
      if (!s) return
      const cov = s.metrics && s.metrics.walkCoverageTarget
      // WXML 不放复杂表达式（三元+中文拼接在某些基础库编译失败），在 JS 拼好
      this.setData({
        standardName: s.name,
        standardIssuer: s.issuer,
        standardQuote: s.quote,
        standardCoverage: cov,
        standardRefText: s.name + (cov ? ' · 15分钟步行覆盖率目标 ' + cov + '%' : '') + ' · ' + s.issuer
      })
    } catch (e) { /* 规范拉取失败不影响体检主链路 */ }
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
      }, () => this.drawRadar())
    } catch (e) {
      this.setData({ report: null })
      wx.showToast({ title: (e && e.msg) || '体检失败，下拉重试', icon: 'none' })
    }
  },

  /* ---------------- 六类设施覆盖 · 雷达图 ---------------- */
  /** canvas 2d 雷达图：外层网格 + 轴标签 + 各类得分多边形（主题感知配色） */
  drawRadar() {
    const r = this.data.report
    if (!r || !r.categories || !r.categories.length) return
    const cats = r.categories.filter((c) => Number.isFinite(Number(c.score)))
    const n = cats.length
    if (n < 3) return
    wx.createSelectorQuery().in(this)
      .select('#radar').fields({ node: true, size: true })
      .exec((res) => {
        if (!res || !res[0] || !res[0].node) return
        const canvas = res[0].node
        let dpr = 2
        try { dpr = (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()).pixelRatio || 2 } catch (e) {}
        const W = res[0].width
        const H = res[0].height
        canvas.width = W * dpr
        canvas.height = H * dpr
        const ctx = canvas.getContext('2d')
        ctx.scale(dpr, dpr)

        const dark = theme.get() === 'dark'
        const gridColor = dark ? 'rgba(255,255,255,.14)' : '#EDEFF2'
        const labelColor = dark ? '#A9B0B8' : '#646A73'
        const fill = dark ? 'rgba(76,154,255,.22)' : 'rgba(22,119,255,.16)'
        const stroke = dark ? '#4C9AFF' : '#1677FF'

        const cx = W / 2
        const cy = H / 2 + 4
        const R = Math.min(W, H) / 2 - 36
        const ang = (i) => (Math.PI * 2 * i) / n - Math.PI / 2
        const pt = (i, radius) => [cx + radius * Math.cos(ang(i)), cy + radius * Math.sin(ang(i))]

        // 网格（4 层多边形）
        ctx.strokeStyle = gridColor
        ctx.lineWidth = 1
        for (let k = 1; k <= 4; k++) {
          ctx.beginPath()
          for (let i = 0; i < n; i++) {
            const [x, y] = pt(i, (R * k) / 4)
            i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)
          }
          ctx.closePath()
          ctx.stroke()
        }
        // 轴线 + 标签 + 分值
        ctx.font = '11px sans-serif'
        ctx.textAlign = 'center'
        for (let i = 0; i < n; i++) {
          const [x, y] = pt(i, R)
          ctx.beginPath()
          ctx.moveTo(cx, cy)
          ctx.lineTo(x, y)
          ctx.stroke()
          const [lx, ly] = pt(i, R + 20)
          ctx.fillStyle = labelColor
          ctx.fillText(cats[i].name, lx, ly + 4)
          ctx.fillStyle = cats[i].color
          ctx.fillText(String(cats[i].score), lx, ly - 10)
        }
        // 得分多边形
        ctx.beginPath()
        for (let i = 0; i < n; i++) {
          const s = Math.max(0, Math.min(100, Number(cats[i].score))) / 100
          const [x, y] = pt(i, R * s)
          i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)
        }
        ctx.closePath()
        ctx.fillStyle = fill
        ctx.strokeStyle = stroke
        ctx.lineWidth = 2
        ctx.fill()
        ctx.stroke()
        // 顶点圆点
        for (let i = 0; i < n; i++) {
          const s = Math.max(0, Math.min(100, Number(cats[i].score))) / 100
          const [x, y] = pt(i, R * s)
          ctx.beginPath()
          ctx.arc(x, y, 3, 0, Math.PI * 2)
          ctx.fillStyle = cats[i].color
          ctx.fill()
        }
      })
  },

  /* ---------------- 步行等时圈 + 服务盲区 ---------------- */
  /** 渐进呈现：等时圈计算期间先画理论理想圆（分钟 × 步速 × 弯曲系数，与服务端口径一致），
   *  真实路网圈到达后自动替换 —— 首屏即刻有图，不再干等 5~8s 白屏 */
  previewIso() {
    const c = this.data.center
    const R = this.data.isoMinutes * 80 * 1.3
    const pts = []
    for (let i = 0; i <= 36; i++) {
      const th = (Math.PI * 2 * i) / 36
      const lat = c.lat + ((R * Math.cos(th)) / 6371000) * (180 / Math.PI)
      const lng = c.lng + ((R * Math.sin(th)) / (6371000 * Math.cos((c.lat * Math.PI) / 180))) * (180 / Math.PI)
      pts.push({ latitude: lat, longitude: lng })
    }
    const reachKm = (R * 2) / 1000
    const isoScale = reachKm < 0.6 ? 17 : reachKm < 1.2 ? 16 : reachKm < 2.5 ? 15 : reachKm < 5 ? 14 : 13
    this.setData({
      isoEstimated: true,
      isoCenter: c,
      isoScale,
      isoPolygons: [{
        points: pts,
        strokeWidth: 1,
        strokeColor: '#1677FF88',
        fillColor: '#1677FF12',
        zIndex: 1
      }],
      isoMarkers: []
    })
  },

  async loadIsochrone() {
    if (this.data.isoLoading) return
    this.setData({ isoLoading: true })
    // 没有旧圈时先画理论估算圆占位（有旧圈则保留旧圈，别闪掉）
    if (!this.data.iso) this.previewIso()
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
      // 分类缺口条形：gap≥50% 红 / ≥30% 橙 / 其余绿
      const a = d.analysis || {}
      const gapRows = (a.categoryGaps || []).map((g) => Object.assign({}, g, {
        level: g.gapPct >= 50 ? 'bad' : g.gapPct >= 30 ? 'warn' : 'ok'
      }))
      this.setData({
        iso: d,
        gapRows,
        isoPolygons: polygons,
        isoMarkers: markers,
        isoScale,
        isoCenter: this.data.center,
        isoEstimated: false,
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

  /* 底图切换：微信 map 组件固定腾讯渲染；百度底图走静态图 API */
  setBaseTencent() {
    this.setData({ baiduBase: false })
  },
  setBaseBaidu() {
    if (!this.data.iso || !this.data.iso.baiduStatic || !this.data.iso.baiduStatic.url) {
      wx.showToast({ title: '百度底图生成中，稍后再试', icon: 'none' })
      return
    }
    this.setData({ baiduBase: true })
  },
  /** 百度底图点击 → 系统地图页（可切换百度地图 App 发起导航） */
  openIsoInBaidu() {
    const c = this.data.isoCenter
    wx.openLocation({
      latitude: Number(c.lat),
      longitude: Number(c.lng),
      name: '我的 ' + this.data.isoMinutes + ' 分钟生活圈',
      address: '步行等时圈中心 · 数据源：百度地图开放平台',
      scale: this.data.iso.baiduStatic ? this.data.iso.baiduStatic.zoom : 14
    })
  },

  /** 优先改造地块 → 拉起地图查看该地块中心（可继续发起导航） */
  navToHotspot(e) {
    const hs = this.data.iso && this.data.iso.analysis && this.data.iso.analysis.hotspots
    const h = hs && hs[Number(e.currentTarget.dataset.i)]
    if (!h || !h.center) return
    wx.openLocation({
      latitude: Number(h.center.lat),
      longitude: Number(h.center.lng),
      name: '优先改造地块 · ' + h.areaHa + ' 公顷',
      address: '覆盖分 ' + h.avgScore + ' · 最近设施步行约 ' + h.avgNearestWalkMin + ' 分钟',
      scale: 15
    })
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
            { name: '便利度', hint: '基于 30 分钟步行可达性判断' },
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

  /** 展开/收起规范原文摘录 */
  toggleStdDetail() {
    this.setData({ showStdDetail: !this.data.showStdDetail })
  },

  fmtDist(d) {
    if (d === null || d === undefined) return ''
    return Number(d) >= 1000 ? (Number(d) / 1000).toFixed(1) + 'km' : Math.round(Number(d)) + 'm'
  },

  onShareAppMessage() {
    return { title: '我的 30 分钟生活圈体检报告', path: '/pages/life/life' }
  }
})
