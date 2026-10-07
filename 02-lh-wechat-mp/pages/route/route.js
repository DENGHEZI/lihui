const app = getApp()
const api = require('../../utils/api.js')
const bmap = require('../../utils/bmap.js')
const action = require('../../utils/action.js')
const config = require('../../utils/config.js')

const theme = require('../../utils/theme.js')

/** 百度指令清洗：<b>冲口路</b> → rich-text 节点（蓝色加粗），不再显示原始标签 */
function instrNodes(s) {
  const str = String(s || '').replace(/<\/?font[^>]*>/gi, '')
  const parts = str.split(/(<b>[\s\S]*?<\/b>)/)
  const nodes = []
  for (const p of parts) {
    if (!p) continue
    const m = p.match(/^<b>([\s\S]*?)<\/b>$/)
    if (m) {
      nodes.push({ name: 'b', attrs: { style: 'color:var(--lh-primary);font-weight:600;' }, children: [{ type: 'text', text: m[1] }] })
    } else {
      nodes.push({ type: 'text', text: p })
    }
  }
  return nodes
}

/** 统一路线数据规整 */
function normalizeRoute(r) {
  const out = Object.assign({}, r)
  out.km = (Number(r.distance || 0) / 1000).toFixed(1)
  out.min = Math.round(Number(r.duration || 0) / 60)
  out.steps = (r.steps || []).map((s) =>
    Object.assign({}, s, {
      min: Math.round(Number(s.duration || 0) / 60),
      rich: instrNodes(s.instruction)
    })
  )
  out.alternatives = (r.alternatives || []).map((a) =>
    Object.assign({}, a, { km: (Number(a.distance || 0) / 1000).toFixed(1), min: Math.round(Number(a.duration || 0) / 60) })
  )
  return out
}

/** 把路线折线画上服务端代理的百度静态图（AK 不出服务端）
 *  ⚠️ 静态图 paths 是 lng,lat 顺序（与 directionlite steps 的 lat,lng 相反），必须转换；
 *    pathStyles 必须三段式 0xRRGGBB,weight,opacity，两段式百度报错返回空白占位图 */
function buildStaticMap(r, origin, dest) {
  try {
    const pts = [] // [lng,lat] —— directionlite steps.path 原生就是 lng,lat 序,静态图 paths 也要 lng,lat,原样拼接
    for (const s of r.steps || []) {
      if (!s.path) continue
      for (const p of String(s.path).split(';')) {
        const [a, b] = p.split(',')
        if (isFinite(+a) && isFinite(+b)) pts.push([+a, +b])
      }
    }
    if (pts.length < 2) return null
    // 坐标截断到 5 位小数(≈1m,静态图足够),采样至 ≤75 点保证 paths ≤1500 字符
    // (服务端上限 1800,给 URL 其他参数留余量)
    const round = (n) => Number(n.toFixed(5))
    const maxPts = 75
    const step = Math.max(1, Math.ceil(pts.length / maxPts))
    const sampled = pts.filter((_, i) => i % step === 0 || i === pts.length - 1).map(([ln, la]) => [round(ln), round(la)])
    let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180
    for (const [ln, la] of pts) {
      if (la < minLat) minLat = la
      if (la > maxLat) maxLat = la
      if (ln < minLng) minLng = ln
      if (ln > maxLng) maxLng = ln
    }
    const span = Math.max(maxLat - minLat, (maxLng - minLng) * 0.7, 0.008)
    const zoom = Math.max(5, Math.min(17, Math.round(15 - Math.log2(span * 100))))
    const qs = [
      'center=' + (minLng + maxLng) / 2 + ',' + (minLat + maxLat) / 2,
      'markers=' + origin.lng + ',' + origin.lat + '|' + dest.lng + ',' + dest.lat,
      'paths=' + encodeURIComponent(sampled.map((p) => p.join(',')).join(';')),
      'pathStyles=0x1677FF,6,0.85',
      'zoom=' + zoom,
      'width=750&height=420'
    ].join('&')
    return config.BASE_URL + '/map/staticimg?' + qs
  } catch (e) {
    return null
  }
}

