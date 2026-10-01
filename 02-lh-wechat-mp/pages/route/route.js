const app = getApp()
const api = require('../../utils/api.js')
const bmap = require('../../utils/bmap.js')
const action = require('../../utils/action.js')

Page({
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
    this.setData({ mode: this.data.modes[e.currentTarget.dataset.i].key })
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
      r.km = (Number(r.distance || 0) / 1000).toFixed(1)
      r.min = Math.round(Number(r.duration || 0) / 60)
      r.steps = (r.steps || []).map((s) => Object.assign({}, s, { min: Math.round(Number(s.duration || 0) / 60) }))
      r.alternatives = (r.alternatives || []).map((a) =>
        Object.assign({}, a, { km: (Number(a.distance || 0) / 1000).toFixed(1), min: Math.round(Number(a.duration || 0) / 60) })
      )
      this.setData({ result: r })
      if (this.data.mode === 'driving') this.loadCost()
    } catch (e) {
      wx.showToast({ title: '规划失败', icon: 'none' })
    } finally {
      wx.hideLoading()
      this.setData({ loading: false })
    }
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
    const that = this
    wx.showModal({
      title: '确认导航',
      content: `将打开百度地图，从「${this.data.originName}」到「${this.data.destName}」`,
      success: (r) => {
        if (!r.confirm) return
        action
          .jumpToApp({
            app: '百度地图',
            type: 'direction',
            origin: `${that.data.origin.lat},${that.data.origin.lng}`,
            destination: that.data.destName,
            mode: that.data.mode
          })
          .catch(() => wx.showToast({ title: '跳转失败', icon: 'none' }))
      }
    })
  }
})
