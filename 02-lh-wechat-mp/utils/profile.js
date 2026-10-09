/**
 * 鲤慧 LiHui · 用户画像埋点封装（端上）
 *
 * 设计要点：
 *  - 完全静默：走 request 的 silent 模式，埋点失败不弹任何 toast/modal
 *  - 默认开启：开关存 lh_personalize（settings 页可关），关闭后端上不再上报，
 *    服务端画像因无新数据 + 每日 0.98 衰减自然淡化，历史画像仍可 profile/reset 清除
 *  - 5s 节流：同 event + 同 payload 签名 5 秒内只发一次，防连点刷数据
 *  - 隐私边界：只上报离散 POI（uid/名称/坐标）与搜索词/类目，不采集任何身份信息；
 *    deviceId 为安装时随机生成的匿名 ID（utils/token.js）
 */
const { post } = require('./request.js')
const privacy = require('./privacy.js')

const STORE_KEY = 'lh_personalize'
const THROTTLE_MS = 5000

let _enabled = null // 惰性初始化：null = 尚未读过 storage
const _lastSig = {} // sig -> timestamp

function isEnabled() {
  if (_enabled === null) {
    try { _enabled = wx.getStorageSync(STORE_KEY) !== false } catch (e) { _enabled = true }
  }
  return _enabled
}

/** 设置个性化开关（settings 页调用）；关闭即停报，无需通知服务端 */
function setEnabled(v) {
  _enabled = !!v
  try { wx.setStorageSync(STORE_KEY, _enabled) } catch (e) {}
}

/**
 * 上报行为事件（fire-and-forget，永不 reject 出错影响页面）
 * 服务端 6 类事件：search / chat_topic / poi_click / navigate / care_toggle / model_switch
 * @param {string} event 事件名
 * @param {object} payload 载荷（search: {query, category}；poi_click/navigate: {uid,name,lng,lat}）
 */
function track(event, payload) {
  if (!isEnabled()) return
  if (!privacy.hasAgreed()) return // 隐私同意门控：未同意端上直接不采集（服务端 V1.0.10 同步门控兜底）
  if (!event) return
  let sig = ''
  try { sig = event + '|' + JSON.stringify(payload || {}) } catch (e) { return }
  const now = Date.now()
  if (_lastSig[sig] && now - _lastSig[sig] < THROTTLE_MS) return
  _lastSig[sig] = now
  post('/profile/track', { event, payload: payload || {} }, { silent: true }).catch(() => {})
}

module.exports = { track, isEnabled, setEnabled }
