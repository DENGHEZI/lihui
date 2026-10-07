/**
 * 鲤慧 LiHui · 真实商品目录（百度 POI 实时构建 + 双源）
 *
 * 和 services/shop.js 的区别：
 *  · shop.js 读的是 data/shop.json —— 当初为了先跑通闭环写的【示例目录】（写死的 26 条）
 *  · catalog.js 不写死任何一条数据，运行时调百度 place 检索，
 *    把真实店铺（店名 / uid / 坐标 / 地址 / 电话 / 行政区）拼成目录，落 data/catalog.json
 *
 * 双源：
 *  · near —— 按用户当前坐标实时拉附近（默认 3km），距离、地址全是真的
 *  · hot  —— 本城热门：带坐标时按用户所在城市拉（15km 城市级 + 通用高频词），
 *            GPS 在哪个城市就是那个城市的热门；完全没坐标时才回落郴州词表（比赛主场兜底）
 *
 * 关于价格：百度 place【不给成交价】，价格由 services/supplier.js 去携程/美团拉；
 * 没配 key 时这里只给参考价（前端必须标「参考」角标，别让用户以为那是真实价格）。
 *
 * 缓存：一次同步最多 ~10 次 place 检索，所以结果落盘 + 内存缓存 30 分钟，
 *      避免用户反复切 tab 把百度配额打爆（百度 place 是 QPS 计费的）。
 */
const config = require('../config');
const store = require('./store');
const logger = require('../utils/logger');
const baiduMap = require('./baiduMap');
const supplier = require('./supplier');
const { cache } = require('../utils/cache');

const CATALOG = 'catalog'; // 兼容旧单文件（已弃用读写，仅保留常量）

// ★ near / hot 是两份独立目录，必须分文件存：
//   早先共用 data/catalog.json —— hot tab 一同步就把 near 的 30 条覆盖掉，
//   near 再同步又覆盖回去，来回空烧百度配额，且两个 tab 永远只显示"最近同步的那个"。
const fileOf = (mode) => (mode === 'hot' ? 'catalog-hot' : 'catalog-near');

const CATALOG_TTL = 60 * 60 * 1000; // 落盘缓存 1 小时（百度 place 有【日配额】，别把次数烧在刷新上）
const DEFAULT_RADIUS = 3000;
const HOT_RADIUS = 15000; // 本城热门：城市级检索半径（GPS 在哪个城市就拉哪个城市的热门）

/** 类目 → 展示名 / 单位 / 主供应商 */
const META = {
  hotel: { name: '住宿', icon: '🏨', unit: '晚', platform: 'ctrip', platformName: '携程' },
  ticket: { name: '门票玩乐', icon: '🎫', unit: '张', platform: 'ctrip', platformName: '携程' },
  food: { name: '吃饭喝酒', icon: '🍜', unit: '份', platform: 'meituan', platformName: '美团' },
  service: { name: '本地服务', icon: '🧰', unit: '次', platform: 'meituan', platformName: '美团' },
};

/**
 * 检索关键词表。
 * 每类目最多 2 个词 —— 实测 place/v2/search 一次 5 条、8 次检索刚好够填一屏，
 * 再多就白白烧百度配额了；真想要更多再往上加。
 */
