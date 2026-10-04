/**
 * 鲤慧 LiHui · 15 分钟生活圈体检路由
 * 通过 MCP Hub 调起 life-circle MCP Server；失败时服务端本地兜底计算。
 * 六类口径 / 配额熔断 / 单类检索抽至 services/lifeShared.js（与等时圈引擎共享）。
 */
const { ok, fail } = require('../utils/http');
const hub = require('../mcp/hub');
const logger = require('../utils/logger');
const { CATEGORIES, isQuotaBlocked, noteQuotaError, fetchCategory } = require('../services/lifeShared');
const { buildIsochrone } = require('../services/isochrone');

function numOr(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/** 限时执行：防止外部调用挂起拖垮整个体检 */
function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise.catch(() => fallback),
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

/** 服务端本地兜底计算（不依赖 MCP；六类互相隔离，单类故障不拖垮总分） */
async function localDiagnose({ lng, lat, radius = 1200 }) {
  const cats = await Promise.all(
    CATEGORIES.map(async (c, i) => {
      const { items, failed } = await fetchCategory(c, lng, lat, radius, i * 200);
      const hitTypes = c.keywords.filter((k) => items.some((i) => (i.name + i.tag + i.type).includes(k)));
      // 检索失败的类不参与计分（区别于"确实没有"），避免偶发网络错误把总分拉穿
      const ratio = failed ? null : Math.min(1, items.length / Math.max(c.need, 1));
      const typeRatio = failed ? null : hitTypes.length / c.keywords.length;
      const score = failed ? null : Math.round((ratio * 0.6 + typeRatio * 0.4) * 100);
      return {
        key: c.key,
        name: c.name,
        weight: c.weight,
        need: c.need,
        score,
        count: items.length,
        failed,
        types: hitTypes,
        nearest: items[0] ? { name: items[0].name, distance: items[0].distance } : null,
        samples: items.slice(0, 5).map((i) => ({ name: i.name, distance: i.distance, address: i.address })),
      };
    })
  );

  // 只用"成功检索"的类做加权（权重归一化），杜绝偶发故障导致的评分跳水
  const valid = cats.filter((c) => c.score !== null);
  const weightSum = valid.reduce((a, b) => a + b.weight, 0) || 1;
  const score = Math.round(valid.reduce((a, b) => a + b.score * (b.weight / weightSum), 0));
  const level = score >= 85 ? '优秀' : score >= 60 ? '良好' : score >= 40 ? '一般' : '较差';
  const shortboards = valid
    .filter((c) => c.score < 60)
    .map((c) => `${c.name}：15 分钟步行可达 ${c.count} 处，达标线 ${c.need} 类`);
  const suggestions = shortboards.map((s) => {
    const name = s.split('：')[0];
    return `${name}是短板，建议沿主干道方向步行扩大搜索半径，或考虑使用共享单车将出行半径扩展到 3 公里。`;
  });

  return {
    score,
    level,
    center: { lng: Number(lng), lat: Number(lat) },
    radius,
    // 预计步行可达分钟：radius ÷ 步速 80m/min ÷ 路网弯曲 1.3，四舍五入。
    // 端上「预计步行 X 分钟可达」直接用它（之前端上读了个不存在的字段，显示为空）
    walkMinutes: Math.round(Number(radius) / 80 / 1.3),
    categories: cats,
    shortboards,
    suggestions,
    degraded: cats.some((c) => c.failed),
    engine: 'server-local',
    quotaExhausted: isQuotaBlocked() && cats.every((c) => c.failed),
    hint: isQuotaBlocked() && cats.every((c) => c.failed)
      ? '今日百度地图检索配额已用完（每日 0 点自动恢复）。本次仅展示部分结果，建议在百度地图开放平台完成个人认证以提升免费配额。'
      : undefined,
  };
}

module.exports = {
  /** GET /api/v1/life/report?lng=&lat=&radius= */
  'GET /life/report': async (req, res, q) => {
    const lng = numOr(q.lng, NaN);
    const lat = numOr(q.lat, NaN);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return fail(res, 1001, 'lng/lat 必填');
    const radius = numOr(q.radius, 1200);
    // 配额熔断期间跳过 MCP（否则每个报告仍会对百度空打几十次请求）
    if (!isQuotaBlocked()) {
      try {
        // MCP 体检限时 8s；返回结果做质量校验（>=4 类空检索视为可疑，回落本地引擎）
        const r = await withTimeout(hub.callByQualifiedName('life-circle__diagnose', { lng, lat, radius }), 8000, null);
        const data = r && r.data && (r.data.result || r.data);
        const suspicious = data && Array.isArray(data.categories) && data.categories.filter((c) => !c.count).length >= 4;
        if (data && !suspicious) return ok(res, data);
        if (data && suspicious) logger.warn('life', 'mcp result suspicious (>=4 empty categories), fallback local');
        throw new Error(suspicious ? 'suspicious mcp result' : 'empty mcp result');
      } catch (e) {
        logger.warn('life', `mcp diagnose failed, fallback local: ${e.message}`);
      }
    }
    try {
      return ok(res, await localDiagnose({ lng, lat, radius }));
    } catch (e2) {
      logger.error('life', `local diagnose failed: ${e2.message}`);
      return fail(res, 5003, '体检引擎繁忙，请稍后再试');
    }
  },

  /** GET /api/v1/life/isochrone?lng=&lat=&minutes=15&grid=5
   *  步行等时圈 + 六类覆盖 + 服务盲区（命题一核心能力：真实路网而非直线圆）。
   *  降级链内建：批量矩阵 → 并发单点算路 → 理想圆（engine 字段显式标注）。 */
  'GET /life/isochrone': async (req, res, q) => {
    const lng = numOr(q.lng, NaN);
    const lat = numOr(q.lat, NaN);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return fail(res, 1001, 'lng/lat 必填');
    try {
      const data = await buildIsochrone({
        lng,
        lat,
        minutes: numOr(q.minutes, 15),
        grid: numOr(q.grid, 5),
      });
      return ok(res, data);
    } catch (e) {
      logger.error('life', `isochrone failed: ${e.message}`);
      return fail(res, 5004, '等时圈计算失败，请稍后再试');
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
      // 兜底：先体检，再按偏好给方案（半径对齐 15 分钟赛题口径，与端上默认一致）
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
