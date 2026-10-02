/**
 * 鲤慧 · 商品目录路由（GET，轻量、可缓存）
 */
const { ok, fail } = require('../utils/http');
const shop = require('../services/shop');
const catalog = require('../services/catalog');
const supplier = require('../services/supplier');

const ALLOW = shop.categoryKeys();

module.exports = {
  /** GET /api/v1/shop/items?category=&keyword=&lng=&lat=&sort=&page=&pageSize= */
  'GET /shop/items': async (req, res, q) => {
    if (q.category && !ALLOW.includes(q.category)) return fail(res, 1001, 'category 非法')
    return ok(res, shop.list(q))
  },

  /** GET /api/v1/shop/categories —— 类目（带数量） */
  'GET /shop/categories': async (req, res) => ok(res, { items: shop.categories() }),

  /** GET /api/v1/shop/item?id=hotel-wlg-001 */
  'GET /shop/item': async (req, res, q) => {
    if (!q.id) return fail(res, 1001, 'id 必填');
    // 两类商品：b_ 开头是百度实时构建的真实 POI，其余是 data/shop.json 里的示例目录
    const item = q.id.startsWith('b_') ? catalog.get(q.id) : shop.get(q.id);
    if (!item) return fail(res, 1004, '商品不存在或已下架');
    return ok(res, item);
  },

  /** GET /api/v1/shop/hot?lng=&lat= —— 首页推荐：距离最近且最便宜的 4 个 */
  'GET /shop/hot': async (req, res, q) => {
    const { items } = shop.list({ ...q, pageSize: 8 })
    return ok(res, { items: items.slice(0, 4) });
  },

  // ---------------- 真实数据（百度 POI + 可插拔供应商价格） ----------------

  /** GET /api/v1/shop/sync?mode=near|hot&lng=&lat=&radius=&force=1 —— 拉真实店铺目录 */
  'GET /shop/sync': async (req, res, q) => {
    const mode = q.mode === 'hot' ? 'hot' : 'near';
    if (mode === 'near' && (!Number.isFinite(Number(q.lng)) || !Number.isFinite(Number(q.lat)))) {
      return fail(res, 1001, '附近模式必须带 lng/lat（百度要拿它当检索圆心）');
    }
    try {
      const d = await catalog.build(mode, { lng: q.lng, lat: q.lat, radius: q.radius, force: q.force === '1' });
      return ok(res, { mode: d.mode, syncedAt: d.syncedAt, from: d.from, count: d.items.length, items: d.items });
    } catch (e) {
      return fail(res, 5000, '真实店源同步失败：' + (e.message || ''));
    }
  },

  /** GET /api/v1/shop/source?mode=near|hot&lng=&lat= —— 只取列表，不强制重建（末端用，省配额） */
  'GET /shop/source': async (req, res, q) => {
    const mode = q.mode === 'hot' ? 'hot' : 'near';
    try {
      const built = await catalog.build(mode, { lng: q.lng, lat: q.lat, radius: q.radius });
      const list = catalog.list(mode, q);
      return ok(res, { mode, from: built.from, syncedAt: built.syncedAt, ...list });
    } catch (e) {
      return fail(res, 5000, e.message || '真实店源读取失败');
    }
  },

  /** GET /api/v1/shop/price?id=b_xxx —— 拉真实价；没配供应商 key 时回参考价 */
  'GET /shop/price': async (req, res, q) => {
    if (!q.id) return fail(res, 1001, 'id 必填');
    const item = catalog.get(q.id) || shop.get(q.id);
    if (!item) return fail(res, 1004, '商品不存在');
    const p = await supplier.priceOf(item);
    return ok(res, { id: item.id, name: item.name, ...p });
  },

  /** GET /api/v1/shop/suppliers —— 各渠道真实价格接口接入状态（前端用来显示"已接/未接"） */
  'GET /shop/suppliers': async (req, res) => ok(res, { items: supplier.status() }),
};
