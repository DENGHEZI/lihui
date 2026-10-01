/**
 * 鲤慧 LiHui · 关怀模式（适老化）
 * 存储键与 token.js 保持一致：lh_care_mode
 */
const KEY_CARE = 'lh_care_mode'

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

function toggleCareMode() {
  return setCareMode(!getCareMode())
}

module.exports = { getCareMode, setCareMode, toggleCareMode }
