/**
 * 鲤慧 LiHui · 小程序隐私服务（与网页端 /privacy、服务端 V1.0.10 隐私合规对齐）
 *
 * 设计要点：
 *  - 同意状态本地存储 lh_privacy_consent（'1' 同意 / '0' 拒绝 / '' 未选择），
 *    服务端双记（POST /privacy/consent，幂等，每次启动静默补登）
 *  - 首次启动弹一次 wx.showModal 征求同意；用户拒绝后不再骚扰，
 *    可随时到「我的 → 隐私中心」重新选择
 *  - 画像采集前置门控：utils/profile.js track() 未同意直接 return（端上就不发，
 *    服务端 V1.0.10 门控兜底，双保险）
 *  - 自助权：撤回（停采+删画像）、导出（复制 JSON）、删除（二次确认）
 */
const { get, post } = require('./request.js')
const { getDeviceId } = require('./token.js')

const KEY = 'lh_privacy_consent'

/* ---------------- 本地状态 ---------------- */
function getLocal() {
  try { return String(wx.getStorageSync(KEY) || '') } catch (e) { return '' }
}
function hasAgreed() { return getLocal() === '1' }
function isDecided() { return getLocal() !== '' }

function setLocal(v) {
  try { wx.setStorageSync(KEY, v ? '1' : '0') } catch (e) {}
}

/* ---------------- 服务端同步（全部静默，失败不影响主流程） ---------------- */
/** 同意（本地 + 服务端双记；服务端幂等） */
function agree() {
  setLocal(true)
  return post('/privacy/consent', { deviceId: getDeviceId(), version: '' }, { silent: true }).catch(() => {})
}
/** 拒绝（仅本地；不采不传） */
function reject() {
  setLocal(false)
  return Promise.resolve(false)
}
/** 撤回同意（服务端停采 + 立即删除画像；本地回到拒绝态） */
function withdraw() {
  return post('/privacy/withdraw', { deviceId: getDeviceId() }, { silent: true })
    .then((d) => { setLocal(false); return d })
    .catch((e) => { throw e })
}
/** 查询服务端同意状态 */
function fetchConsentStatus() {
  return get('/privacy/consent', { deviceId: getDeviceId() }, { silent: true })
}
/** 隐私政策全文（版本化） */
function fetchPolicy() {
  return get('/privacy/policy', {}, { cacheTtl: 10 * 60 * 1000 })
}
/** 数据导出（可携权）→ 返回数据对象 */
function exportData() {
  return get('/privacy/export', { deviceId: getDeviceId() }, { silent: true })
}
/** 数据删除（被遗忘权，需 confirm:'DELETE'） */
function deleteAll() {
  return post('/privacy/delete', { deviceId: getDeviceId(), confirm: 'DELETE' }, { silent: true })
    .then((d) => { setLocal(false); return d })
}

/* ---------------- 首次启动同意弹窗 ----------------
 * 未做过选择才弹；确定=同意并继续，取消=仅使用基础功能（可后补同意）。
 * 微信 modal 按钮文案上限 4 字，长说明放「我的 → 隐私中心」政策页。 */
function ensureFirstRun(app) {
  if (isDecided()) {
    if (hasAgreed()) agree() // 已同意 → 静默补登服务端（幂等）
    return
  }
  // 延迟到首屏渲染稳定后再弹，避免与定位授权弹窗叠车
  setTimeout(() => {
    wx.showModal({
      title: '隐私提示',
      content: '为了「常去地点 / 个性化推荐」体验，在你同意后我们才会记录搜索与点店偏好；拒绝也可正常使用全部基础功能。详见「我的 → 隐私中心」。',
      confirmText: '同意',
      cancelText: '暂不',
      success: (r) => {
        if (r.confirm) {
          agree()
        } else {
          reject()
        }
      },
      fail: () => {}
    })
  }, typeof app === 'object' && app && app.__privacyDelay ? app.__privacyDelay : 1200)
}

module.exports = {
  getLocal, hasAgreed, isDecided,
  agree, reject, withdraw,
  fetchPolicy, fetchConsentStatus, exportData, deleteAll,
  ensureFirstRun,
}
