const app = getApp()
const config = require('../../utils/config.js')
const api = require('../../utils/api.js')
const { getDeviceId, getPlan, getCareMode, setCareMode, getAuth, setAuth, clearAuth, patchAuthUser } = require('../../utils/token.js')
const { clearBizCache, getCacheSizeKB } = require('../../utils/request.js')
const { parseCity, parseDistrict } = require('../../utils/city.js')

const theme = require('../../utils/theme.js')
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
    cacheKB: 0,
    orderCount: 0,
    // 登录态 / 个人资料（昵称 + 头像，服务端 RBAC 账号体系）
    logged: false,
    nickname: '',
    avatarUrl: '',
    roleText: '',
    loginShow: false,
    loginMode: 'login', // login | register
    loginName: '',
    loginPwd: '',
    submitting: false
  },

  onShow() {
    theme.apply(this)
    const plan = getPlan()
    this.setData({
      deviceShort: 'ID ' + getDeviceId().slice(-8),
      planName: plan === 'pro' ? '增强版（已接入 API）' : '免费基础版',
      careMode: getCareMode(),
      cacheKB: getCacheSizeKB()
    })
    this.syncProfile()
    this.loadStats()
    this.loadConfig()
    this.loadOrderCount()
    app.getLocation().then((l) => {
      const c = parseCity(l.city)
      const d = parseDistrict(l.district)
      this.setData({
        locText: [c, d].filter(Boolean).join(' ') || (l.source === 'gps' ? 'GPS 已就绪' : '未定位')
      })
    })
  },

  /* ---------------- 登录态 / 个人资料 ----------------
   * 昵称与头像存在服务端用户记录（RBAC），本地缓存一份离线可显示；
   * 换头像 = wx.chooseMedia 压缩后读 base64 走 JSON 通道（免 uploadFile 域名校验）。 */
  syncProfile() {
    const a = getAuth()
    const u = a && a.user
    this.setData({
      logged: !!a,
      nickname: (u && (u.nickname || u.username)) || '',
      avatarUrl: (u && u.avatar) || '',
      roleText: u ? (u.role === 'admin' ? '管理员' : '已登录') : ''
    })
    if (!a) return
    // 静默拉最新资料：令牌过期/他端改过资料都能同步；401 就地清登录态
    api.authMe()
      .then((me) => {
        if (me && me.id) {
          patchAuthUser(me)
          this.syncProfile()
        }
      })
      .catch((e) => {
        if (e && (e.code === 4010 || e.status === 401 || e.code === 401)) {
          clearAuth()
          this.syncProfile()
        }
      })
  },

  hintLogin() {
    wx.showToast({ title: '请先登录', icon: 'none' })
    this.setData({ loginShow: true })
  },

  /* 换头像（点击头像） */
  onChooseAvatar() {
    if (!this.data.logged) {
      this.hintLogin()
      return
    }
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: (r) => {
        const f = r.tempFiles && r.tempFiles[0]
        if (f && f.tempFilePath) this.uploadAvatar(f.tempFilePath, f.size || 0)
      }
    })
  },

  uploadAvatar(path, size) {
    const fsm = wx.getFileSystemManager()
    const readB64 = (p) =>
      new Promise((resolve, reject) =>
        fsm.readFile({ filePath: p, encoding: 'base64', success: (x) => resolve(x.data), fail: reject })
      )
    const go = (p) => {
      readB64(p)
        .then((b64) => {
          const ext = /\.png$/i.test(p) ? 'png' : 'jpeg'
          wx.showLoading({ title: '上传中', mask: true })
          return api.authProfile({ avatar: 'data:image/' + ext + ';base64,' + b64 })
        })
        .then((d) => {
          wx.hideLoading()
          patchAuthUser(d.user)
          this.syncProfile()
          wx.showToast({ title: '头像已更新', icon: 'success' })
        })
        .catch((e) => {
          wx.hideLoading()
          wx.showToast({ title: (e && e.msg) || '头像更新失败', icon: 'none', duration: 2500 })
        })
    }
    if (size > 200 * 1024 && wx.compressImage) {
      // 大图先压一次（结果大小未知，交给服务端 190KB 上限兜底提示）
      wx.compressImage({ src: path, quality: 40, success: (c) => go(c.tempFilePath), fail: () => go(path) })
    } else {
      go(path)
    }
  },

  /* 改昵称（点击昵称） */
  onEditName() {
    if (!this.data.logged) {
      this.hintLogin()
      return
    }
    wx.showModal({
      title: '修改昵称',
      editable: true,
      content: this.data.nickname,
      placeholderText: '输入新昵称（1~24 字）',
      success: (r) => {
        if (!r.confirm) return
        const nick = String(r.content || '').trim()
        if (!nick) {
          wx.showToast({ title: '昵称不能为空', icon: 'none' })
          return
        }
        api.authProfile({ nickname: nick })
          .then((d) => {
            patchAuthUser(d.user)
            this.syncProfile()
            wx.showToast({ title: '昵称已更新', icon: 'success' })
          })
          .catch((e) => wx.showToast({ title: (e && e.msg) || '修改失败', icon: 'none' }))
      }
    })
  },

  /* ---------------- 登录 / 注册 / 退出 ---------------- */
  toggleLogin() {
    this.setData({ loginShow: !this.data.loginShow, loginMode: 'login', loginPwd: '' })
  },
  switchLoginMode() {
    this.setData({ loginMode: this.data.loginMode === 'login' ? 'register' : 'login', loginPwd: '' })
  },
  onNameInput(e) {
    this.setData({ loginName: e.detail.value })
  },
  onPwdInput(e) {
    this.setData({ loginPwd: e.detail.value })
  },
  doSubmit() {
    if (this.data.submitting) return
    const mode = this.data.loginMode
    const name = this.data.loginName.trim()
    const pwd = this.data.loginPwd
    if (name.length < 3 || pwd.length < 6) {
      wx.showToast({ title: '用户名≥3 位，密码≥6 位', icon: 'none' })
      return
    }
    this.setData({ submitting: true })
    const call = mode === 'register' ? api.authRegister(name, pwd) : api.authLogin(name, pwd)
    call
      .then((d) => {
        setAuth({ token: d.token, user: d.user })
        this.setData({ loginShow: false, loginPwd: '', submitting: false })
        this.syncProfile()
        wx.showToast({ title: mode === 'register' ? '注册成功' : '登录成功', icon: 'success' })
      })
      .catch((e) => {
        this.setData({ submitting: false })
        wx.showModal({
          title: mode === 'register' ? '注册失败' : '登录失败',
          content: (e && e.msg) || '请稍后再试',
          showCancel: false
        })
      })
  },
  onLogout() {
    wx.showModal({
      title: '退出登录',
      content: '确定退出当前账号？',
      success: (r) => {
        if (!r.confirm) return
        clearAuth()
        this.setData({ loginShow: false })
        this.syncProfile()
        wx.showToast({ title: '已退出', icon: 'none' })
      }
    })
  },

  /** 我的订单数量（本地订单里未完成的条数） */
  loadOrderCount() {
    try {
      const list = wx.getStorageSync('lh_orders') || []
      const pending = list.filter((x) => x.status === 'pending' || x.status === 'paid').length
      this.setData({ orderCount: pending })
    } catch (e) {}
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
  goPrivacy() {
    wx.navigateTo({ url: '/pages/privacy/privacy' })
  },
  goShop() {
    wx.navigateTo({ url: '/pages/shop/shop' })
  },
  goOrder() {
    wx.navigateTo({ url: '/pages/order/list' })
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
