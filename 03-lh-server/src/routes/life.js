/**
 * 鲤慧 LiHui · 15 分钟生活圈体检路由
 * 通过 MCP Hub 调起 life-circle MCP Server；失败时服务端本地兜底计算。
 * 七类口径 / 配额熔断 / 单类检索抽至 services/lifeShared.js（与等时圈引擎共享）。
 */
const { ok, fail } = require('../utils/http');
const hub = require('../mcp/hub');
const logger = require('../utils/logger');
const { CATEGORIES, isQuotaBlocked, noteQuotaError, fetchCategory, scoreCategory, scoreSummary, suggestionFor, catStagger } = require('../services/lifeShared');
const { buildIsochrone } = require('../services/isochrone');
const standards = require('../services/standards');

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

/** 服务端本地兜底计算（不依赖 MCP；七类互相隔离，单类故障不拖垮总分）
 *  2026-10-10 评分修复：
 *  - POI 去重计数（scoreCategory 内统一 dedupePOIs，同 uid/同名同址合并，count 不再虚高）
 *  - 真实权重：city 命中 standards 库中的城市规范且带 categoryWeights 时按标准权重计分
 *    （来源标注在 weightSource / weightNote；未命中回落内置默认口径） */
async function localDiagnose({ lng, lat, radius = 1200, city = '' }) {
  /* 真实权重：按城市匹配适用规范；categoryWeights 键 = 七类 key */
  let weightMap = null;
  let weightSource = '内置默认口径';
  let weightNote = '';
  try {
    const std = standards.resolve(city);
    const cw = std && std.standard && std.standard.metrics && std.standard.metrics.categoryWeights;
    if (cw && typeof cw === 'object') {
      const complete = CATEGORIES.every((c) => Number.isFinite(Number(cw[c.key])));
      if (complete) {
        weightMap = {};
        CATEGORIES.forEach((c) => { weightMap[c.key] = Number(cw[c.key]); });
        weightSource = std.standard.name;
        weightNote = std.standard.metrics.categoryWeights.note || '';
      }
    }
  } catch (e) {
    logger.warn('life', `standards weight resolve failed: ${e.message}`);
  }

  const cats = await Promise.all(
    CATEGORIES.map(async (c, i) => {
      const { items, failed } = await fetchCategory(c, lng, lat, radius, catStagger(i));
      // 检索失败的类不参与计分（区别于"确实没有"），避免偶发网络错误把总分拉穿
      const { hitTypes, score, count } = scoreCategory(c, items, failed);
      return {
        key: c.key,
        name: c.name,
        weight: weightMap ? weightMap[c.key] : c.weight,
        need: c.need,
        score,
        count,
        failed,
        types: hitTypes,
        nearest: items[0] ? { name: items[0].name, distance: items[0].distance } : null,
        samples: (items || []).slice(0, 5).map((i) => ({ name: i.name, distance: i.distance, address: i.address })),
      };
    })
  );

  // 只用"成功检索"的类做加权（权重归一化），杜绝偶发故障导致的评分跳水
  const { score, level, shortboards } = scoreSummary(cats);
  // V1.0.32：短板解决方案 —— 按类定制（现状 + 最近设施步行分钟 + 替代方案/反馈渠道/生活技巧），
  // 替换原先千篇一律的模板话术；agent 兜底回复与端上 tip-row 同步受益
  const suggestions = cats
    .filter((c) => c.score !== null && c.score !== undefined && c.score < 60)
    .flatMap((c) => suggestionFor(c));

  return {
    score,
    level,
    center: { lng: Number(lng), lat: Number(lat) },
    radius,
    // 评分权重来源（真实权重口径）：城市规范命中时为规范全名，否则为内置默认口径
    weightSource,
    weightNote: weightNote || undefined,
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
      ? '百度检索限流中（QPS 超限或配额紧张），稍后会自动恢复重试；等时圈算路不受影响。可在百度地图开放平台完成个人认证提升配额，或配置多把 AK 轮换。'
      : undefined,
  };
}

/** 报告级缓存 + 并发去重（2026-10-08 提速）：
 *  同一量化圆心 10 分钟内直接复用整份体检报告（重复访问 <50ms）；
 *  并发同参请求共享同一计算（多端同页不雪崩）。 */
const REPORT_TTL = 10 * 60 * 1000;
const REPORT_GRACE = 30 * 60 * 1000; // stale-while-revalidate 宽限期：TTL 过期后先回旧值、后台重建
const reportCache = new Map(); // key → { at, val }
const reportInflight = new Map(); // key → Promise
function reportCacheKey(lng, lat, radius, city) {
  return `rep:${lng.toFixed(4)},${lat.toFixed(4)}:${Math.round(radius)}:${String(city || '').trim()}`;
}

