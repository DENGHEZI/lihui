/**
 * 鲤慧 · 订单服务
 *
 * 分工（重要）：鲤慧只做「选品 + 留痕 + 跳转」，资金与履约在第三方平台完成。
 * 订单状态流：pending（已下单，待去第三方支付）→ paid（用户回执已付）→ done / cancelled
 */
const shop = require('./shop');
const catalog = require('./catalog');
// ⚠️ 别叫 supplier：create() 里已经有个同名的【商品供应商信息】局部变量（item.supplier），
//    同名会让第 41 行在 TDZ（暂时性死区）里引用到未初始化的常量 →
//    "Cannot access 'supplier' before initialization"，且只在【真实 POI 走参考价】这条分支才触发，
//    用示例商品（price>0）测是测不出来的。所以这里起个别名 priceService。
const priceService = require('./supplier');
const store = require('./store');

const col = store.collection('orders', [])

const STATUS = {
  pending: '待支付',
  paid: '已下单',
  done: '已完成',
  cancelled: '已取消',
}

/** 订单号：LH + yyyymmdd + 6 位随机 */
function makeNo() {
  const d = new Date()
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase()
  return `LH${ymd}${rand}`
}

/**
 * 创建订单
 * @param {object} o { deviceId, itemId, spec, qty, date, name, phone, remark, lng, lat }
 */
async function create(o = {}) {
  // 目录可能来自两处：示例目录（shop.json）或百度实时构建的真实 POI（catalog.json）
  const catalogHit = String(o.itemId || '').startsWith('b_') ? catalog.get(o.itemId) : null
  const item = catalogHit || shop.get(o.itemId)
  if (!item) throw Object.assign(new Error('商品不存在或已下架'), { code: 1001 })

  const qty = Math.max(1, Math.min(Number(o.qty) || 1, 99))
  // 真实 POI 条目 price 为 null（百度不给成交价），用参考价兜底，前端必须让用户看到这是参考价
  const unitPrice = Number(item.price) > 0 ? Number(item.price) : priceService.estimate(item).price
  const amount = unitPrice * qty

  // 第三方下单信息：端上直接拿来跳小程序 / 复制关键词
  const supplier = item.supplier || {}
  let distance = null
  if (o.lng !== undefined && o.lat !== undefined && item.lng && item.lat) {
    distance = shop.distanceOf(Number(o.lng), Number(o.lat), Number(item.lng), Number(item.lat))
  }

  const now = new Date().toISOString()
  const order = {
    no: makeNo(),
    deviceId: o.deviceId || store.uid('dev'),
    itemId: item.id,
    itemName: item.name,
    itemIcon: item.icon || '🛒',
    category: item.category || '',
    spec: o.spec || (item.specs && item.specs[0]) || '',
    qty,
    unit: item.unit || '份',
    price: unitPrice,
    amount,
    date: o.date || '',
    name: o.name || '',
    phone: o.phone || '',
    remark: o.remark || '',
    supplier: {
      platform: supplier.platform || '',
      platformName: supplier.platformName || '',
      appId: supplier.appId || '',
      keyword: supplier.keyword || item.name,
      url: supplierUrl(supplier, item),
    },
    lng: item.lng || undefined,
    lat: item.lat || undefined,
    distance,
    status: 'pending',
    source: 'miniapp',
    createdAt: now,
    updatedAt: now,
  }
  return col.add(order)
}

/** 生成第三方平台的 H5 搜索/商品链接（跳小程序失败时复制到浏览器打开） */
function supplierUrl(supplier, item) {
  const kw = encodeURIComponent((supplier.keyword || item.name || '').trim())
  if (supplier.platform === 'ctrip') {
    return `https://m.ctrip.com/webapp/hotel/hotellist/?city=${encodeURIComponent('郴州')}&keyword=${kw}`
  }
  if (supplier.platform === 'meituan') return `https://i.meituan.com/s/${kw}`
  if (supplier.platform === 'fliggy') return `https://m.fliggy.com/search?q=${kw}`
  return ''
}

function listByDevice(deviceId, q = {}) {
  if (!deviceId) return { total: 0, page: 1, pageSize: 20, items: [] }
  let list = col.all().filter((x) => x.deviceId === deviceId)
  if (q.status) list = list.filter((x) => x.status === q.status)
  list = list.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  const page = Number(q.page) || 1
  const pageSize = Math.min(Number(q.pageSize) || 20, 50)
  return { total: list.length, page, pageSize, items: list.slice((page - 1) * pageSize, page * pageSize) }
}

function get(no) {
  return col.find((x) => x.no === String(no)) || null
}

function updateStatus(no, status) {
  if (!STATUS[status]) throw Object.assign(new Error('非法状态'), { code: 1001 })
  const hit = col.all().find((x) => x.no === String(no))
  if (!hit) return null
  if (hit.status === 'cancelled' && status !== 'cancelled') return null // 取消后不可回滚
  return col.update(hit.id, { status, updatedAt: new Date().toISOString() })
}

/** 端上本地订单同步：以 no 为准做插入/更新（保证离线也能看到） */
function upsertFromClient(list) {
  if (!Array.isArray(list) || !list.length) return { synced: 0 }
  let synced = 0
  for (const it of list) {
    if (!it || !it.no) continue
    const exist = col.find((x) => x.no === it.no)
    if (exist) continue
    col.add({
      ...it,
      no: it.no,
      deviceId: it.deviceId || 'client',
      source: it.source === 'miniapp' ? 'miniapp' : 'client',
      createdAt: it.createdAt || new Date().toISOString(),
      updatedAt: it.updatedAt || it.createdAt || new Date().toISOString(),
    })
    synced += 1
  }
  return { synced }
}

module.exports = { create, listByDevice, get, updateStatus, upsertFromClient, STATUS, makeNo }
