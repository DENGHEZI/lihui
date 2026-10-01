const app = getApp()
const config = require('../../utils/config.js')
const api = require('../../utils/api.js')
const { getDeviceId, getPlan, getCareMode, setCareMode } = require('../../utils/token.js')
const { clearBizCache, getCacheSizeKB } = require('../../utils/request.js')
const { parseCity, parseDistrict } = require('../../utils/city.js')

const EMPTY_STATS = {
  total: { total: 0, calls: 0, costCny: 0 },
  quota: { daily: 200000, usedToday: 0, remainToday: 200000 },
  byModel: []
}

Page({
  data: {
    stats: EMPTY_STATS,
    costText: '0.0000',
    quotaPercent: 0,
    deviceShort: '',
    planName: '',
    careMode: false,
    locText: '未定位',
    appid: config.WX_APPID,
    serverText: config.BASE_URL,
    mcpText: '-',
    cacheKB: 0
  },

  onShow() {
    const plan = getPlan()
    this.setData({
      deviceShort: 'ID ' + getDeviceId().slice(-8),
      planName: plan === 'pro' ? '增强版（已接入 API）' : '免费基础版',
      careMode: getCareMode(),
      cacheKB: getCacheSizeKB()
    })
    this.loadStats()
    this.loadConfig()
    app.getLocation().then((l) => {
      const c = parseCity(l.city)
      const d = parseDistrict(l.district)
      this.setData({
        locText: [c, d].filter(Boolean).join(' ') || (l.source === 'gps' ? 'GPS 已就绪' : '未定位')
      })
    })
  },

  async loadStats() {
    try {
      const s = await api.tokenStats('7d')
      s.byModel = (s.byModel || []).map((m) => Object.assign({}, m, { costText: Number(m.costCny || 0).toFixed(4) }))
      this.setData({
        stats: s,
        costText: Number(s.total.costCny || 0).toFixed(4),
        quotaPercent: Math.min(100, Math.round((s.quota.usedToday / Math.max(1, s.quota.daily)) * 100))
      })
    } catch (e) {}
  },

  async loadConfig() {
    try {
      const c = await api.publicConfig()
      const list = c.mcpServers || []
      const running = list.filter((s) => s.status === 'running').length
      this.setData({ mcpText: running + '/' + list.length + ' 运行中' })
    } catch (e) {
      this.setData({ mcpText: '服务端未连接' })
    }
  },

  goSettings() {
    wx.navigateTo({ url: '/pages/settings/settings' })
  },
  goLife() {
    wx.switchTab({ url: '/pages/life/life' })
  },
  goFeedback() {
    wx.navigateTo({ url: '/pages/feedback/feedback' })
  },

  /** 一键清理业务缓存（保留设备指纹 / 套餐 / 关怀模式 / 语音配置） */
  onClearCache() {
    const before = getCacheSizeKB()
    clearBizCache()
    const after = getCacheSizeKB()
    this.setData({ cacheKB: after })
    wx.showToast({ title: '已清理 ' + Math.max(0, before - after) + ' KB 缓存', icon: 'none' })
  },

  onCare(e) {
    const on = setCareMode(e.detail.value)
    this.setData({ careMode: on })
    wx.showToast({ title: on ? '关怀模式已开启' : '关怀模式已关闭', icon: 'none' })
  },

  showAbout() {
    wx.showModal({
      title: '关于鲤慧',
      content:
        '鲤慧 LiHui v1.0.0\n基于百度地图开放能力的「15 分钟生活圈」智能体检与规划助手。\n\n多端 APP：Android / HarmonyOS / iOS\n微信小程序：本包\n\n所有百度地图能力经服务端中转，服务端 AK 不下发到端上。',
      showCancel: false
    })
  },

  onShareAppMessage() {
    return { title: '鲤慧 · 15 分钟生活圈智能体检', path: '/pages/index/index' }
  }
})