/** 体检重建作业（本地引擎优先 → MCP 兜底），成功后写缓存 */
function buildReportJob(lng, lat, radius, ck, city) {
  const job = (async () => {
    // ① 本地引擎（七类并行 + 类间错峰 + 共享 POI 缓存 + 城市标准真实权重）
    try {
      const data = await localDiagnose({ lng, lat, radius, city });
      if (reportCache.size >= 64) reportCache.delete(reportCache.keys().next().value);
      reportCache.set(ck, { at: Date.now(), val: data });
      return data;
    } catch (e1) {
      logger.warn('life', `local diagnose failed: ${e1.message}`);
    }
    // ② 本地异常 → MCP 兜底（限时 6s，质量校验后采用）
    if (!isQuotaBlocked()) {
      const r = await withTimeout(hub.callByQualifiedName('life-circle__diagnose', { lng, lat, radius }), 6000, null);
      const data = r && r.data && (r.data.result || r.data);
      const suspicious = data && Array.isArray(data.categories) && data.categories.filter((c) => !c.count).length >= 4;
      if (data && !suspicious) {
        reportCache.set(ck, { at: Date.now(), val: data });
        return data;
      }
    }
    throw new Error('all engines failed');
  })().finally(() => reportInflight.delete(ck));
  reportInflight.set(ck, job);
  return job;
}

module.exports = {
  /** GET /api/v1/life/report?lng=&lat=&radius=
   *  提速改造（2026-10-08）：原架构「MCP 先行(8s 限时)→失败才本地」纯串行，最坏 10s+。
   *  新架构：报告缓存 → 并发去重 → **本地引擎优先**（与等时圈共享 POI 5min 缓存，
   *  等时圈刚算过则体检近乎零延迟）→ MCP 降级为本地异常时的兜底。
   *  提速二段（2026-10-09 stale-while-revalidate）：TTL 过期后的宽限期内**立即返回旧值
   *  并后台静默重建**（stale:true 标注）——冷启动 1.3s 从用户路径上整体摘除，
   *  只有连宽限期也超了才真正同步等待重建。 */
  'GET /life/report': async (req, res, q) => {
    const lng = numOr(q.lng, NaN);
    const lat = numOr(q.lat, NaN);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return fail(res, 1001, 'lng/lat 必填');
    const radius = numOr(q.radius, 1200);
    const city = String(q.city || '').trim(); // 城市名：命中城市规范时用该规范的真实权重计分
    const ck = reportCacheKey(lng, lat, radius, city);

    const hit = reportCache.get(ck);
    if (hit) {
      const age = Date.now() - hit.at;
      if (age < REPORT_TTL) return ok(res, hit.val);
      // stale-while-revalidate：宽限期内回旧值 + 后台重建（不阻塞响应）
      if (age < REPORT_TTL + REPORT_GRACE) {
        if (!reportInflight.has(ck)) buildReportJob(lng, lat, radius, ck, city);
        return ok(res, { ...hit.val, stale: true });
      }
    }

    if (reportInflight.has(ck)) {
      try {
        return ok(res, await reportInflight.get(ck));
      } catch (e) {
        return fail(res, 5003, '体检引擎繁忙，请稍后再试');
      }
    }

    try {
      return ok(res, await buildReportJob(lng, lat, radius, ck, city));
    } catch (e) {
      return fail(res, 5003, '体检引擎繁忙，请稍后再试');
    }
  },

  /** GET /api/v1/life/isochrone?lng=&lat=&minutes=15&grid=5
   *  步行等时圈 + 七类覆盖 + 服务盲区（命题一核心能力：真实路网而非直线圆）。
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
        grid: q.grid ? numOr(q.grid, 5) : undefined, // 缺省走网格密度自适应（≤10min→7×7）
      });
      // 安全升级(2026-10-06):百度静态图改为本服务代理,这里把代理路径拼成完整 URL
      // (协议/域名取请求头,兼容本地 IP、局域网与云托管域名;端上 <image> 用法不变)
      if (data && data.baiduStatic && data.baiduStatic.staticPath && !data.baiduStatic.url) {
        const host = req.headers['x-forwarded-host'] || req.headers.host || '';
        if (host) {
          const xf = String(req.headers['x-forwarded-proto'] || '');
          const proto =
            xf.split(',')[0].trim() ||
            (/^(localhost|127\.|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) ? 'http' : 'https');
          data.baiduStatic.url = `${proto}://${host}${data.baiduStatic.staticPath}`;
        }
      }
      return ok(res, data);
    } catch (e) {
      logger.error('life', `isochrone failed: ${e.message}`);
      return fail(res, 5004, '等时圈计算失败，请稍后再试');
    }
  },

  /** GET /api/v1/life/standards?city=长沙
   *  各地生活圈管理规范（评分依据）：按城市匹配适用标准，未命中回退国家指南。
   *  端上 GET 缓存 7 天；本地缓存 + 云端存储双通道。 */
  'GET /life/standards': async (req, res, q) => {
    return ok(res, standards.resolve(q && q.city));
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