Page({
  onShow() {
    theme.apply(this)
  },

  data: {
    origin: null,
    originName: '我的位置',
    destName: '',
    dest: null,
    mode: 'walking',
    modeIndex: 0,
    realtime: false,
    loading: false,
    result: null,
    costPlan: null,
    fallbackDriving: false,
    fallbackTip: '',
    mapUrl: '',
    showMap: true,
    showSteps: false,
    sugList: [],
    sugShow: false,
    modes: [
      { key: 'walking', name: '步行', icon: '🚶' },
      { key: 'riding', name: '骑行', icon: '🚲' },
      { key: 'driving', name: '驾车', icon: '🚗' },
      { key: 'transit', name: '公交', icon: '🚌' }
    ]
  },

  async onLoad(q) {
    const loc = await app.getLocation()
    this.setData({
      origin: { lng: Number(loc.lng), lat: Number(loc.lat) },
      originName: [loc.city, loc.district].filter(Boolean).join(' ') || '我的位置'
    })
    if (q && q.name) {
      this.setData({
        destName: decodeURIComponent(q.name),
        dest: { lng: Number(q.lng), lat: Number(q.lat) }
      })
      this.plan()
      this.loadCost()
    }
  },

  onDestInput(e) {
    const v = e.detail.value
    this.setData({ destName: v, dest: null, sugShow: false })
    if (this._sugTimer) clearTimeout(this._sugTimer)
    if (!v || v.length < 2) return
    this._sugTimer = setTimeout(() => this.fetchSug(v), 300)
  },

  async fetchSug(kw) {
    try {
      const city = (this.data.originName || '').slice(0, 3)
      const list = await bmap.suggest(kw, city)
      this.setData({ sugList: (list || []).slice(0, 6), sugShow: (list || []).length > 0 })
    } catch (e) {
      this.setData({ sugList: [], sugShow: false })
    }
  },

  pickSug(e) {
    const i = Number(e.currentTarget.dataset.i)
    const s = this.data.sugList[i]
    if (!s) return
    this.setData({
      destName: s.name,
      dest: s.lng && s.lat ? { lng: s.lng, lat: s.lat } : null,
      sugShow: false,
      sugList: []
    })
    this.plan()
  },

  hideSug() {
    if (this._hideTimer) clearTimeout(this._hideTimer)
    this._hideTimer = setTimeout(() => this.setData({ sugShow: false }), 200)
  },

  onRealtime(e) {
    this.setData({ realtime: e.detail.value })
  },

  setMode(e) {
    const i = e.currentTarget.dataset.i
    this.setData({
      mode: this.data.modes[i].key,
      modeIndex: i,
      fallbackDriving: false,
      fallbackTip: ''
    })
    if (this.data.dest) this.plan()
  },

  swap() {
    if (!this.data.dest) return
    const o = this.data.origin
    this.setData({
      origin: this.data.dest,
      dest: o,
      originName: this.data.destName,
      destName: this.data.originName
    })
  },

  toggleSteps() {
    this.setData({ showSteps: !this.data.showSteps })
  },

  onMapError() {
    // 静态图不可用（云托管未开未鉴权等）时优雅降级为纯摘要卡
    this.setData({ showMap: false })
  },

  async plan() {
    let dest = this.data.dest
    if (!dest) {
      if (!this.data.destName) {
        wx.showToast({ title: '请输入目的地', icon: 'none' })
        return
      }
      wx.showLoading({ title: '解析地址' })
      try {
        const g = await bmap.geocode(this.data.destName, (this.data.originName || '').slice(0, 2))
        dest = { lng: g.lng, lat: g.lat }
        this.setData({ dest })
      } catch (e) {
        wx.hideLoading()
        wx.showToast({ title: '没找到这个地址', icon: 'none' })
        return
      }
      wx.hideLoading()
    }

    this.setData({ loading: true })
    wx.showLoading({ title: '规划中' })
    try {
      const r = await api.planRoute({
        mode: this.data.mode,
        origin: this.data.origin,
        destination: dest,
        realtime: this.data.realtime
      })
      const result = normalizeRoute(r)
      const mapUrl = buildStaticMap(result, this.data.origin, dest)
      this.setData({ result, fallbackDriving: false, mapUrl, showMap: !!mapUrl, showSteps: false })
      if (this.data.mode === 'driving') this.loadCost()
    } catch (e) {
      // 公交方案不可用（含跨城无直达）时，自动回落驾车参考，保证用户总能拿到可行方案
      if (this.data.mode === 'transit') {
        try {
          const r = await api.planRoute({
            mode: 'driving',
            origin: this.data.origin,
            destination: dest,
            realtime: this.data.realtime
          })
          const result = normalizeRoute(r)
          const mapUrl = buildStaticMap(result, this.data.origin, dest)
          this.setData({
            result,
            fallbackDriving: true,
            fallbackTip: this.crossCityTip(result),
            mapUrl,
            showMap: !!mapUrl,
            showSteps: false
          })
        } catch (e2) {
          wx.showToast({ title: '暂无可达方案，请换个目的地试试', icon: 'none' })
        }
      } else {
        wx.showToast({ title: '规划失败', icon: 'none' })
      }
    } finally {
      wx.hideLoading()
      this.setData({ loading: false })
    }
  },

  /** 跨城出行建议文案（公交不可达时给用户出行意见） */
  crossCityTip(r) {
    const km = (Number(r.distance || 0) / 1000).toFixed(0)
    const min = Math.round(Number(r.duration || 0) / 60)
    return `该目的地暂无公交直达（可能在邻市/外地）。驾车约 ${km} 公里、${min} 分钟。跨城建议：① 高铁/城际列车到目的地城市后换乘市内公交；② 长途大巴直达；③ 驾车走高速参考下方方案。`
  },

  async loadCost() {
    try {
      const r = await api.agentChat({
        text: `帮我算下从${this.data.originName}到${this.data.destName}最省钱的方式`,
        lng: this.data.origin.lng,
        lat: this.data.origin.lat
      })
      const c = (r.cards || []).find((x) => x.type === 'cost')
      if (c) this.setData({ costPlan: c })
    } catch (e) {}
  },

  openNav() {
    const d = this.data.dest
    if (!d) {
      wx.showToast({ title: '请先规划路线', icon: 'none' })
      return
    }
    action.openNavigation(this.data.destName, d.lng, d.lat)
  }
})
