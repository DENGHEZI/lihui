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
const { walkMatrixBatch } = require('./isochrone');
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
  market: { name: '便利店超市', icon: '🛒', unit: '件', platform: 'meituan', platformName: '美团' },
};

/**
 * 检索关键词表。
 * 2026-10 覆盖度扩充：每类目 2 词 → 3~5 词（补大学/奶茶/小吃/洗衣/健身等高频生活场景），
 * pageSize 6 → 10。代价是单次同步的 place 检索次数变多（8 → 14 次左右），
 * 但有「结果落盘 1h + 内存缓存 + 去重」三道闸，同步频率不变的前提下配额依然可控。
 */
const QUERIES = {
  near: [
    { category: 'hotel', keyword: '酒店' },
    { category: 'hotel', keyword: '民宿' },
    { category: 'ticket', keyword: '公园' },
    { category: 'ticket', keyword: '风景区' },
    { category: 'ticket', keyword: '广场' },
    { category: 'food', keyword: '餐厅' },
    { category: 'food', keyword: '火锅' },
    { category: 'food', keyword: '奶茶' },
    { category: 'food', keyword: '小吃' },
    { category: 'service', keyword: '家政服务' },
    { category: 'service', keyword: '汽车养护' },
    { category: 'service', keyword: '洗衣店' },
    { category: 'service', keyword: '健身房' },
    // 用户反馈「大学没覆盖」：高校也是 15 分钟生活圈的重要目的地（运动场/食堂/自习室）
    { category: 'service', keyword: '大学' },
    // 2026-10-09 用户反馈补齐：学校食堂 / 零食很忙 等高频生活场景此前未覆盖
    { category: 'food', keyword: '食堂' }, // 学校/园区食堂
    { category: 'food', keyword: '早餐' },
    { category: 'food', keyword: '咖啡' },
    { category: 'service', keyword: '药店' }, // 24h 药急送也是生活圈刚需
    // 新增「便利店超市」类目：零食很忙/便利蜂/超市/水果店 这类零售此前完全缺位
    { category: 'market', keyword: '便利店' },
    { category: 'market', keyword: '超市' },
    { category: 'market', keyword: '零食' }, // 零食很忙、零食有鸣等折扣零食店
    { category: 'market', keyword: '水果店' },
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
  { category: 'ticket', keyword: '广场' },
  { category: 'food', keyword: '餐厅' },
  { category: 'food', keyword: '美食' },
  { category: 'food', keyword: '奶茶' },
  { category: 'food', keyword: '小吃' },
  { category: 'service', keyword: '家政服务' },
  { category: 'service', keyword: '汽车养护' },
  { category: 'service', keyword: '洗衣店' },
  { category: 'service', keyword: '大学' },
  { category: 'market', keyword: '便利店' },
  { category: 'market', keyword: '超市' },
  { category: 'market', keyword: '零食' },
  { category: 'market', keyword: '水果店' },
];

/** 类目兜底：某些 mode 下某类目没命中，用这个补一条通用词 */
function fillMissing(mode, hits) {
  const extra = {
    near: { food: '小吃', service: '体检', market: '便利店' },
    hot: { ticket: '公园', food: '小吃', market: '便利店' },
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
    tags: (() => {
      // 2026-10 详情补全：百度 scope=2 的 detail_info.tag（如「美食:中餐厅」）拆成搜索标签，
      // 用户在商城搜「中餐」「面馆」也能命中 —— 相当于免费的数据补全，不用碰爬虫
      const extra = String(r.tag || '')
        .split(/[:：,，、/\s]+/)
        .filter((t) => t && t.length <= 8)
        .slice(0, 4);
      return [m.name, ...extra];
    })(),
    // ★ scope=2 详情透传：评分（overall_rating）/ 品类标签 / 地址精度标记。
    //   这是「地址/店铺信息不全」的合规解法 —— 用百度已有的 detail 数据补全，
    //   而不是去爬美团（爬取违反robots+用户协议，小程序审核也过不了）。
    rating: Number(r.rating) > 0 ? Number(r.rating) : null,
    poiTag: r.tag || '',
    poiType: r.type || '',
    addressEstimated: !!r.addressEstimated, // true = 行政区级兜底地址（省市区），非门牌
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

/* ---------------- 真实步行距离（批量矩阵算路 + 进程内缓存） ----------------
 * 用户反馈：「商城距离要真实」—— 直线距离（haversine）是鸟飞的，
 * 隔条河/高架/围墙的店直线 300m 实际要走 1.2km。这里复用体检引擎的
 * walkMatrixBatch（百度 routematrix/v2/walking，GCJ-02，isochrone.js 已实测调通），
 * 把「直线最近的前 N 家」升级为真实步行距离 + 步行时长。
 * 配额防线：
 *  · 只实测前 WALK_TOP_N 家（远店本来就用不上）
 *  · (uid + 量化圆心) 缓存 2h，刷新页面/切 tab 不重算
 *  · 矩阵算路与 place 检索配额池独立（isochrone.js 实测），place 超限不影响这里
 */
const WALK_TOP_N = 40;
const WALK_MAX_STRAIGHT = 8000; // 直线 8km 以上就不值得走路了：不实测（跨城旧数据混进来会把整批 routematrix 打成「距离超限」）
const WALK_CHUNK = 20; // 一次 1×20，单批别太大（routematrix 对 destinations 数量有限制）
const WALK_TTL = 2 * 60 * 60 * 1000;
const walkCache = new Map();

const walkKey = (uid, lng, lat) =>
  `${uid}@${Number(lat).toFixed(3)},${Number(lng).toFixed(3)}`; // 圆心量化 ~110m，定位漂一点也算同一次算路

const WALK_SPEED = 80; // m/min，常速步行（与体检引擎盲区口径一致）

async function walkDistances(origin, items) {
  const now = Date.now();
  const out = new Map();
  const need = [];
  for (const it of items) {
    if (!it || !it.poiUid || !isFinite(Number(it.lng)) || !isFinite(Number(it.lat))) continue;
    const k = walkKey(it.poiUid, origin.lng, origin.lat);
    const hit = walkCache.get(k);
    if (hit && now - hit.at < WALK_TTL) out.set(it.poiUid, hit);
    else need.push({ it, k });
  }
  let failed = 0;
  for (let i = 0; i < need.length; i += WALK_CHUNK) {
    const slice = need.slice(i, i + WALK_CHUNK);
    try {
      const arr = await walkMatrixBatch(
        { lat: Number(origin.lat), lng: Number(origin.lng) },
        slice.map((x) => ({ lat: Number(x.it.lat), lng: Number(x.it.lng) }))
      );
      arr.forEach((r, j) => {
        const { it, k } = slice[j];
        if (r && r.distance > 0) {
          const rec = { distance: r.distance, duration: r.duration || 0, at: now };
          walkCache.set(k, rec);
          out.set(it.poiUid, rec);
        } else {
          failed++;
        }
      });
    } catch (e) {
      // 配额熔断（302/401）时整批都拿不到，别逐条重试，直接回落直线距离
      logger.warn('catalog', `步行距离批量算路失败（该批回落直线距离）：${e.message}`);
      failed += slice.length;
      if (e.baiduStatus === 302 || e.baiduStatus === 401) break;
    }
  }
  if (walkCache.size > 4000) walkCache.clear(); // 简易防膨胀（缓存miss重算即可，无伤大雅）
  return { out, realCount: out.size, failed };
}

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

  // ⚠️ 顺序 bug 修复（2026-10）：原来 fillMissing(mode, hits) 在检索前就 concat 进去，
  //    而 hits 那时还是空对象 → 兜底词每次都跑（白烧配额）。改成：先跑主词表，
  //    统计命中类目后，真正缺类目再补一轮兜底词。
  const ran = queries.slice();
  const quotaHit = { value: false, sample: '' };
  const runQueries = (arr) =>
    Promise.all(
      arr.map((x) =>
        baiduMap
          .poiSearch({ query: x.keyword, lng: withLoc ? lng : 0, lat: withLoc ? lat : 0, radius, pageSize: 10 })
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

  let results = await runQueries(ran);

  const seen = new Set();
  const items = [];
  const collect = (rs) => {
    rs.forEach((r, i) => {
      const cat = (ran[i] && ran[i].category) || 'hotel';
      hits[cat] = true;
      (r.items || []).forEach((poi) => {
        if (!poi || !poi.uid || seen.has(poi.uid)) return;
        seen.add(poi.uid);
        items.push(mapPoi(poi, cat));
      });
    });
  };
  collect(results);

  // 某个类目一个都没命中（词太窄/POI 稀疏）才用兜底词补一轮
  const missing = fillMissing(mode, hits);
  if (missing.length && !quotaHit.value) {
    ran.push(...missing);
    collect(await runQueries(missing));
  }

  // 按类目稳定排序，避免每次刷新顺序乱跳
  const order = ['hotel', 'ticket', 'food', 'service', 'market'];
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

/** 列表：类目 / 关键词过滤 + 真实步行距离排序 + 距离文案（async：要批量算路） */
async function list(mode, q = {}) {
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
  if (!hasLoc) return { items: withEst, total: withEst.length };

  const lng = Number(q.lng);
  const lat = Number(q.lat);
  // 直线距离只用来「定谁值得实测」：先按直线排序，取 8km 内前 N 家
  const lined = withEst
    .map((x) => ({ ...x, distance: distanceOf(lng, lat, Number(x.lng), Number(x.lat)) }))
    .sort((a, b) => (a.distance || 9e9) - (b.distance || 9e9));

  const candidates = lined.filter((x) => (x.distance || 9e9) <= WALK_MAX_STRAIGHT).slice(0, WALK_TOP_N);
  const { out: walkMap, realCount } = await walkDistances({ lng, lat }, candidates).catch(
    () => ({ out: new Map(), realCount: 0 })
  );

  const merged = lined.map((x) => {
    const w = walkMap.get(x.poiUid);
    if (!w) return { ...x, distText: fmtDist(x.distance) }; // 没实测到的（远处/算路失败）保持直线距离
    const sec = w.duration && w.duration > 0 ? w.duration : (w.distance / WALK_SPEED) * 60;
    const min = Math.max(1, Math.round(sec / 60));
    return {
      ...x,
      distance: w.distance,
      walkMin: min,
      distanceReal: true, // 端上可据此显示「真实步行」徽章
      distText: `步行 ${fmtDist(w.distance)}·约${min}分钟`,
    };
  });
  // 实测后按步行距离重排：隔河/高架的店直线近走路远，直线序会骗人
  merged.sort((a, b) => (a.distance || 9e9) - (b.distance || 9e9));
  return { items: merged, total: lined.length, walkRealCount: realCount };
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
