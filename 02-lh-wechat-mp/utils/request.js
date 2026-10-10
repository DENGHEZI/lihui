/**
 * 鲤慧 LiHui · 微信小程序请求封装
 *
 * 性能设计：
 *  - GET 二级缓存：内存 Map（会话内）+ wx.storage（冷启动仍命中）
 *  - 坐标量化到 3 位小数（~100m）作为缓存键，避免 GPS 抖动导致缓存失效
 *  - 仅业务性只读数据缓存（天气/推荐/体检报告），搜索与对话永远实时
 */
const config = require('./config.js')
const { getDeviceId, getPlan, getAuthToken } = require('./token.js')

let lastTokenCost = 0

/* ---------------- 二级缓存 ---------------- */
const MEM_MAX = 30 // 内存缓存条目上限
const CACHE_PREFIX = 'lh_cache_'
const memCache = new Map() // key -> { data, expire }

function quantKeyVal(k, v) {
  // 坐标量化，其余原样
  if ((k === 'lng' || k === 'lat') && isFinite(Number(v))) return Number(v).toFixed(3)
  return String(v)
}

function buildKey(path, data) {
  return path + '?' + Object.keys(data || {})
    .sort()
    .map((k) => k + '=' + quantKeyVal(k, data[k]))
    .join('&')
}

function cacheGet(key) {
  const now = Date.now()
  const m = memCache.get(key)
  if (m && m.expire > now) return m.data
  if (m) memCache.delete(key)
  try {
    const s = wx.getStorageSync(CACHE_PREFIX + key)
    if (s && s.expire > now) {
      // 冷启动回填内存层
      if (memCache.size >= MEM_MAX) memCache.delete(memCache.keys().next().value)
      memCache.set(key, s)
      return s.data
    }
    if (s) wx.removeStorageSync(CACHE_PREFIX + key)
  } catch (e) {}
  return undefined
}

function cacheSet(key, data, ttl) {
  const entry = { data, expire: Date.now() + ttl }
  if (memCache.size >= MEM_MAX) memCache.delete(memCache.keys().next().value)
  memCache.set(key, entry)
  try { wx.setStorageSync(CACHE_PREFIX + key, entry) } catch (e) {}
}

/** 清空业务缓存（保留 deviceId / plan / careMode / 语音配置） */
function clearBizCache() {
  memCache.clear()
  try {
    const info = wx.getStorageInfoSync()
    ;(info.keys || []).filter((k) => k.indexOf(CACHE_PREFIX) === 0).forEach((k) => wx.removeStorageSync(k))
  } catch (e) {}
}

/** 当前缓存占用（KB） */
function getCacheSizeKB() {
  try { return wx.getStorageInfoSync().currentSize || 0 } catch (e) { return 0 }
}

/* ---------------- 网络错误人话化 ----------------
 * wx.request 的 fail(err) 只给一句 errMsg，原来统一弹「网络异常，请确认服务端已启动」，
 * 把真正原因（最常见的「域名不在白名单」）全吞了。这里精确识别并给出可行动提示。
 */
function networkHint(err) {
  const m = String((err && err.errMsg) || '请求失败')
  if (/not in domain list/i.test(m)) return '域名未加入小程序白名单'
  if (/timeout/i.test(m)) return '请求超时，稍后再试'
  if (/ssl|https|certificate/i.test(m)) return 'HTTPS/证书校验失败'
  if (/fail url|url not|domain/i.test(m)) return '请求地址被微信拦截'
  return m.length > 22 ? m.slice(0, 22) + '…' : m
}

/* ---------------- 微信云托管内网通道 ----------------
 * 走 wx.cloud.callContainer 时请求由微信内部转发到自己的云托管服务，
 * 不经过「request 合法域名」校验，因此真机/体验版/正式版都不需要备案域名。
 * 由 config.USE_CLOUD_CONTAINER + config.CLOUD_ENV_ID 控制，默认关闭。
 */
const API_PREFIX = '/api/v1'
let cloudInited = false

function canUseCloudContainer() {
  if (!config.USE_CLOUD_CONTAINER || !config.CLOUD_ENV_ID) return false
  if (!wx.cloud || !wx.cloud.callContainer) {
    console.warn('[鲤慧] 基础库不支持 wx.cloud.callContainer，回退 wx.request')
    return false
  }
  if (!cloudInited) {
    try {
      wx.cloud.init({ env: config.CLOUD_ENV_ID, traceUser: true })
      cloudInited = true
    } catch (e) {
      console.error('[鲤慧] wx.cloud.init 失败，回退 wx.request', e)
      return false
    }
  }
  return true
}

