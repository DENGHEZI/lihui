const app = getApp()
const api = require('../../utils/api.js')
const { getCareMode, setCareMode } = require('../../utils/token.js')
const theme = require('../../utils/theme.js')
const voice = require('../../utils/voice.js')

const WEB_HOME = 'https://lihui-landing.app.workbuddy.host/' // 网页版入口（PDF 导出走网页版）

function colorOf(s) {
  if (s >= 85) return '#00B96B'
  if (s >= 60) return '#1677FF'
  if (s >= 40) return '#FF8A00'
  return '#F5222D'
}

/** canvas 圆角矩形路径（roundRect 兼容垫片：基础库 canvas 不一定带原生 roundRect） */
function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
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
    isoMode: 'walking', // V1.1 多出行方式：walking / riding（公交无批量矩阵接口，诚实不提供）
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
          nearestText: c.nearest ? '，最近 ' + c.nearest.name + ' ' + this.fmtDist(c.nearest.distance) : '，范围内未查到',
          // V1.1 养老业态级细分（助餐/照料/康养）：拼进描述行展示
          bizText: Array.isArray(c.biz) && c.biz.length
            ? c.biz.map((b) => b.name + '×' + b.count + (b.nearest && b.nearest.name ? '（' + b.nearest.name.slice(0, 10) + '）' : '')).join(' ')
            : ''
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

  /* ---------------- 七类设施覆盖 · 雷达图 ---------------- */
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
    const SPD = this.data.isoMode === 'riding' ? 200 : 80 // 骑行 12km/h，与服务端 TRAVEL_MODES 口径一致
    const R = this.data.isoMinutes * SPD * 1.3
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
        5,
        this.data.isoMode
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

  /** 切换出行方式（步行/骑行）：清掉旧圈让理论估算圆按新速度重画，再重算真实路网圈 */
  onIsoMode(e) {
    const m = e.currentTarget.dataset.mode === 'riding' ? 'riding' : 'walking'
    if (m === this.data.isoMode) return
    this.setData({ isoMode: m, iso: null })
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
      address: (this.data.isoMode === 'riding' ? '骑行' : '步行') + '等时圈中心 · 数据源：百度地图开放平台',
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

  /* ---------------- 体检报告导出（长图 canvas / PDF 网页版引导） ---------------- */
  /** CJK 逐字换行：measureText 超宽即断行，maxLines 截断加省略号 */
  rcWrap(ctx, text, maxWidth, maxLines) {
    const lines = []
    let cur = ''
    for (const ch of String(text || '')) {
      if (ctx.measureText(cur + ch).width > maxWidth) {
        lines.push(cur)
        cur = ch
        if (lines.length >= maxLines) {
          while (ctx.measureText(cur + '…').width > maxWidth && cur.length > 1) cur = cur.slice(0, -1)
          return lines.concat(cur + '…')
        }
      } else cur += ch
    }
    if (cur) lines.push(cur)
    return lines
  },

  /** 用 canvas 2d 绘制体检长图卡片（与网页端 V1.1.1 排版同风格：卡片化+自动换行+受限灰条） */
  drawReportCard() {
    const r = this.data.report
    if (!r) return Promise.reject(new Error('报告未就绪'))
    const cats = r.categories || []
    const sugs = (r.suggestions || []).map((t) => String(t).replace(/^怎么补：/, ''))
    return new Promise((resolve, reject) => {
      wx.createSelectorQuery().in(this)
        .select('#reportCard').fields({ node: true })
        .exec((res) => {
          if (!res || !res[0] || !res[0].node) return reject(new Error('画布未就绪'))
          const canvas = res[0].node
          const W = 750
          const PAD = 44
          const CW = W - PAD * 2
          const TEAL = '#0FA693'
          const TEAL_DK = '#0C8F80'
          const GOLD = '#B98629'
          // 分享卡片固定浅色纸面：不受 App 深色模式影响（转发聊天/打印场景一致可读）
          const PAPER = '#F6F4EC'
          const CARD = '#FFFFFF'
          const INK = '#2E2A20'
          const SUB = '#6B6B60'
          const FAINT = '#8A8574'
          const LINE = '#EFEBE0'

          // —— 第一次布局：量文本算真实高度 ——
          canvas.width = W * 2
          canvas.height = 4000
          let ctx = canvas.getContext('2d')
          ctx.scale(2, 2)
          const font = (sz, b) => { ctx.font = (b ? 'bold ' : '') + sz + 'px sans-serif' }
          font(26)
          const catRows = cats.map((c) => {
            const descLines = rcWrap(ctx, (c.desc || '') + ' · 可达 ' + (c.count || 0) + ' 处' + (c.nearestText || ''), CW - 64, 2)
            const bizLines = c.bizText ? rcWrap(ctx, '业态：' + c.bizText, CW - 64, 2) : []
            return { c, descLines, bizLines }
          })
          const sugRows = sugs.map((t) => rcWrap(ctx, t, CW - 72, 4))
          const sbRows = (r.shortboards || []).map((t) => rcWrap(ctx, t, CW - 52, 3))

          let H = 176 // 品牌头带
          H += 150 // 总分带
          catRows.forEach((row) => { H += 100 + row.descLines.length * 36 + row.bizLines.length * 34 + 22 })
          if (sbRows.length) H += 64 + sbRows.reduce((a, b) => a + b.length * 36 + 14, 0) + 18
          if (sugRows.length) H += 64 + sugRows.reduce((a, b) => a + b.length * 36 + 12, 0)
          H += 128 // 落款
          canvas.height = H * 2
          ctx = canvas.getContext('2d')
          ctx.scale(2, 2)

          // 背景纸面
          ctx.fillStyle = PAPER
          ctx.fillRect(0, 0, W, H)

          // 卡片（带柔和投影）
          const drawCard = (yy, h, r2) => {
            ctx.save()
            ctx.shadowColor = 'rgba(46,42,32,.07)'
            ctx.shadowBlur = 18
            ctx.shadowOffsetY = 6
            roundRect(ctx, PAD, yy, W - PAD * 2, h, r2 || 20)
            ctx.fillStyle = CARD
            ctx.fill()
            ctx.restore()
          }
          // 节标题（绿色竖条 + 粗体，与网页端同语言）
          const sectionTitle = (txt, yy) => {
            ctx.fillStyle = TEAL
            roundRect(ctx, PAD, yy, 8, 34, 4); ctx.fill()
            ctx.fillStyle = INK
            font(32, true)
            ctx.fillText(txt, PAD + 26, yy + 27)
          }
          // 彩色得分徽章
          const scorePill = (txt, color, xx, yy) => {
            font(24, true)
            const tw = ctx.measureText(txt).width
            roundRect(ctx, xx - tw - 36, yy, tw + 36, 42, 21)
            ctx.fillStyle = color + '1F' // 8 位 hex 透明底
            ctx.fill()
            ctx.fillStyle = color
            ctx.fillText(txt, xx - tw - 18, yy + 29)
          }

          // —— 品牌头带（青绿渐变 + 白字）——
          const grad = ctx.createLinearGradient(PAD, 0, W - PAD, 0)
          grad.addColorStop(0, TEAL)
          grad.addColorStop(1, TEAL_DK)
          roundRect(ctx, PAD, 36, W - PAD * 2, 108, 22)
          ctx.fillStyle = grad
          ctx.fill()
          ctx.fillStyle = '#fff'
          font(40, true)
          ctx.fillText('15 分钟生活圈体检报告', PAD + 34, 90)
          font(23)
          ctx.fillStyle = 'rgba(255,255,255,.85)'
          const sub = this.data.centerText + ' · 检索半径 ' + this.fmtDist(this.data.radius)
          ctx.fillText(sub, PAD + 34, 124)
          ctx.textAlign = 'right'
          ctx.fillText(new Date().toLocaleDateString('zh-CN'), W - PAD - 30, 90)
          ctx.textAlign = 'left'
          let y = 176

          // —— 总分带 ——
          drawCard(y, 118)
          ctx.fillStyle = GOLD
          roundRect(ctx, PAD, y, 6, 118, 3); ctx.fill()
          const scoreStr = String(r.score)
          ctx.fillStyle = colorOf(Number(r.score) || 0)
          font(80, true)
          ctx.fillText(scoreStr, PAD + 36, y + 82)
          const scoreW = ctx.measureText(scoreStr).width
          ctx.fillStyle = INK
          font(27, true)
          ctx.fillText('分 · ' + (r.level || '生活圈体检'), PAD + 36 + scoreW + 18, y + 80)
          font(23)
          ctx.fillStyle = SUB
          ctx.textAlign = 'right'
          ctx.fillText('短板 ' + (r.shortboards || []).length + ' 项 · 步行 ' + (r.walkMinutes || 15) + ' 分钟可达', W - PAD - 30, y + 70)
          ctx.textAlign = 'left'
          y += 118 + 28

          // —— 七类卡片 ——
          for (const row of catRows) {
            const c = row.c
            const failed = c.failed || c.score === '—'
            const ch = 86 + row.descLines.length * 36 + row.bizLines.length * 34 + 16
            drawCard(y, ch)
            ctx.fillStyle = INK; font(31, true)
            ctx.fillText(c.name, PAD + 30, y + 48)
            ctx.textAlign = 'left'
            if (failed) {
              scorePill('检索受限 · 未评估', '#8F959E', W - PAD - 30, y + 26)
            } else {
              scorePill(c.score + ' 分', c.color || colorOf(Number(c.score) || 0), W - PAD - 30, y + 26)
            }
            const barY = y + 70
            ctx.fillStyle = '#F0EDE4'
            roundRect(ctx, PAD + 30, barY, CW - 60, 14, 7); ctx.fill()
            if (!failed) {
              ctx.fillStyle = c.color || '#1677FF'
              roundRect(ctx, PAD + 30, barY, Math.max(14, (CW - 60) * (Number(c.score) || 0) / 100), 14, 7); ctx.fill()
            }
            let ly = y + 106
            font(24); ctx.fillStyle = SUB
            for (const ln of row.descLines) { ctx.fillText(ln, PAD + 30, ly + 24); ly += 36 }
            ctx.fillStyle = FAINT
            for (const ln of row.bizLines) { ctx.fillText(ln, PAD + 30, ly + 22); ly += 34 }
            y += ch + 22
          }

          // —— 短板提醒 ——
          if (sbRows.length) {
            y += 16
            sectionTitle('短板提醒', y); y += 64
            for (const lines of sbRows) {
              ctx.fillStyle = '#F5222D'; font(22)
              ctx.fillText('●', PAD + 8, y + 22)
              ctx.fillStyle = SUB; font(24)
              lines.forEach((ln, k) => { ctx.fillText(ln, PAD + 36, y + 23 + k * 36) })
              y += lines.length * 36 + 14
            }
            y += 18
          }

          // —— 补齐建议 ——
          if (sugRows.length) {
            y += 6
            sectionTitle('怎么补 · 短板解决方案', y); y += 64
            let idx = 1
            for (const lines of sugRows) {
              ctx.fillStyle = TEAL; font(22, true)
              const numStr = String(idx)
              roundRect(ctx, PAD + 4, y + 2, 34, 34, 17)
              ctx.fillStyle = TEAL + '1A'; ctx.fill()
              ctx.fillStyle = TEAL
              ctx.fillText(numStr, PAD + 4 + (34 - ctx.measureText(numStr).width) / 2, y + 26)
              ctx.fillStyle = SUB; font(24)
              lines.forEach((ln, k) => { ctx.fillText(ln, PAD + 54, y + 25 + k * 36) })
              y += lines.length * 36 + 12
              idx++
            }
          }

          // —— 落款 ——
          y = H - 74
          ctx.strokeStyle = LINE
          ctx.beginPath(); ctx.moveTo(PAD, y - 26); ctx.lineTo(W - PAD, y - 26); ctx.stroke()
          ctx.fillStyle = FAINT; font(22)
          ctx.fillText('鲤慧 LiHui · 15 分钟生活圈智能体检', PAD, y)
          ctx.textAlign = 'right'
          ctx.fillText('数据源：百度地图开放平台', W - PAD, y)
          ctx.textAlign = 'left'

          resolve({ canvas, W, H })
        })
    })
  },

  /** 长图导出：绘制 → 临时文件 → 分享图片菜单（老基础库回退保存相册） */
  async exportReportImage() {
    if (this._exporting) return
    if (!this.data.report) { wx.showToast({ title: '请先完成体检', icon: 'none' }); return }
    this._exporting = true
    wx.showLoading({ title: '正在生成长图…', mask: true })
    try {
      const { canvas } = await this.drawReportCard()
      const tmp = await new Promise((resolve, reject) =>
        wx.canvasToTempFilePath({ canvas, fileType: 'png', success: resolve, fail: reject })
      )
      wx.hideLoading()
      const path = tmp.tempFilePath || (tmp.tempFiles && tmp.tempFiles[0] && tmp.tempFiles[0].tempFilePath)
      if (wx.showShareImageMenu) {
        wx.showShareImageMenu({ path, fail: () => this.saveReportAlbum(path) })
      } else {
        this.saveReportAlbum(path)
      }
    } catch (e) {
      wx.hideLoading()
      wx.showToast({ title: (e && e.message) || '生成长图失败', icon: 'none' })
    } finally {
      this._exporting = false
    }
  },

  saveReportAlbum(path) {
    wx.saveImageToPhotosAlbum({
      filePath: path,
      success: () => wx.showToast({ title: '已保存到相册', icon: 'success' }),
      fail: (e) => {
        if (e && /auth|deny|denied/.test(e.errMsg || '')) {
          wx.showModal({
            title: '需要相册权限',
            content: '保存长图需要「添加到相册」权限，请在设置中开启',
            confirmText: '去设置',
            success: (r) => { if (r.confirm) wx.openSetting() }
          })
        }
      }
    })
  },

  /** PDF：小程序生态无法直接生成 PDF（诚实口径），引导到网页版一键导出 */
  exportReportPdf() {
    wx.setClipboardData({
      data: WEB_HOME,
      success: () => wx.showModal({
        title: '导出 PDF',
        content: '小程序暂不支持直接生成 PDF。已复制网页版地址，用浏览器打开后点「🖨 PDF」按钮即可一键导出（与小程序数据同源）。',
        confirmText: '知道了',
        showCancel: false
      })
    })
  },

  onShareAppMessage() {
    // V1.1：分享卡片带上总分与达标等级（长图/海报由网页端「🖼 长图」导出，5:4 比例可复用为卡片底图）
    const r = this.data.report
    const score = r && Number.isFinite(Number(r.score)) ? Number(r.score) : null
    return {
      title: score != null
        ? '我的 15 分钟生活圈体检 ' + score + ' 分（' + (r.level || '') + '），来看看你的'
        : '15 分钟生活圈智能体检 · 鲤慧',
      path: '/pages/life/life'
    }
  }
})
