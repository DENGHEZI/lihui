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
    pref: { budget: 'low', withElderly: true, needPark: true, maxWalkMinutes: 15 }
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
          failedText: c.failed ? '（本次检索超时，不影响总分）' : '',
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
