/**
 * 鲤慧 · 商品目录服务（内置示例数据 + 距离排序）
 *
 * 定位：用户在这边「选品 → 填单 → 生成订单」，支付与履约交给第三方平台
 * （携程 / 美团小程序），鲤慧不碰资金、不做库存，只做导购与订单留痕。
 */
const store = require('./store');
const logger = require('../utils/logger');

const CATALOG = 'shop';
const CATALOG_FILE = CATALOG; // data/shop.json

const CATEGORIES = [
  { key: 'hotel', name: '住宿', icon: '🏨' },
  { key: 'ticket', name: '门票玩乐', icon: '🎫' },
  { key: 'food', name: '吃饭喝酒', icon: '🍜' },
  { key: 'service', name: '本地服务', icon: '🧰' },
  { key: 'market', name: '便利店超市', icon: '🛒' },
];

let warnedCatalog = false;

function allItems() {
  const raw = store.read(CATALOG_FILE, null);
  const items = raw && Array.isArray(raw.items) ? raw.items : [];
  // ★ 目录读不到时打一条明确的日志：容器里最常见的就是 Dockerfile 漏 COPY data/xxx.json，
  //   此时接口不会报错、只是返回空数组，端上表现为「商品打不开 / 列表空白」，极难自查。
  if (!raw && !warnedCatalog) {
    warnedCatalog = true;
    logger.warn('shop', `未读到 ${CATALOG_FILE}（${store.dataDir}/${CATALOG_FILE}.json），商品列表为空 —— 容器环境请确认 Dockerfile 已 COPY 该文件`);
  }
  return items.filter((x) => x && x.active !== false && x.id);
}

/** 两点球面距离（米） */
function distanceOf(lng1, lat1, lng2, lat2) {
  const R = 6371000
  const toRad = (d) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2)
  return Math.round(2 * R * Math.asin(Math.sqrt(a)))
}

const fmtDist = (d) => (d >= 1000 ? (d / 1000).toFixed(1) + 'km' : d + 'm')

/**
 * 商品列表
 * @param {object} q { category, keyword, lng, lat, sort, page, pageSize }
 */
function list(q = {}) {
  const kw = String(q.keyword || '').trim()
  const cat = String(q.category || '')
  let items = allItems()

  if (cat) items = items.filter((x) => x.category === cat)
  if (kw) {
    const hay = (x) => `${x.name}${x.desc || ''}${(x.tags || []).join('')}${x.supplier && x.supplier.keyword ? x.supplier.keyword : ''}`
    items = items.filter((x) => hay(x).includes(kw))
  }

  // 带坐标时按距离升序，并补上 distance / distText
  const hasLoc = q.lng !== undefined && q.lat !== undefined && isFinite(Number(q.lng)) && isFinite(Number(q.lat))
  if (hasLoc) {
    const lng = Number(q.lng)
    const lat = Number(q.lat)
    items = items.map((x) => {
      const d = x.lng && x.lat ? distanceOf(lng, lat, Number(x.lng), Number(x.lat)) : null
      return { ...x, distance: d, distText: d === null ? '' : fmtDist(d) }
    })
  }

  if (q.sort === 'price' || q.sort === 'priceAsc') {
    items.sort((a, b) => Number(a.price) - Number(b.price))
  } else if (hasLoc) {
    items.sort((a, b) => (a.distance ?? 1e9) - (b.distance ?? 1e9))
  } else {
    items.sort((a, b) => String(b.id).localeCompare(String(a.id)))
  }

  const total = items.length
  const page = Number(q.page) || 1
  const pageSize = Math.min(Number(q.pageSize) || 30, 60)
  return {
    total,
    page,
    pageSize,
    items: items.slice((page - 1) * pageSize, page * pageSize),
  }
}

function get(id) {
  const hit = allItems().find((x) => x.id === String(id))
  if (!hit) return null
  return hit
}

function categories() {
  const items = allItems()
  return CATEGORIES.map((c) => ({
    ...c,
    count: items.filter((x) => x.category === c.key).length,
  }))
}

/** 类目全部 key（供路由校验） */
function categoryKeys() {
  return CATEGORIES.map((c) => c.key)
}

module.exports = { list, get, categories, categoryKeys, distanceOf, CATALOG }