const QUERIES = {
  near: [
    { category: 'hotel', keyword: '酒店' },
    { category: 'hotel', keyword: '民宿' },
    { category: 'ticket', keyword: '公园' },
    { category: 'ticket', keyword: '旅游度假' },
    { category: 'food', keyword: '餐厅' },
    { category: 'food', keyword: '火锅' },
    { category: 'service', keyword: '家政服务' },
    { category: 'service', keyword: '汽车养护' },
  ],
  // hot 两套词表：HOT_CITY 是通用高频词（配合用户坐标=所在城市的热门）；
  // HOT_FALLBACK 是郴州写死词（用户完全没坐标时兜底——比赛主场，保证有数据）。
  hot: [
    { category: 'hotel', keyword: '郴州酒店' },
    { category: 'hotel', keyword: '北湖区酒店' },
    { category: 'ticket', keyword: '东江湖' },
    { category: 'ticket', keyword: '莽山' },
    { category: 'ticket', keyword: '板梁古村' },
    { category: 'food', keyword: '裕后街' },
    { category: 'food', keyword: '郴州米粉' },
    { category: 'service', keyword: '郴州家政' },
  ],
};
// 本城热门：通用词（不带城市前缀，圆心就是用户坐标，百度按坐标周边检索）
const HOT_CITY = [
  { category: 'hotel', keyword: '酒店' },
  { category: 'hotel', keyword: '民宿' },
  { category: 'ticket', keyword: '公园' },
  { category: 'ticket', keyword: '风景区' },
  { category: 'food', keyword: '餐厅' },
  { category: 'food', keyword: '美食' },
  { category: 'service', keyword: '家政服务' },
  { category: 'service', keyword: '汽车养护' },
];

/** 类目兜底：某些 mode 下某类目没命中，用这个补一条通用词 */
function fillMissing(mode, hits) {
  const extra = {
    near: { food: '小吃', service: '体检' },
    hot: { ticket: '公园', food: '小吃' },
  }[mode] || {};
  return Object.keys(extra)
    .filter((c) => !hits[c])
    .map((c) => ({ category: c, keyword: extra[c] }));
}

/** 百度 POI → 鲤慧商品条目（店名/坐标/地址全是真的；价格留给 supplier） */
function mapPoi(r, category) {
  // ⚠️ baiduMap.poiSearch 返回的 items 是【扁平结构】{ uid, name, lng, lat, address, district … }
  //    不是百度的原始 { location: { lng, lat } }。早先这里误写 r.location.lng → NaN → JSON 里变 null，
  //    结果 30 条真实店铺的距离排序、地图打点、跳转导航全部失效（接口不报错，只是 inexplicably 空）。
  const m = META[category] || { name: '其他', icon: '📦', unit: '份', platform: 'ctrip', platformName: '携程' };
  return {
    id: 'b_' + r.uid,
    source: 'baidu',
    poiUid: r.uid,
    name: r.name || '',
    category,
    categoryName: m.name,
    icon: m.icon,
    unit: m.unit,
    // 参考价（第三方没接时的兜底）；真实价走 /shop/price
    price: null,
    originPrice: null,
    priceEstimated: true,
    lng: Number(r.lng),
    lat: Number(r.lat),
    // 兜底：万一上游结构又变了，别默默给 NaN，直接暴露出来
    coordInvalid: !(isFinite(Number(r.lng)) && isFinite(Number(r.lat))),
    address: r.address || '',
    province: r.province || '',
    city: r.city || '',
    district: r.district || '',
    street: r.street || '',
    phone: r.telephone || '',
    // 供应商：用真实店名当关键词，跳过去就能搜到同一家店
    supplier: {
      platform: m.platform,
      platformName: m.platformName,
      keyword: r.name || '',
      appId: m.platform === 'ctrip' ? 'wx0e6ed4f51db9d078' : 'wx2c348cf579062e56',
    },
    tags: [m.name],
    desc: r.address || '',
    active: true,
  };
}

