/**
 * 鲤慧 LiHui · 小程序设备指纹与本地存储
 */
const KEY_DEVICE = 'lh_device_id'
const KEY_PLAN = 'lh_plan'
const KEY_CARE = 'lh_care_mode'
const KEY_VOICE = 'lh_voice_cfg'
const KEY_AUTH = 'lh_auth' // { token, user } 登录态

function randomId() {
  let s = ''
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  for (let i = 0; i < 16; i++) s += chars[Math.floor(Math.random() * chars.length)]
  return s
}

function ensureDeviceId() {
  let id = ''
  try {
    id = wx.getStorageSync(KEY_DEVICE)
  } catch (e) {}
  if (!id) {
    id = 'dev_' + Date.now().toString(36) + randomId().slice(0, 8)
    try {
      wx.setStorageSync(KEY_DEVICE, id)
    } catch (e) {}
  }
  return id
}

function getDeviceId() {
  try {
    return wx.getStorageSync(KEY_DEVICE) || ensureDeviceId()
  } catch (e) {
    return ensureDeviceId()
  }
}

function getPlan() {
  try {
    // 默认免费基础版：不调用任何付费 API（客户要求）
    return wx.getStorageSync(KEY_PLAN) || 'free'
  } catch (e) {
    return 'free'
  }
}

function setPlan(p) {
  try {
    wx.setStorageSync(KEY_PLAN, p)
  } catch (e) {}
}

/* 关怀模式 */
function getCareMode() {
  try {
    return !!wx.getStorageSync(KEY_CARE)
  } catch (e) {
    return false
  }
}

function setCareMode(on) {
  try {
    wx.setStorageSync(KEY_CARE, !!on)
  } catch (e) {}
  return !!on
}

/* 本地语音配置缓存（无服务端时也能用） */
function getVoiceCache() {
  try {
    return wx.getStorageSync(KEY_VOICE) || {}
  } catch (e) {
    return {}
  }
}

function setVoiceCache(cfg) {
  try {
    wx.setStorageSync(KEY_VOICE, cfg)
  } catch (e) {}
}

/* 登录态（RBAC 令牌 + 用户资料）
 * user 里含 nickname/avatar，改资料后这里同步更新，「我的」页离线也能显示 */
function getAuth() {
  try {
    return wx.getStorageSync(KEY_AUTH) || null
  } catch (e) {
    return null
  }
}

function setAuth(data) {
  try {
    wx.setStorageSync(KEY_AUTH, data || null)
  } catch (e) {}
}

function clearAuth() {
  try {
    wx.removeStorageSync(KEY_AUTH)
  } catch (e) {}
}

function getAuthToken() {
  const a = getAuth()
  return (a && a.token) || ''
}

function patchAuthUser(user) {
  const a = getAuth() || {}
  a.user = Object.assign({}, a.user || {}, user || {})
  setAuth(a)
  return a.user
}

module.exports = {
  ensureDeviceId,
  getDeviceId,
  getPlan,
  setPlan,
  getCareMode,
  setCareMode,
  getVoiceCache,
  setVoiceCache,
  getAuth,
  setAuth,
  clearAuth,
  getAuthToken,
  patchAuthUser
}
