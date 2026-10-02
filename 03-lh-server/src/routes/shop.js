/**
 * 鲤慧 · 商品目录路由（GET，轻量、可缓存）
 */
const { ok, fail } = require('../utils/http');
const shop = require('../services/shop');

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
    const item = shop.get(q.id);
    if (!item) return fail(res, 1004, '商品不存在或已下架');
    return ok(res, item);
  },

  /** GET /api/v1/shop/hot?lng=&lat= —— 首页推荐：距离最近且最便宜的 4 个 */
  'GET /shop/hot': async (req, res, q) => {
    const { items } = shop.list({ ...q, pageSize: 8 })
    return ok(res, { items: items.slice(0, 4) });
  },
};