/** 球面距离（米） */
function distanceOf(lng1, lat1, lng2, lat2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

const fmtDist = (d) => (d >= 1000 ? (d / 1000).toFixed(1) + 'km' : d + 'm');

/**
 * 构建 / 读取目录
 * @param {'near'|'hot'} mode
 * @param {object} q { lng, lat, radius, force }
 * @returns {{ items:Array, mode, syncedAt, from:'cache'|'disk'|'baidu' }}
 */
async function build(mode = 'near', q = {}) {
  const key = `catalog:${mode}:${Number(q.lng) || 0},${Number(q.lat) || 0},${q.radius || DEFAULT_RADIUS}`;

  if (!q.force) {
    const mem = cache.get(key);
    if (mem) return { ...mem, from: 'cache' };
  }

  const lngQ = Number(q.lng);
  const latQ = Number(q.lat);
  const disk = store.read(fileOf(mode), null);
  // ★ 磁盘缓存命中前先校验「是不是同一个城市」：hot/near 都按坐标建目录，
  //   单文件目录若不校验，A 城同步的数据会被 B 城用户直接读走（跨城串数据）。
  //   旧数据没有 center 字段则跳过校验（向后兼容）。
  const diskUsable = disk && disk.mode === mode && disk.items && disk.items.length &&
    (!q.force) && (Date.now() - (disk.syncedAt || 0) < CATALOG_TTL);
  const diskSameCity = (() => {
    if (!diskUsable || !disk.center) return diskUsable;
    const dLng = Number(disk.center.lng), dLat = Number(disk.center.lat);
    if (!Number.isFinite(dLng) || !Number.isFinite(dLat) || !Number.isFinite(lngQ) || !Number.isFinite(latQ)) return true;
    // ★ near 目录要跟着人的位置走：圆心漂移超过检索半径的 60% 就重建。
    //   旧版 radius×2=6km 太宽——手机定位漂 3km（GPS 缓存/WiFi 漂移很常见）后，
    //   目录还是老圆心的，用户会看到"漂移点楼下的店全在几十米内"的假距离。
    //   hot（本城热门）是城市级目录，仍按 HOT_RADIUS 宽松处理。
    const th = mode === 'hot' ? HOT_RADIUS : (Number(q.radius) || DEFAULT_RADIUS) * 0.6;
    return distanceOf(lngQ, latQ, dLng, dLat) <= th;
  })();
  if (diskUsable && diskSameCity) {
    cache.set(key, disk, CATALOG_TTL);
    return { ...disk, from: 'disk' };
  }

  const hits = {};
  // hot 有坐标 = 本城热门（城市级半径 + 通用词）；没坐标才用郴州词表兜底（0,0 文本检索）
  const hasLoc = Number.isFinite(lngQ) && Number.isFinite(latQ);
  const withLoc = mode === 'near' || (mode === 'hot' && hasLoc);
  const queries = mode === 'hot' ? (withLoc ? HOT_CITY : QUERIES.hot) : (QUERIES[mode] || QUERIES.near);
  const radius = Number(q.radius) || (mode === 'hot' ? HOT_RADIUS : DEFAULT_RADIUS);
  const lng = withLoc ? lngQ : 0;
  const lat = withLoc ? latQ : 0;

  const ran = queries.concat(fillMissing(mode, hits));
  // ⚠️ 百度 place 是【日配额】计费的（超限直接 302，当天后续全部拿不到数据）。
  //    这里把每次检索的错误收集起来，若命中配额就在返回里明确标出来，
  //    好让前端/用户知道"不是没店，是百度额度用完了"，而不是白屏。
  const quotaHit = { value: false, sample: '' };
  const results = await Promise.all(
    ran.map((x) =>
      baiduMap
        .poiSearch({ query: x.keyword, lng: withLoc ? lng : 0, lat: withLoc ? lat : 0, radius, pageSize: 6 })
        .catch((e) => {
          const msg = String(e && e.message || '');
          if (/配额|超限|302|quota/i.test(msg)) {
            quotaHit.value = true;
            if (!quotaHit.sample) quotaHit.sample = msg;
          }
          return { items: [] };
        })
    )
  );

  const seen = new Set();
  const items = [];
  results.forEach((r, i) => {
    const cat = (ran[i] && ran[i].category) || 'hotel';
    hits[cat] = true;
    (r.items || []).forEach((poi) => {
      if (!poi || !poi.uid || seen.has(poi.uid)) return;
      seen.add(poi.uid);
      items.push(mapPoi(poi, cat));
    });
  });

  // 按类目稳定排序，避免每次刷新顺序乱跳
  const order = ['hotel', 'ticket', 'food', 'service'];
  items.sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category) || a.name.localeCompare(b.name, 'zh'));

  // ⚠️ 配额超限时【禁止用空结果覆盖旧缓存】——
  //    早先这里无脑 store.write，把之前成功拉到的几十条真实店铺直接清成 0 条，
  //    配额挂一小时，商城就空一小时。正确做法：配额挂了就继续用旧目录，只标 quotaHit。
  if (quotaHit.value && !items.length && disk && Array.isArray(disk.items) && disk.items.length) {
    const keep = {
      ...disk,
      quotaHit: true,
      quotaMessage: `百度地图 place 日配额已用尽（${quotaHit.sample}）。暂显示 ${disk.items.length} 条早前同步的真实店铺，明天 0 点后自动刷新。`,
    };
    cache.set(key, keep, 10 * 60 * 1000); // 10 分钟内别再空烧百度
    return { ...keep, from: 'stale' };
  }

  const out = {
    mode,
    // 记录本次目录的检索圆心：下次磁盘命中前用于「是不是同一个城市」校验
    center: withLoc ? { lng, lat } : null,
    syncedAt: Date.now(),
    count: items.length,
    items,
    quotaHit: quotaHit.value,
    quotaMessage: quotaHit.value ? `百度地图 place 日配额已用尽（${quotaHit.sample}）。已返回当前拿到的 ${items.length} 条真实店铺，明天 0 点后自动恢复。` : '',
  };
  try {
    store.write(fileOf(mode), out);
  } catch (e) {
    logger.warn('catalog', `${fileOf(mode)}.json 写入失败（不影响本次返回）：${e.message}`);
  }
  cache.set(key, out, CATALOG_TTL);
  return { ...out, from: 'baidu' };
}

