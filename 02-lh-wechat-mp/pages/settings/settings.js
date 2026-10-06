const api = require('../../utils/api.js')
const { getPlan, setPlan, getCareMode, setCareMode } = require('../../utils/token.js')
const voice = require('../../utils/voice.js')
const action = require('../../utils/action.js')

const theme = require('../../utils/theme.js')
const profile = require('../../utils/profile.js')
Page({
  data: {
    models: [],
    plan: 'pro',
    personalize: true,
    voice: { engine: 'baidu', speaker: 'per_4', speed: 1, pitch: 1, volume: 1, wakeWord: '小鲤小鲤', dialect: 'putonghua', autoSpeak: true, careMode: false },
    speedVal: 50,
    pitchVal: 50,
    volumeVal: 50,
    engineIndex: 0,
    speakerIndex: 0,
    dialectIndex: 0,
    providerIndex: 0,
    providerNames: ['OpenAI 兼容', 'DeepSeek', 'Anthropic', 'Gemini', '本地 Ollama', '百度千帆'],
    editor: { show: false, id: '', name: '', provider: 'openai-compatible', baseUrl: '', apiKey: '', model: '' },
    providers: [
      { key: 'openai-compatible', name: 'OpenAI 兼容' },
      { key: 'deepseek', name: 'DeepSeek' },
      { key: 'anthropic', name: 'Anthropic' },
      { key: 'gemini', name: 'Gemini' },
      { key: 'ollama', name: '本地 Ollama' },
      { key: 'baidu-qianfan', name: '百度千帆' }
    ],
    engines: [
      { key: 'baidu', name: '百度语音（推荐）' },
      { key: 'azure', name: 'Azure 语音' },
      { key: 'local', name: '系统 TTS（离线）' },
      { key: 'custom', name: '自定义接口' }
    ],
    speakers: [
      { key: 'per_4', name: '度丫丫 · 温柔女声（适老）' },
      { key: 'per_0', name: '度小美 · 标准女声' },
      { key: 'per_1', name: '度小宇 · 标准男声' },
      { key: 'per_3', name: '度逍遥 · 磁性男声' },
      { key: 'per_5003', name: '度米朵 · 情感女声' }
    ],
    dialects: [
      { key: 'putonghua', name: '普通话' },
      { key: 'yue', name: '粤语' },
      { key: 'sichuan', name: '四川话' },
      { key: 'dongbei', name: '东北话' }
    ]
  },

  onShow() {
    theme.apply(this)
  },

  onLoad() {
    this.setData({
      engineNames: this.data.engines.map((e) => e.name),
      speakerNames: this.data.speakers.map((s) => s.name),
      dialectNames: this.data.dialects.map((d) => d.name)
    })
    this.syncPickers()
    this.setData({ plan: getPlan(), personalize: profile.isEnabled() })
    this.loadModels()
    this.loadVoice()
  },

  syncPickers() {
    const v = this.data.voice
    const idx = (arr, key) => {
      const i = arr.findIndex((x) => x.key === key)
      return i < 0 ? 0 : i
    }
    this.setData({
      engineIndex: idx(this.data.engines, v.engine),
      speakerIndex: idx(this.data.speakers, v.speaker),
      dialectIndex: idx(this.data.dialects, v.dialect),
      speedVal: Math.round(v.speed * 50),
      pitchVal: Math.round(v.pitch * 50),
      volumeVal: Math.round(v.volume * 50)
    })
  },

  async loadModels() {
    try {
      const d = await api.listModels(false)
      const items = (d.items || []).map((m) =>
        Object.assign({}, m, {
          // 免费渠道标注：ModelScope 免费推理 / 硅基流动免费档
          isFree: /modelscope|siliconflow/i.test(m.baseUrl || '')
        })
      )
      this.setData({ models: items })
    } catch (e) {
      this.setData({ models: [] })
    }
  },

  /* 外观模式（白天 / 夜间，storage 持久，各页 onShow 自动跟随） */
  setThemeLight() {
    theme.set('light')
    theme.apply(this)
    wx.showToast({ title: '已切换到白天模式', icon: 'none' })
  },
  setThemeDark() {
    theme.set('dark')
    theme.apply(this)
    wx.showToast({ title: '已切换到夜间模式', icon: 'none' })
  },

  async loadVoice() {
    try {
      const cfg = await api.getVoiceConfig()
      const voice = Object.assign({}, this.data.voice, cfg, { careMode: getCareMode() })
      this.setData({ voice })
      this.syncPickers()
    } catch (e) {}
  },

  openEditor(e) {
    const i = Number(e.currentTarget.dataset.i)
    if (i >= 0 && this.data.models[i]) {
      const m = this.data.models[i]
      this.setData({
        editor: { show: true, id: m.id, name: m.name, provider: m.provider, baseUrl: m.baseUrl, apiKey: '', model: m.model }
      })
    } else {
      this.setData({ editor: { show: true, id: '', name: '', provider: 'openai-compatible', baseUrl: '', apiKey: '', model: '' } })
    }
    this.refreshProviderIndex()
  },

  refreshProviderIndex() {
    const i = this.data.providers.findIndex((p) => p.key === this.data.editor.provider)
    this.setData({ providerIndex: i < 0 ? 0 : i, providerNames: this.data.providers.map((p) => p.name) })
  },

  closeEditor() {
    this.setData({ 'editor.show': false })
  },

  noop() {},

  onEditInput(e) {
    const k = e.currentTarget.dataset.k
    this.setData({ ['editor.' + k]: e.detail.value })
  },

  onProvider(e) {
    const p = this.data.providers[e.detail.value]
    this.setData({ 'editor.provider': p.key, providerIndex: e.detail.value })
  },

  async saveItem() {
    const ed = this.data.editor
    if (!ed.name || !ed.model) {
      wx.showToast({ title: '请填写名称与模型名', icon: 'none' })
      return
    }
    wx.showLoading({ title: '保存中' })
    try {
      await api.saveModel(ed)
      wx.hideLoading()
      this.setData({ 'editor.show': false })
      wx.showToast({ title: '已保存', icon: 'success' })
      this.loadModels()
    } catch (e) {
      wx.hideLoading()
    }
  },

  async testItem(e) {
    wx.showLoading({ title: '测试中' })
    try {
      const r = await api.testModel({ id: e.currentTarget.dataset.id })
      wx.hideLoading()
      if (r && r.ok) {
        wx.showModal({ title: '连接正常', content: `耗时 ${r.latencyMs} ms\n回复：${r.reply}`, showCancel: false })
      } else {
        wx.showModal({ title: '连接失败', content: (r && r.msg) || '请检查 Base URL 与 Key', showCancel: false })
      }
    } catch (err) {
      wx.hideLoading()
    }
  },

  async setDefault(e) {
    try {
      await api.setDefaultModel(e.currentTarget.dataset.id)
      wx.showToast({ title: '已设为默认模型', icon: 'none' })
      this.loadModels()
    } catch (err) {}
  },

  /* 语音 */
  onEngine(e) {
    this.setData({ 'voice.engine': this.data.engines[e.detail.value].key, engineIndex: e.detail.value })
    this.save()
  },
  onSpeaker(e) {
    this.setData({ 'voice.speaker': this.data.speakers[e.detail.value].key, speakerIndex: e.detail.value })
    this.save()
  },
  onDialect(e) {
    this.setData({ 'voice.dialect': this.data.dialects[e.detail.value].key, dialectIndex: e.detail.value })
    this.save()
  },
  onSpeed(e) {
    this.setData({ 'voice.speed': e.detail.value / 50, speedVal: e.detail.value })
    this.save()
  },
  onPitch(e) {
    this.setData({ 'voice.pitch': e.detail.value / 50, pitchVal: e.detail.value })
    this.save()
  },
  onVolume(e) {
    this.setData({ 'voice.volume': e.detail.value / 50, volumeVal: e.detail.value })
    this.save()
  },
  onWakeWord(e) {
    this.setData({ 'voice.wakeWord': e.detail.value })
    this.save()
  },
  onAutoSpeak(e) {
    this.setData({ 'voice.autoSpeak': e.detail.value })
    this.save()
  },
  onCare(e) {
    const on = setCareMode(e.detail.value)
    this.setData({ 'voice.careMode': on })
    this.save()
  },

  /** 个性化推荐开关：关闭后端上停止上报行为画像（历史画像可在服务端清除） */
  onPersonalize(e) {
    const on = !!e.detail.value
    profile.setEnabled(on)
    this.setData({ personalize: on })
    wx.showToast({ title: on ? '已开启个性化推荐' : '已关闭，不再记录习惯', icon: 'none' })
  },

  async save() {
    try {
      await api.saveVoiceConfig(this.data.voice)
      await voice.loadVoiceConfig(true)
    } catch (e) {}
  },

  async trySpeak() {
    await this.save()
    voice.speak('前面 300 米有药店，走路 4 分钟就到。', { scene: 'navigation', careMode: this.data.voice.careMode, force: true })
    wx.showToast({ title: '正在试听', icon: 'none' })
  },

  setFree() {
    setPlan('free')
    this.setData({ plan: 'free' })
    wx.showToast({ title: '已切换到免费基础版', icon: 'none' })
  },
  setPro() {
    setPlan('pro')
    this.setData({ plan: 'pro' })
    wx.showToast({ title: '已切换到增强版', icon: 'none' })
  },

  async showMcp() {
    wx.showLoading({ title: '读取中' })
    try {
      const d = await api.agentTools(this.data.plan)
      wx.hideLoading()
      const text = (d.groups || [])
        .map((g) => g.serverName + '：' + g.tools.map((t) => t.name).join('、'))
        .join('\n')
      wx.showModal({ title: d.total + ' 个可用工具', content: text || '暂无', showCancel: false })
    } catch (e) {
      wx.hideLoading()
    }
  },

  /** 推荐平台直达（白名单跳转，需用户点按确认，符合微信规范） */
  jumpPlatform(e) {
    const app = e.currentTarget.dataset.app
    wx.showModal({
      title: '确认跳转',
      content: `即将打开「${app}」小程序，是否继续？`,
      success: async (r) => {
        if (!r.confirm) return
        const res = await action.jumpToApp({ app })
        if (!res || !res.jumped) wx.showToast({ title: '跳转失败，请重试', icon: 'none' })
      }
    })
  }
})
