const app = getApp()
const api = require('../../utils/api.js')
const { getCareMode, setCareMode } = require('../../utils/token.js')
const voice = require('../../utils/voice.js')
const action = require('../../utils/action.js')

let seq = 0
const nid = () => 'msg_' + Date.now().toString(36) + '_' + seq++

Page({
  data: {
    sessionId: '',
    input: '',
    messages: [],
    scrollTo: '',
    careMode: false,
    recording: false,
    scenes: [
      { icon: '🏥', name: '附近看病', text: '附近 15 分钟能看病吗？' },
      { icon: '🛒', name: '买菜', text: '附近哪里买菜最方便？' },
      { icon: '🌳', name: '遛弯', text: '附近适合遛弯的公园在哪？' },
      { icon: '💰', name: '省一笔', text: '帮我算下最省钱的出行方案' },
      { icon: '🚌', name: '怎么走', text: '我要出门，帮我规划路线并避开拥堵' },
      { icon: '🛍', name: '帮买', text: '帮我看看哪里买洗衣液最划算' },
      { icon: '💬', name: '聊聊', text: '今天有点累，想找人聊聊' }
    ]
  },

  onLoad() {
    const careMode = getCareMode()
    this.setData({
      careMode,
      sessionId: api.newSessionId(),
      messages: [
        {
          id: nid(),
          role: 'assistant',
          text: '我是鲤慧。\n可以问我：\n1. 附近哪里能看病？\n2. 15 分钟生活圈缺什么？\n3. 怎么走最省时间、最省钱？\n直接说，或点麦克风讲。',
          cards: [],
          actions: [],
          meta: '支持语音 · 关怀模式已' + (careMode ? '开启' : '关闭')
        }
      ]
    })
  },

  onShow() {
    this.setData({ careMode: getCareMode() })
  },

  onInput(e) {
    this.setData({ input: e.detail.value })
  },

  send() {
    const text = (this.data.input || '').trim()
    if (!text) return
    this.setData({ input: '' })
    this.ask(text)
  },

  askScene(e) {
    const s = this.data.scenes[e.currentTarget.dataset.i]
    if (s) this.ask(s.text)
  },

  async ask(text) {
    // 并发安全：占位消息带固定 id，返回后「按 id 替换」而不是 slice(0,-1)，
    // 连续多条对话时不会误删用户消息（修复"对话框消失"）
    const ph = { id: nid(), role: 'assistant', text: '正在为您查询…', cards: [], actions: [], pending: true }
    this.setData({ messages: this.data.messages.concat([{ id: nid(), role: 'user', text, cards: [], actions: [] }, ph]) })
    this.toBottom()

    const replacePh = (patch) => {
      this.setData({
        messages: this.data.messages.map((m) => (m.id === ph.id ? Object.assign({}, m, patch, { pending: false }) : m))
      })
      this.toBottom()
    }

    try {
      const loc = app.globalData.location || (await app.getLocation())
      const r = await api.agentChat({
        text,
        sessionId: this.data.sessionId,
        lng: loc.lng,
        lat: loc.lat
      })
      const cards = (r.cards || []).map((c) => {
        if (c.type === 'route') {
          c.km = (Number(c.distance || 0) / 1000).toFixed(1)
          c.min = Math.round(Number(c.duration || 0) / 60)
        }
        if (c.type === 'poi_list') {
          c.items = (c.items || []).map((x) => Object.assign({}, x, { distText: this.fmtDist(x.distance) }))
        }
        return c
      })
      replacePh({
        text: r.reply,
        cards,
        actions: r.actions || [],
        meta: `${r.model} · Token ${r.usage.total} · ¥${r.usage.costCny}`
      })
      voice.speak(r.reply, { scene: 'chat', careMode: this.data.careMode })
    } catch (e) {
      const offline = e && (e.errMsg || e.code === 'ECONN')
      replacePh({
        text: offline
          ? '网络连不上服务端：请确认手机与电脑在同一 WiFi，且服务端已启动。'
          : (e && e.msg) || '查询没有成功，请稍后再试一次。'
      })
    }
  },

  toBottom() {
    const last = this.data.messages.length - 1
    this.setData({ scrollTo: 'm' + last })
  },

  toggleRecord() {
    if (this.data.recording) {
      this.setData({ recording: false })
      voice.stopRecord()
      return
    }
    this.setData({ recording: true })
    wx.showToast({ title: '请开始说话', icon: 'none', duration: 1000 })
    voice.startRecord(async (res, err) => {
      this.setData({ recording: false })
      if (!res || err) {
        wx.showToast({ title: '录音失败，请检查麦克风权限', icon: 'none' })
        return
      }
      try {
        const text = await voice.recognize(res.tempFilePath)
        if (text) this.ask(text)
        else wx.showToast({ title: '没听清，请再说一次', icon: 'none' })
      } catch (e) {
        wx.showModal({
          title: '语音识别未就绪',
          content: (e && e.message) || '服务端未配置语音识别密钥，可先用文字输入',
          showCancel: false
        })
      }
    })
  },

  toggleCare() {
    const on = setCareMode(!this.data.careMode)
    this.setData({ careMode: on })
    wx.showToast({ title: on ? '关怀模式已开启' : '关怀模式已关闭', icon: 'none' })
  },

  runAction(e) {
    const a = this.data.messages[this.data.messages.length - 1].actions[e.currentTarget.dataset.i]
    if (!a) return
    wx.showModal({
      title: '确认跳转',
      content: `即将打开「${a.app}」并开始导航，是否继续？`,
      success: async (r) => {
        if (!r.confirm) return
        try {
          await action.jumpToApp({ app: a.app, destination: '' })
        } catch (err) {
          wx.showToast({ title: '跳转失败', icon: 'none' })
        }
      }
    })
  },

  confirmAction() {
    wx.showModal({
      title: '安全确认',
      content: '鲤慧不会读取或填写任何支付信息。付款前请务必自行核对价格与收货信息。是否继续？',
      confirmText: '已确认，继续',
      success: (r) => {
        if (r.confirm) wx.showToast({ title: '已记录，请按步骤操作', icon: 'none' })
      }
    })
  },

  goRoute(e) {
    const d = e.currentTarget.dataset
    wx.navigateTo({ url: `/pages/route/route?name=${encodeURIComponent(d.name)}&lng=${d.lng}&lat=${d.lat}` })
  },

  fmtDist(d) {
    if (d === null || d === undefined || d === '') return ''
    return Number(d) >= 1000 ? (Number(d) / 1000).toFixed(1) + 'km' : Math.round(Number(d)) + 'm'
  },

  onShareAppMessage() {
    return { title: '鲤慧 · 15 分钟生活圈智能助手', path: '/pages/assistant/assistant' }
  }
})
