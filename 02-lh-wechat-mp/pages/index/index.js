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
    // 订阅全局定位变化：定位 settle 时刷新首页中心点（客户反馈「定位位置和地点没有变化」）
    this._onLocChange = (loc) => this.syncLocationIfMoved(loc, true)
    app.on('locationChange', this._onLocChange)
    this.bootstrap()
  },

  onUnload() {
    if (this._onLocChange) app.off('locationChange', this._onLocChange)
  },

  onShow() {
    const care = getCareMode()
    this.setData({
      careMode: care,
      // 关怀模式：抽屉默认更高，减少翻找步骤
      sheetMin: care ? 380 : 300
    })
    // 切回首页时若全局定位已更新（且与当前展示差异明显），静默同步
    this.syncLocationIfMoved(app.globalData.location, false)
  },

  /** 两点球面距离（米），用于判断「定位是否真的移动了」 */
  distM(lng1, lat1, lng2, lat2) {
    const R = 6371000
    const rad = (d) => (Number(d) * Math.PI) / 180
    const dLat = rad(lat2 - lat1)
    const dLng = rad(lng2 - lng1)
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2
    return 2 * R * Math.asin(Math.sqrt(a))
  },

  /**
   * 全局定位与首页展示同步。
   * @param {object|null} loc 全局定位
   * @param {boolean} pushed 是否来自 locationChange 事件（true=定位刚刷新）
   * 规则：移动 >80m 或首次拿到城市文案才刷新，避免 GPS 抖动造成地图乱跳。
   */
  syncLocationIfMoved(loc, pushed) {
    if (!loc || !Number.isFinite(Number(loc.lng)) || !Number.isFinite(Number(loc.lat))) return
    const c = this.data.center
    const moved = this.distM(c.lng, c.lat, Number(loc.lng), Number(loc.lat))
    const firstCity = !this._cityApplied && (loc.city || loc.district)
    const need = pushed ? moved > 80 : moved > 80 || firstCity
    if (!need) return
    this._cityApplied = true
    this._lastLocTs = loc.ts
    this.applyLocation(loc, [loc.city, loc.district].filter(Boolean).join(' ') || this.data.cityText)
    // 位置真正变了（>200m）：周边推荐 / 天气跟着刷新；有搜索词就顺带重搜
    if (moved > 200) {
      this.loadScenic()
      this.loadWeather()
      if (this.data.lastQuery) this.doSearch(this.data.lastQuery, this.data.curIcon)
    }
  },

  async bootstrap() {
    const loc = await app.getLocation()
    if (!loc) {
      this.setData({ cityText: '定位不可用', cityShort: '未定位', locSourceText: '请开启系统定位' })
      return
    }
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
    const src =
      loc.source === 'gps'
        ? 'GPS 定位'
        : loc.source === 'gps-coarse'
        ? '网络定位（±' + Math.round(loc.accuracy || 0) + 'm）'
        : loc.source === 'ip'
        ? 'IP 锚定（±' + Math.round(loc.accuracy || 3000) + 'm，建议开定位）'
        : '默认城市'
    this.setData({
      center: { lng: Number(loc.lng), lat: Number(loc.lat) },
      cityText: cityText || '当前位置',
      cityShort: parseCity(cityText) || '当前',
      locSourceText: src
    })
    if (cityText && cityText !== '当前位置') this._cityApplied = true
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
      wx.showToast({ title: (e && (e.msg || e.errMsg)) || '搜索失败，请稍后重试', icon: 'none', duration: 2400 })
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

  /* ---------- 地址补查（用户共创） ----------
   * 客户发现地址缺失/不准：就地报 → 云端留存 → 之后所有人检索自动生效。
   * 提交成功本地立即生效（乐观更新），不等下一次检索。 */
  fixAddr(e) {
    const i = Number(e.currentTarget.dataset.i)
    const p = this.data.poiList[i]
    if (!p) return
    wx.showModal({
      title: '补充「' + (p.name || '该地点') + '」的地址',
      editable: true,
      placeholderText: '请输入详细地址，如：北湖区xx路xx号',
      confirmText: '提交',
      success: async (r) => {
        if (!r.confirm) return
        const addr = (r.content || '').trim()
        if (!addr) return wx.showToast({ title: '地址不能为空', icon: 'none' })
        try {
          await api.addrFix({
            // suggest 结果没有百度 uid（uid='sug' 是本地占位），按名字+坐标云端判重即可
            uid: p.uid && p.uid !== 'sug' ? p.uid : '',
            name: p.name,
            lng: Number(p.lng) || this.data.center.lng,
            lat: Number(p.lat) || this.data.center.lat,
            address: addr
          })
          this.setData({ ['poiList[' + i + '].address']: addr })
          wx.showToast({ title: '感谢补充，已同步云端', icon: 'success' })
        } catch (err) {
          wx.showToast({ title: (err && err.msg) || '提交失败，稍后再试', icon: 'none' })
        }
      }
    })
  },

  /** 补一个地图上没有的地点（两步弹窗：名称 → 地址，坐标取当前定位） */
  addPlace() {
    wx.showModal({
      title: '补充新地点 · 第 1 步',
      editable: true,
      placeholderText: '地点名称，如：张记早餐店',
      confirmText: '下一步',
      success: (r1) => {
        if (!r1.confirm) return
        const name = (r1.content || '').trim()
        if (!name) return wx.showToast({ title: '名称不能为空', icon: 'none' })
        wx.showModal({
          title: '补充新地点 · 第 2 步',
          editable: true,
          placeholderText: '详细地址，如：北湖区xx路xx号',
          confirmText: '提交',
          success: async (r2) => {
            if (!r2.confirm) return
            const addr = (r2.content || '').trim()
            if (!addr) return wx.showToast({ title: '地址不能为空', icon: 'none' })
            try {
              await api.addrFix({
                name,
                address: addr,
                lng: this.data.center.lng,
                lat: this.data.center.lat
              })
              wx.showToast({ title: '已收录，感谢补充', icon: 'success' })
              // 顺手把新地点塞进当前列表（带「用户补充」标），所见即所得
              this.setData({
                poiList: this.data.poiList.concat([{
                  uid: 'user_' + Date.now().toString(36),
                  name,
                  address: addr,
                  lng: this.data.center.lng,
                  lat: this.data.center.lat,
                  distText: '',
                  tag: '用户补充',
                  userAdded: true
                }])
              })
              this.updatePoiMarkers()
              this.expandSheet()
            } catch (err) {
              wx.showToast({ title: (err && err.msg) || '提交失败，稍后再试', icon: 'none' })
            }
          }
        })
      }
    })
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
    const loc = await app.getLocation({ force: true })
    wx.hideLoading()
    if (!loc) {
      wx.showToast({ title: '定位失败，请检查系统定位权限', icon: 'none', duration: 2400 })
      return
    }
    this.applyLocation(loc, [loc.city, loc.district].filter(Boolean).join(' '))
    wx.showToast({ title: '已回到我的位置', icon: 'none' })
  },

  goLife() {
    wx.switchTab({ url: '/pages/life/life' })
  },

  goShop() {
    wx.navigateTo({ url: '/pages/shop/shop' })
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
      voice.stopSpeech(this._speechMode)
    }
    this.setData({ voicePanel: false })
  },

  noop() {},

  toggleRecord() {
    if (this.data.voiceState === 'recording') {
      voice.stopSpeech(this._speechMode)
      this.setData({ voiceState: 'processing', voiceHint: '正在识别…' })
      return
    }
    this._speechMode = voice.startSpeech({
      onPartial: (t) => this.setData({ voiceHint: t }),
      onFinal: (t) => {
        this.setData({ voicePanel: false, keyword: t })
        this.askAgent(t)
      },
      onError: (e) => this.setData({ voiceState: 'idle', voiceHint: (e && e.msg) || '识别失败，请重试' })
    })
    this.setData({ voiceState: 'recording', voiceHint: '正在聆听…说完点一下结束' })
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

  /**
   * 休闲推荐卡点击 —— 走 scenery 自己的数组，不能复用 navigate()。
   * ⚠️ 踩坑：这里早期直接 bindtap="navigate" + data-i，而 navigate() 读的是 poiList；
   *    折叠态下 poiList 是空数组 → 点一下 p 为 undefined 直接 return，表现就是「卡片点不动」。
   *    现在改成用 this.data.scenic[index]，坐标来自百度 place 检索（GCJ-02）。
   */
  onScenicTap(e) {
    const idx = Number(e.currentTarget.dataset.i)
    const s = this.data.scenic[idx]
    if (!s) return
    const lng = Number(s.lng)
    const lat = Number(s.lat)
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
      wx.showToast({ title: '该景点暂无坐标，换个再看', icon: 'none', duration: 2000 })
      return
    }
    wx.navigateTo({
      url: `/pages/route/route?name=${encodeURIComponent(s.name)}&lng=${lng}&lat=${lat}`
    })
  },

  fmtDist(d) {
    if (d === null || d === undefined || d === '') return ''
    return Number(d) >= 1000 ? (Number(d) / 1000).toFixed(1) + 'km' : Math.round(Number(d)) + 'm'
  },

  onShareAppMessage() {
    return { title: '鲤慧 · 30 分钟生活圈智能体检', path: '/pages/index/index' }
  }
})