/* ---------------- 请求 ---------------- */
function request(path, { method = 'GET', data = {}, loading = false, loadingText = '加载中', cacheTtl = 0, silent = false, timeout = 20000 } = {}) {
  // 命中缓存直接返回（零网络、零等待）
  let cacheKey = ''
  if (method === 'GET' && cacheTtl > 0) {
    cacheKey = buildKey(path, data)
    const hit = cacheGet(cacheKey)
    if (hit !== undefined) return Promise.resolve(hit)
  }

  if (loading) wx.showLoading({ title: loadingText, mask: true })
  return new Promise((resolve, reject) => {
    const header = {
      'Content-Type': 'application/json',
      'X-Device-Id': getDeviceId(),
      'X-Plan': getPlan()
    }
    // 已登录则带 RBAC 令牌（/auth/me、/auth/profile 等需要；401 时端上自己处理）
    const authToken = getAuthToken()
    if (authToken) header.Authorization = 'Bearer ' + authToken
    const onSuccess = (res) => {
      const body = res.data || {}
      if (body.code === 0) {
        lastTokenCost = Number((res.header && res.header['X-Token-Cost']) || (res.header && res.header['x-token-cost'])) || 0
        // 2026-10-10：空列表不写缓存 —— 限流窗口期端上缓存了「0 个店」，服务端恢复后手机还要再空 5 分钟
        if (cacheKey && !(body.data && Array.isArray(body.data.items) && body.data.items.length === 0)) {
          cacheSet(cacheKey, body.data, cacheTtl)
        }
        resolve(body.data)
        return
      }
      if (body.code === 1003) {
        if (!silent) wx.showModal({ title: '额度用尽', content: body.msg || '今日 Token 配额已用完', showCancel: false })
      } else if (body.code === 3002) {
        if (silent) { reject(body); return }
        wx.showModal({
          title: '还没有可用模型',
          content: '请先到「我的 → 模型与语音设置」添加一个模型',
          confirmText: '去设置',
          success: (r) => {
            if (r.confirm) wx.navigateTo({ url: '/pages/settings/settings' })
          }
        })
      } else if (!silent) {
        wx.showToast({ title: body.msg || '请求失败', icon: 'none', duration: 2200 })
      }
      reject(body)
    }
    const onFail = (err) => {
      if (!silent) wx.showToast({ title: networkHint(err), icon: 'none', duration: 3000 })
      reject(err)
    }
    const onComplete = () => {
      if (loading) wx.hideLoading()
    }

    // ① 优先走微信云托管内网通道：不受 request 合法域名限制
    //    ⚠️ 客户反馈「首页全没有变化 + HTTPS/证书校验失败」：
    //    以前 callContainer 一失败就直接 reject，整个数据链路全断且无回落。
    //    现在失败时自动降级走一次 wx.request（staging/局域网域名），并把真实原因打到 console。
    if (canUseCloudContainer()) {
      wx.cloud.callContainer({
        config: { env: config.CLOUD_ENV_ID },
        path: API_PREFIX + path,
        method,
        data,
        header: Object.assign({ 'X-WX-SERVICE': config.CLOUD_SERVICE }, header),
        success: onSuccess,
        fail: (err) => {
          console.warn('[鲤慧-网络] callContainer 失败，降级 wx.request：', path, err && err.errMsg)
          if (config.BASE_URL) {
            wx.request({
              url: config.BASE_URL + path,
              method,
              data,
              timeout,
              header,
              success: onSuccess,
              fail: onFail,
              complete: onComplete // 降级结束后才收 loading
            })
          } else {
            onComplete()
            onFail(err)
          }
        },
        complete: () => {} // 外层不收 loading，交给降级通道或 onSuccess 内部逻辑
      })
      return
    }

    // ② 常规 HTTP：需把域名加入小程序后台「request 合法域名」
    wx.request({
      url: config.BASE_URL + path,
      method,
      data,
      timeout,
      header,
      success: onSuccess,
      fail: onFail,
      complete: onComplete
    })
  })
}

const get = (path, data, opts) => {
  const o = Object.assign({ method: 'GET', data }, opts || {})
  return request(path, o).catch((err) => {
    // 2026-10-10：GET 网络级失败（无业务 code）自动静默重试 1 次 —— 瞬时抖动不再让端上白屏/空列表
    if (err && err.code === undefined && !o._retried) {
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          request(path, Object.assign({}, o, { silent: true, _retried: true })).then(resolve, reject)
        }, 900)
      })
    }
    throw err
  })
}
const post = (path, data, opts) => request(path, Object.assign({ method: 'POST', data }, opts || {}))

/** 按前缀清业务缓存（下拉刷新用：只清一类，不动 deviceId/plan 等存储） */
function clearCachePrefix(prefix) {
  const drop = []
  memCache.forEach((v, k) => { if (k.indexOf(prefix) === 0) drop.push(k) })
  drop.forEach((k) => memCache.delete(k))
  try {
    const info = wx.getStorageInfoSync()
    ;(info.keys || []).filter((k) => k.indexOf(CACHE_PREFIX) === 0 && k.indexOf(prefix) !== -1)
      .forEach((k) => wx.removeStorageSync(k))
  } catch (e) {}
}

module.exports = { request, get, post, getLastTokenCost: () => lastTokenCost, clearBizCache, clearCachePrefix, getCacheSizeKB }
