/**
 * 鲤慧 LiHui · 15 分钟生活圈体检路由
 * 通过 MCP Hub 调起 life-circle MCP Server；失败时服务端本地兜底计算。
 */
const { ok, fail } = require('../utils/http');
const hub = require('../mcp/hub');
const baiduMap = require('../services/baiduMap');
const logger = require('../utils/logger');

const CATEGORIES = [
  { key: 'medical', name: '医疗', weight: 0.25, keywords: ['医院', '社区卫生服务中心', '药店'], need: 2 },
  { key: 'education', name: '教育', weight: 0.15, keywords: ['幼儿园', '小学', '中学'], need: 1 },
  { key: 'market', name: '商业', weight: 0.2, keywords: ['超市', '菜市场', '便利店'], need: 2 },
  { key: 'food', name: '餐饮', weight: 0.1, keywords: ['餐厅', '早餐店'], need: 3 },
  { key: 'transit', name: '交通', weight: 0.2, keywords: ['公交站', '地铁站', '停车场'], need: 1 },
  { key: 'leisure', name: '休闲', weight: 0.1, keywords: ['公园', '健身', '体育'], need: 1 },
];

function numOr(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/** 服务端本地兜底计算（不依赖 MCP） */
async function localDiagnose({ lng, lat, radius = 1200 }) {
  const cats = await Promise.all(
    CATEGORIES.map(async (c) => {
      let items = [];
      try {
        const r = await baiduMap.poiSearch({ query: c.keywords.join('|'), lng, lat, radius, pageSize: 20 });
        items = r.items || [];
      } catch (_) {}
      const hitTypes = c.keywords.filter((k) => items.some((i) => (i.name + i.tag + i.type).includes(k)));
      const ratio = Math.min(1, items.length / Math.max(c.need, 1));
      const typeRatio = hitTypes.length / c.keywords.length;
      const score = Math.round((ratio * 0.6 + typeRatio * 0.4) * 100);
      return {
        key: c.key,
        name: c.name,
        weight: c.weight,
        score,
        count: items.length,
        types: hitTypes,
        nearest: items[0] ? { name: items[0].name, distance: items[0].distance } : null,
        samples: items.slice(0, 5).map((i) => ({ name: i.name, distance: i.distance, address: i.address })),
      };
    })
  );

  const score = Math.round(cats.reduce((a, b) => a + b.score * b.weight, 0));
  const level = score >= 85 ? '优秀' : score >= 60 ? '良好' : score >= 40 ? '一般' : '较差';
  const shortboards = cats.filter((c) => c.score < 60).map((c) => `${c.name}：15 分钟步行可达 ${c.count} 处，达标线 ${CATEGORIES.find((x) => x.key === c.key).need} 类`);
  const suggestions = shortboards.map((s) => {
    const name = s.split('：')[0];
    return `${name}是短板，建议沿主干道方向步行扩大搜索半径，或考虑使用共享单车将出行半径扩展到 3 公里。`;
  });

  return {
    score,
    level,
    center: { lng: Number(lng), lat: Number(lat) },
    radius,
    categories: cats,
    shortboards,
    suggestions,
    engine: 'server-local',
  };
}

module.exports = {
  /** GET /api/v1/life/report?lng=&lat=&radius= */
  'GET /life/report': async (req, res, q) => {
    const lng = numOr(q.lng, NaN);
    const lat = numOr(q.lat, NaN);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return fail(res, 1001, 'lng/lat 必填');
    const radius = numOr(q.radius, 1200);
    try {
      const r = await hub.callByQualifiedName('life-circle__diagnose', { lng, lat, radius });
      const data = (r.data && (r.data.result || r.data)) || null;
      if (data) return ok(res, data);
      throw new Error('empty mcp result');
    } catch (e) {
      logger.warn('life', `mcp diagnose failed, fallback local: ${e.message}`);
      return ok(res, await localDiagnose({ lng, lat, radius }));
    }
  },

  /** POST /api/v1/life/customize */
  'POST /life/customize': async (req, res, q, body) => {
    const lng = numOr((body || {}).lng, NaN);
    const lat = numOr((body || {}).lat, NaN);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return fail(res, 1001, 'lng/lat 必填');
    try {
      const r = await hub.callByQualifiedName('life-circle__customize_plan', {
        lng,
        lat,
        preference: (body && body.preference) || {},
      });
      const data = (r.data && (r.data.result || r.data)) || null;
      if (data) return ok(res, data);
      throw new Error('empty');
    } catch (e) {
      // 兜底：先体检，再按偏好给方案
      const report = await localDiagnose({ lng, lat, radius: 1200 });
      const pref = (body && body.preference) || {};
      return ok(res, {
        ...report,
        plan: [
          `每日动线建议：${report.categories.find((c) => c.key === 'market' && c.nearest) ? '先到菜市场（' + report.categories.find((c) => c.key === 'market').nearest.name + '）' : '先解决买菜点'}，再顺路处理其他需求。`,
          pref.withElderly ? '考虑到有老人：优先选择有电梯、有休息座椅的场所，单次步行不超过 15 分钟。' : '可根据体力选择共享单车扩展半径到 3 公里。',
          `预算建议：单日生活出行成本控制在 ¥${pref.budget === 'low' ? 10 : 25} 以内。`,
        ],
      });
    }
  },
};
