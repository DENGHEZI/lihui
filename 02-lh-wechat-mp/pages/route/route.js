const app = getApp()
const api = require('../../utils/api.js')
const bmap = require('../../utils/bmap.js')
const action = require('../../utils/action.js')

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
      nodes.push({ name: 'b', attrs: { style: 'color:#1677FF;font-weight:600;' }, children: [{ type: 'text', text: m[1] }] })
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
    realtime: false,
    loading: false,
    result: null,
    costPlan: null,
    fallbackDriving: false,
    fallbackTip: '',
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
    this.setData({ destName: e.detail.value, dest: null })
  },

  setMode(e) {
    this.setData({ mode: this.data.modes[e.currentTarget.dataset.i].key, fallbackDriving: false, fallbackTip: '' })
    if (this.data.dest) this.plan()
  },

  onRealtime(e) {
    this.setData({ realtime: e.detail.value })
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
      this.setData({ result: normalizeRoute(r), fallbackDriving: false })
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
          this.setData({
            result: normalizeRoute(r),
            fallbackDriving: true,
            fallbackTip: this.crossCityTip(r)
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