/** 列表：类目 / 关键词过滤 + 距离排序 + 距离文案 */
function list(mode, q = {}) {
  const items = (store.read(fileOf(mode), { items: [] }).items || []).filter((x) => x && x.active !== false && x.id);
  let list = items;
  if (q.category) list = list.filter((x) => x.category === q.category);
  if (q.keyword) {
    const kw = String(q.keyword).trim();
    const hay = (x) => `${x.name}${x.address || ''}${(x.tags || []).join('')}`;
    list = list.filter((x) => hay(x).includes(kw));
  }
  // 真实 POI 条目 price 为 null，端上要显示「参考 ¥XX 起」，所以把估算值一起带过去
  const withEst = list.map((x) => {
    if (Number(x.price) > 0) return x;
    const e = supplier.estimate(x);
    return { ...x, estPrice: e.price, estUnit: e.unit, estOrigin: e.originPrice };
  });

  const hasLoc = isFinite(Number(q.lng)) && isFinite(Number(q.lat));
  if (hasLoc) {
    const lng = Number(q.lng);
    const lat = Number(q.lat);
    return {
      items: withEst
        .map((x) => ({ ...x, distance: distanceOf(lng, lat, Number(x.lng), Number(x.lat)) }))
        .sort((a, b) => (a.distance || 9e9) - (b.distance || 9e9))
        .map((x) => ({ ...x, distText: fmtDist(x.distance) })),
      total: withEst.length,
    };
  }
  return { items: withEst, total: withEst.length };
}

function get(id) {
  // get 不知道条目来自哪个 mode，两边都找（near 优先，条目更多）
  const files = [fileOf('near'), fileOf('hot')];
  for (const f of files) {
    const hit = (store.read(f, { items: [] }).items || []).find((x) => x.id === String(id));
    if (hit) return hit;
  }
  return null;
}

module.exports = { build, list, get, mapPoi, distanceOf, CATALOG, supplierMeta: META, CATALOG_TTL };
