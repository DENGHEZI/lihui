const api = require('../../utils/api.js')
const { getDeviceId } = require('../../utils/token.js')

const TYPES = [
  { key: 'bug', name: '问题反馈', icon: '🐞' },
  { key: 'feature', name: '功能建议', icon: '💡' },
  { key: 'complaint', name: '投诉', icon: '⚠️' },
  { key: 'praise', name: '表扬', icon: '👏' }
]
const STATUS_NAME = { pending: '待处理', processing: '处理中', resolved: '已解决', rejected: '已驳回' }
const STATUS_COLOR = { pending: '#FF8A00', processing: '#1677FF', resolved: '#00B96B', rejected: '#8F959E' }

Page({
  data: {
    form: { type: 'bug', content: '', contact: '', screenshots: [] },
    types: TYPES,
    history: []
  },

  setType(e) {
    this.setData({ 'form.type': TYPES[e.currentTarget.dataset.i].key })
  },

  onContent(e) {
    this.setData({ 'form.content': e.detail.value })
  },

  onContact(e) {
    this.setData({ 'form.contact': e.detail.value })
  },

  chooseImage() {
    const left = 3 - this.data.form.screenshots.length
    wx.chooseMedia({
      count: left,
      mediaType: ['image'],
      sizeType: ['compressed'],
      success: (res) => {
        const paths = res.tempFiles.map((f) => f.tempFilePath)
        this.setData({ 'form.screenshots': this.data.form.screenshots.concat(paths).slice(0, 3) })
      }
    })
  },

  delImg(e) {
    const list = this.data.form.screenshots.slice()
    list.splice(e.currentTarget.dataset.i, 1)
    this.setData({ 'form.screenshots': list })
  },

  async submit() {
    const content = (this.data.form.content || '').trim()
    if (!content) return
    wx.showLoading({ title: '提交中' })
    try {
      const r = await api.submitFeedback({
        type: this.data.form.type,
        content,
        contact: this.data.form.contact,
        deviceId: getDeviceId(),
        page: 'feedback',
        appVersion: '1.0.0',
        platform: 'miniprogram',
        screenshots: this.data.form.screenshots
      })
      wx.hideLoading()
      wx.showToast({ title: '已提交，感谢反馈', icon: 'success' })
      const t = TYPES.find((x) => x.key === this.data.form.type)
      const history = [
        {
          typeName: t ? t.name : '',
          content,
          statusName: STATUS_NAME[(r && r.status) || 'pending'],
          statusColor: STATUS_COLOR[(r && r.status) || 'pending'],
          createdAt: this.now(),
          reply: ''
        }
      ].concat(this.data.history)
      this.setData({ history, 'form.content': '', 'form.screenshots': [] })
    } catch (e) {
      wx.hideLoading()
    }
  },

  now() {
    const d = new Date()
    const p = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  },

  call(e) {
    wx.makePhoneCall({ phoneNumber: String(e.currentTarget.dataset.n), fail: () => {} })
  }
})
