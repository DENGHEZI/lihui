/**
 * 鲤慧 LiHui · 小程序服务端接口封装（与 03-lh-server 对齐）
 */
const { get, post } = require('./request.js')
const { getDeviceId, getPlan, getCareMode } = require('./token.js')

/* ---------------- 位置 ---------------- */
const locateByIp = () => get('/ip/locate')
const reportLocation = (lng, lat, accuracy) => post('/loc/report', { lng, lat, accuracy: accuracy || 50 })

/* ---------------- 地图（服务端中转） ---------------- */
const reverseGeocode = (lng, lat) => get('/map/reverse-geocode', { lng, lat }, { cacheTtl: 10 * 60 * 1000 })
const geocode = (address, city) => get('/map/geocode', { address, city: city || '' }, { cacheTtl: 30 * 60 * 1000 })
const poiSearch = (query, lng, lat, radius) =>
  get('/map/poi/search', { query, lng, lat, radius: radius || 1200, pageSize: 20 }) // 搜索永不缓存，保证实时
const planRoute = ({ mode = 'walking', origin, destination, realtime = false }) =>
  get('/map/route', {
    mode,
    // ⚠️ 百度 direction 系列要求「纬度,经度」，写成经,纬 等于起点终点对调
    origin: `${origin.lat},${origin.lng}`,
    destination: `${destination.lat},${destination.lng}`,
    realtime: realtime ? 'true' : 'false'
  }, { cacheTtl: 2 * 60 * 1000 })
const weather = (lng, lat) => get('/map/weather', { lng, lat }, { cacheTtl: 10 * 60 * 1000 })
const scenicRecommend = (lng, lat, radius) => get('/map/scenic-recommend', { lng, lat, radius: radius || 3000 }, { cacheTtl: 10 * 60 * 1000 })

/* ---------------- 地址补查（用户共创） ----------------
 * 客户发现地址缺失/不准、或地图上没有的地点，一键补报 → 云端留存 → 全员检索自动生效 */
const addrFix = (p) => post('/map/addr-fix', p)
const addrFixList = (q) => get('/map/addr-fix/list', q || {})

/* ---------------- 生活圈 ---------------- */
const lifeReport = (lng, lat, radius) => get('/life/report', { lng, lat, radius: radius || 1200 }, { cacheTtl: 3 * 60 * 1000 })
const customizePlan = (lng, lat, preference) => post('/life/customize', { lng, lat, preference: preference || {} })
// 步行等时圈 + 服务盲区（真实路网批量算路，非直线圆）
const lifeIsochrone = (lng, lat, minutes, grid) => get('/life/isochrone', { lng, lat, minutes: minutes || 15, grid: grid || 5 }, { cacheTtl: 10 * 60 * 1000 })

/* ---------------- 商城 / 订单（选品留痕 + 跳第三方下单） ---------------- */
const shopItems = (q) => get('/shop/items', q || {})
const shopCategories = () => get('/shop/categories')
const shopItem = (id) => get('/shop/item', { id })
const shopHot = () => get('/shop/hot')
// 真实店源：mode=near（按定位 3km 实时拉百度 POI）/ hot（郴州热门）
const shopSource = (mode, lng, lat, extra) => get('/shop/source', Object.assign({ mode, lng, lat }, extra || {}), { cacheTtl: 5 * 60 * 1000 })
const shopSync = (mode, lng, lat, force) => get('/shop/sync', { mode, lng, lat, force }, { cacheTtl: 5 * 60 * 1000 })
const shopSuppliers = () => get('/shop/suppliers')
const shopPrice = (id) => get('/shop/price', { id })
const orderCreate = (p) => post('/order/create', p)
const orderList = (p) => get('/order/list', p || {})
const orderDetail = (no) => get('/order/detail', { no })
const orderStatus = (no, status) => post('/order/status', { no, status })
const orderSync = (orders) => post('/order/sync', { orders })

/* ---------------- Agent ---------------- */
function newSessionId() {
  return 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}
const agentChat = ({ text, sessionId, lng, lat, careMode, plan }) =>
  post('/agent/chat', {
    text,
    sessionId: sessionId || newSessionId(),
    deviceId: getDeviceId(),
    careMode: careMode === undefined ? getCareMode() : careMode,
    plan: plan || getPlan(),
    lng,
    lat
  })
const agentTools = (plan) => get('/agent/tools', { plan: plan || getPlan() })

/* ---------------- 模型 / 语音 ---------------- */
const listModels = (reveal) => get('/model/list', reveal ? { reveal: 'true' } : {})
const saveModel = (m) => post('/model/save', m)
const testModel = (p) => post('/model/test', p)
const setDefaultModel = (id) => post('/model/default', { id })
const removeModel = (id) => post('/model/remove', { id })

const getVoiceConfig = () => get('/voice/config')
const saveVoiceConfig = (cfg) => post('/voice/config', cfg)
const tts = (text, opts) => post('/voice/tts', Object.assign({ text }, opts || {}))

/* ---------------- 反馈 / Token / 动作 ---------------- */
const submitFeedback = (p) => post('/feedback', p)
const tokenStats = (range) => get('/token/stats', { range: range || '7d' })
const openApp = (p) => post('/action/open-app', p)
const desktopOperate = (p) => post('/action/desktop-operate', p)
const publicConfig = () => get('/config/public')

/* ---------------- 语音识别上传 ---------------- */
function uploadAsr(filePath) {
  const config = require('./config.js')
  return new Promise((resolve, reject) => {
    wx.uploadFile({
      url: config.BASE_URL + '/voice/asr',
      filePath,
      name: 'audio',
      header: { 'X-Device-Id': getDeviceId() },
      success: (res) => {
        try {
          const body = JSON.parse(res.data)
          if (body.code === 0 && body.data && body.data.text) resolve(body.data.text)
          else reject(new Error((body.data && body.data.hint) || '未识别到内容'))
        } catch (e) {
          reject(e)
        }
      },
      fail: reject
    })
  })
}

module.exports = {
  locateByIp,
  reportLocation,
  reverseGeocode,
  geocode,
  poiSearch,
  planRoute,
  weather,
  scenicRecommend,
  addrFix,
  addrFixList,
  lifeReport,
  customizePlan,
  lifeIsochrone,
  shopItems,
  shopCategories,
  shopItem,
  shopHot,
  shopSource,
  shopSync,
  shopSuppliers,
  shopPrice,
  orderCreate,
  orderList,
  orderDetail,
  orderStatus,
  orderSync,
  newSessionId,
  agentChat,
  agentTools,
  listModels,
  saveModel,
  testModel,
  setDefaultModel,
  removeModel,
  getVoiceConfig,
  saveVoiceConfig,
  tts,
  submitFeedback,
  tokenStats,
  openApp,
  desktopOperate,
  publicConfig,
  uploadAsr
}
