const app = getApp()
const config = require('../../utils/config.js')
const api = require('../../utils/api.js')
const bmap = require('../../utils/bmap.js')
const { getCareMode, setCareMode } = require('../../utils/token.js')
const { parseCity } = require('../../utils/city.js')
const voice = require('../../utils/voice.js')

Page({
  data: {
    safeTop: 20,
    center: { lng: 112.938814, lat: 28.228209 },
    scale: 15,
    cityText: '正在定位…',
    cityShort: '定位中',
    locSourceText: '',
    keyword: '',
    suggests: [],
    poiList: [],
    lastQuery: '',
    curIcon: '📍',
    loadingPoi: false,
    quickServices: config.QUICK_SERVICES,
    scenic: [],
    weather: null,
    careMode: false,
    sheetHeight: 300,
    sheetMin: 300,
    sheetMax: 600,
    voicePanel: false,
    voiceState: 'idle',
    voiceHint: '点击麦克风开始说话',
    voiceName: '我的声音',
    markers: [],
    circles: []
  },

  onLoad() {
    const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    const safeTop = (info.safeArea ? info.safeArea.top : info.statusBarHeight || 20) + 8
    const sheetMax = Math.round(info.windowHeight * 0.86)
    this.setData({
      safeTop,
      sheetMax,
      careMode: getCareMode()
    })
    voice.loadVoiceConfig().then((c) => {
      this.setData({ voiceName: c.speaker || '度丫丫' })
    })
    this.bootstrap()
  },

  onShow() {
    const care = getCareMode()
    this.setData({
      careMode: care,
      // 关怀模式：抽屉默认更高，减少翻找步骤
      sheetMin: care ? 380 : 300
    })
  },

  async bootstrap() {
    const loc = await app.getLocation()
    // 用端上百度 AK 补一次行政区（小程序端直连，低延迟）
    let cityText = [loc.city, loc.district].filter(Boolean).join(' ')
    if (!cityText && loc.lng) {
      try {
        const rev = await bmap.reverseGeocode(loc.lng, loc.lat)
        cityText = [rev.city, rev.district].filter(Boolean).join(' ')
        loc.city = rev.city
        loc.district = rev.district
        app.globalData.location = loc
      } catch (e) {}
    }
    this.applyLocation(loc, cityText)
    this.loadScenic()
    this.loadWeather()
  },

  applyLocation(loc, cityText) {
    this.setData({
      center: { lng: Number(loc.lng), lat: Number(loc.lat) },
      cityText: cityText || '当前位置',
      cityShort: parseCity(cityText) || '当前',
      locSourceText: loc.source === 'gps' ? 'GPS 定位' : loc.source === 'ip' ? 'IP 锚定' : '默认城市'
    })
    this.updateMarkers()
    this.updateCircle()
  },

  updateMarkers() {
    const c = this.data.center
    this.setData({
      markers: [
        {
          id: 1,
          longitude: c.lng,
          latitude: c.lat,
          width: 26,
          height: 26,
          callout: { content: '我的位置', color: '#1677FF', fontSize: 12, borderRadius: 6, padding: 4, display: 'BYCLICK' }
        }
      ]
    })
  },

  updateCircle() {
    const c = this.data.center
    this.setData({
      circles: [
        {
          longitude: c.lng,
          latitude: c.lat,
          radius: config.DEFAULT_RADIUS,
          fillColor: '#1677FF1A',
          color: '#1677FFAA',
          strokeWidth: 1
        }
      ]
    })
  },

  onMarkerTap() {
    wx.showToast({ title: '这是我的位置', icon: 'none' })
  },

  onKeywordChange(e) {
    const v = e.detail.value
    this.setData({ keyword: v })
    clearTimeout(this._st)
    if (!v || v.length < 2) {
      this.setData({ suggests: [] })
      return
    }
    this._st = setTimeout(() => {
      bmap
        .suggest(v, (this.data.cityText || '').split(' ')[0])
        .then((list) => this.setData({ suggests: (list || []).slice(0, 6) }))
        .catch(() => this.setData({ suggests: [] }))
    }, 350)
  },

  onPickSuggest(e) {
    const s = this.data.suggests[e.currentTarget.dataset.i]
    if (!s) return
    this.setData({
      keyword: s.name,
      suggests: [],
      center: s.lng ? { lng: s.lng, lat: s.lat } : this.data.center,
      poiList: [{ uid: 'sug', name: s.name, address: s.district, lng: s.lng, lat: s.lat, distText: '' }],
      lastQuery: s.name
    })
    this.expandSheet()
  },

  onSearch() {
    const kw = (this.data.keyword || '').trim()
    if (!kw) return
    this.setData({ suggests: [] })
    this.doSearch(kw, '🔍')
  },

  quickSearch(e) {
    const s = this.data.quickServices[e.currentTarget.dataset.i]
    if (!s) return
    this.setData({ keyword: s.name })
    this.doSearch(s.query, s.icon)
  },

  async doSearch(query, icon) {
    this.setData({ loadingPoi: true, curIcon: icon || '📍' })
    this.expandSheet()
    try {
      const d = await api.poiSearch(query, this.data.center.lng, this.data.center.lat, config.DEFAULT_RADIUS)
      const list = (d.items || [])
        .filter((x) => x.name)
        .map((x) => Object.assign({}, x, { distText: this.fmtDist(x.distance) }))
      this.setData({ poiList: list, lastQuery: this.data.keyword || query })
      this.updatePoiMarkers()
      if (!list.length) wx.showToast({ title: '附近没找到，试试 AI 助手', icon: 'none' })
    } catch (e) {
      this.setData({ poiList: [] })
      wx.showToast({ title: (e && e.msg) || '搜索失败，请确认服务端已启动', icon: 'none', duration: 2400 })
    } finally {
      this.setData({ loadingPoi: false })
    }
  },

  updatePoiMarkers() {
    const base = this.data.markers.filter((m) => m.id === 1)
    const list = this.data.poiList.slice(0, 20).map((p, i) => ({
      id: i + 100,
      longitude: p.lng,
      latitude: p.lat,
      width: 20,
      height: 20,
      callout: { content: p.name, color: '#1A1A1A', fontSize: 12, borderRadius: 6, padding: 4, display: 'BYCLICK' }
    }))
    this.setData({ markers: base.concat(list) })
  },

  clearPoi() {
    this.setData({ poiList: [], lastQuery: '' })
    this.collapseSheet()
    this.updateMarkers()
  },

  async loadScenic() {
    try {
      const d = await api.scenicRecommend(this.data.center.lng, this.data.center.lat, 3000)
      const list = (d.items || []).slice(0, 4).map((x) => Object.assign({}, x, { distText: this.fmtDist(x.distance) }))
      this.setData({ scenic: list })
    } catch (e) {}
  },

  async loadWeather() {
    try {
      const w = await api.weather(this.data.center.lng, this.data.center.lat)
      this.setData({ weather: w })
    } catch (e) {}
  },

  async locateMe() {
    wx.showLoading({ title: '定位中' })
    app.globalData.location = null
    const loc = await app.getLocation()
    wx.hideLoading()
    this.applyLocation(loc, [loc.city, loc.district].filter(Boolean).join(' '))
    wx.showToast({ title: '已回到我的位置', icon: 'none' })
  },

  goLife() {
    wx.switchTab({ url: '/pages/life/life' })
  },

  toggleCare() {
    const on = setCareMode(!this.data.careMode)
    this.setData({ careMode: on })
    wx.showToast({ title: on ? '关怀模式已开启' : '关怀模式已关闭', icon: 'none' })
  },

  expandSheet() {
    this.setData({ sheetHeight: Math.round(this.data.sheetMax * 0.62) })
  },

  collapseSheet() {
    this.setData({ sheetHeight: this.data.sheetMin })
  },

  /* ---------- 语音 ---------- */
  openVoice() {
    this.setData({ voicePanel: true, voiceState: 'idle', voiceHint: '点击麦克风开始说话' })
  },

  closeVoice() {
    if (this.data.voiceState === 'recording') {
      voice.stopRecord()
    }
    this.setData({ voicePanel: false })
  },

  noop() {},

  toggleRecord() {
    if (this.data.voiceState === 'recording') {
      voice.stopRecord()
      this.setData({ voiceState: 'processing', voiceHint: '正在识别…' })
      return
    }
    this.setData({ voiceState: 'recording', voiceHint: '再点一次结束' })
    voice.startRecord(async (res, err) => {
      if (!res || err) {
        this.setData({ voiceState: 'idle', voiceHint: '录音失败，请检查麦克风权限' })
        return
      }
      try {
        const text = await voice.recognize(res.tempFilePath)
        this.setData({ voicePanel: false, keyword: text })
        this.askAgent(text)
      } catch (e) {
        this.setData({ voiceState: 'idle', voiceHint: (e && e.message) || '没听清，请再说一次' })
      }
    })
  },

  async askAgent(text) {
    wx.showLoading({ title: '鲤慧思考中' })
    try {
      const r = await api.agentChat({
        text,
        lng: this.data.center.lng,
        lat: this.data.center.lat
      })
      wx.hideLoading()
      wx.showModal({ title: '鲤慧', content: r.reply, showCancel: false, confirmText: '知道了' })
      const poi = (r.cards || []).find((c) => c.type === 'poi_list')
      if (poi) {
        const list = poi.items.map((x) => Object.assign({}, x, { distText: this.fmtDist(x.distance) }))
        this.setData({ poiList: list, lastQuery: poi.title || text })
        this.updatePoiMarkers()
        this.expandSheet()
      }
      voice.speak(r.reply, { scene: 'chat', careMode: this.data.careMode })
    } catch (e) {
      wx.hideLoading()
    }
  },

  navigate(e) {
    const p = this.data.poiList[e.currentTarget.dataset.i]
    if (!p) return
    wx.navigateTo({ url: `/pages/route/route?name=${encodeURIComponent(p.name)}&lng=${p.lng}&lat=${p.lat}` })
  },

  fmtDist(d) {
    if (d === null || d === undefined || d === '') return ''
    return Number(d) >= 1000 ? (Number(d) / 1000).toFixed(1) + 'km' : Math.round(Number(d)) + 'm'
  },

  onShareAppMessage() {
    return { title: '鲤慧 · 15 分钟生活圈智能体检', path: '/pages/index/index' }
  }
})
