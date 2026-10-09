/**
 * 鲤慧 LiHui · 隐私中心（小程序端）
 *
 * 对齐网页端 /privacy 与服务端 V1.0.10 隐私合规：
 *   - 展示版本化隐私政策全文（GET /privacy/policy，10 分钟缓存，失败给本地摘要兜底）
 *   - 展示当前同意状态（本地 + 服务端双查）
 *   - 自助权：同意 / 撤回 / 导出（复制 JSON）/ 删除（二次确认）
 */
const privacy = require('../../utils/privacy.js')

/** 政策拉取失败时的本地兜底摘要（与服务端 POLICY.summary 口径一致） */
const FALLBACK = {
  version: '2026-10-09',
  effectiveAt: '2026-10-09',
  contact: 'privacy@lihui-tech.online',
  summary:
    '鲤慧在你同意后才会记录用于「个性化推荐」的行为数据（搜过什么、聊过什么话题、点过哪些店、发起过导航）；未同意时这些功能照常可用，只是不做个性化。你可随时导出或删除你的全部数据。',
  collected: [],
  notCollected: [],
  storage: '',
  rights: [],
}

Page({
  data: {
    policy: null,
    agreed: false,
    decided: false,
    loading: true,
    serverConsented: null, // 服务端侧状态（null=未知）
    busy: false,
  },

  onShow() {
    this.refresh()
  },

  refresh() {
    this.setData({ agreed: privacy.hasAgreed(), decided: privacy.isDecided() })
    this.loadPolicy()
    this.loadServerStatus()
  },

  loadPolicy() {
    this.setData({ loading: true })
    return privacy
      .fetchPolicy()
      .then((policy) => this.setData({ policy: policy || FALLBACK, loading: false }))
      .catch(() => this.setData({ policy: FALLBACK, loading: false }))
  },

  loadServerStatus() {
    privacy
      .fetchConsentStatus()
      .then((d) => this.setData({ serverConsented: !!(d && d.consented) }))
      .catch(() => this.setData({ serverConsented: null }))
  },

  /* —— 同意 —— */
  onAgree() {
    if (this.data.busy) return
    this.setData({ busy: true })
    privacy
      .agree()
      .then(() => {
        wx.showToast({ title: '已同意', icon: 'success' })
        this.refresh()
      })
      .catch(() => wx.showToast({ title: '网络异常，稍后再试', icon: 'none' }))
      .then(() => this.setData({ busy: false }))
  },

  /* —— 撤回 —— */
  onWithdraw() {
    if (this.data.busy) return
    wx.showModal({
      title: '撤回同意',
      content: '将停止个性化采集，并立即删除已记录的行为画像。基础功能不受影响。确定撤回？',
      confirmText: '撤回',
      cancelText: '再想想',
      success: (r) => {
        if (!r.confirm) return
        this.setData({ busy: true })
        privacy
          .withdraw()
          .then(() => {
            wx.showToast({ title: '已撤回并删除画像', icon: 'none' })
            this.refresh()
          })
          .catch(() => wx.showToast({ title: '网络异常，稍后再试', icon: 'none' }))
          .then(() => this.setData({ busy: false }))
      },
    })
  },

  /* —— 导出（可携权）：复制 JSON 到剪贴板 —— */
  onExport() {
    if (this.data.busy) return
    this.setData({ busy: true })
    privacy
      .exportData()
      .then((data) => {
        try {
          wx.setClipboardData({ data: JSON.stringify(data, null, 2) })
          wx.showToast({ title: '数据已复制到剪贴板', icon: 'none' })
        } catch (e) {
          wx.showToast({ title: '导出失败', icon: 'none' })
        }
      })
      .catch(() => wx.showToast({ title: '网络异常，稍后再试', icon: 'none' }))
      .then(() => this.setData({ busy: false }))
  },

  /* —— 删除（被遗忘权）：两次确认，不可恢复 —— */
  onDelete() {
    if (this.data.busy) return
    wx.showModal({
      title: '删除全部数据',
      content: '将永久删除你的行为画像与同意记录，不可恢复。确定继续？',
      confirmText: '继续',
      cancelText: '取消',
      confirmColor: '#D64545',
      success: (r1) => {
        if (!r1.confirm) return
        wx.showModal({
          title: '最后确认',
          content: '再次确认：删除后无法找回。真的要删除吗？',
          confirmText: '删除',
          cancelText: '保留',
          confirmColor: '#D64545',
          success: (r2) => {
            if (!r2.confirm) return
            this.setData({ busy: true })
            privacy
              .deleteAll()
              .then(() => {
                wx.showToast({ title: '已删除全部数据', icon: 'none' })
                this.refresh()
              })
              .catch(() => wx.showToast({ title: '网络异常，稍后再试', icon: 'none' }))
              .then(() => this.setData({ busy: false }))
          },
        })
      },
    })
  },
})
