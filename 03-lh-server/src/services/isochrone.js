/**
 * 鲤慧 LiHui · 步行等时圈与服务盲区识别引擎（零依赖）
 *
 * ▍为什么需要它（对照 2026 上海开源软件应用创新大赛·百度地图命题一评分标准）
 *  - 功能正确性 40%：等时圈必须基于「真实步行算路」而非直线半径圆；
 *    盲区识别要有可解释、可复现的口径（见下方 BLIND_RULE）。
 *  - API 深度 30%：批量矩阵算路（1×N destinations）+ 并发容错 + 空间插值。
 *  官方提示口径：「扇形采样 + 空间插值仅连通区域，无需底层路网数据」。
 *
 * ▍算法总览
 *  1. 扇形采样：以家为圆心，36 个方向（每 10°）。
 *  2. 二分收敛：每方向在 [0, 上限] 间二分「最大可达步行距离」；每轮把
 *     36 个中点打包成一次「1×36 批量矩阵算路」，3 轮收敛
 *     —— 一次体检只烧 3 次算路配额，而不是 36×3 次单点请求。
 *  3. 降级链：批量矩阵 → 并发 directionlite/walking（令牌桶限流）
 *     → 理想圆（engine = ideal-circle-degraded，显式标注不冒充真算路）。
 *  4. 空间插值：36 个可达点用 Catmull-Rom 闭合样条连成平滑等时圈多边形。
 *  5. 盲区判定（BLIND_RULE）：等时圈内部 N×N 网格，格中心到七类最近设施的
 *     步行时间 = haversine × 路网弯曲系数 1.3 ÷ 步速 80m/min（官方允许口径）；
 *     加权覆盖分 < 40 判盲区；候选盲区格再用一次批量矩阵实测「家→格中心」复核，
 *     实测超时 15% 以上说明插值多边形偏乐观，剔除该格。
 *
 * ▍坐标系统一：全程 GCJ-02（与小程序 wx.getLocation / POI 检索一致）。
 *   矩阵/单点算路入参 coord_type=3 (GCJ-02)，返回不设 ret_coordtype（保持 GCJ-02）。
 */

const baiduMap = require('./baiduMap');
const logger = require('../utils/logger');
const { Cache } = require('../utils/cache');
const { gcj02ToBd09 } = require('../utils/coord');
const config = require('../config');
const { CATEGORIES, isQuotaBlocked, noteQuotaError, poiCacheGet, poiCacheSet, dedupePOIs, catStagger } = require('./lifeShared');

/* ---------------- 常量（官方口径） ---------------- */
const SPEED_M_PER_MIN = 80;            // 步行速度 80 m/min
const DETOUR_FACTOR = 1.3;             // 路网弯曲系数：实际步行距离 ≈ 直线 ×1.3
const BEARINGS = 36;                   // 扇形采样方向数（10° 间隔）
const BISECT_ROUNDS = 3;               // 二分收敛轮数
const MATRIX_TTL = 60 * 1000;          // 矩阵算路缓存 1min
const ISO_CACHE_TTL = 10 * 60 * 1000;  // 等时圈整体结果缓存 10min
const BLIND_SCORE_THRESHOLD = 40;      // 盲区判定阈值（加权覆盖分 < 40）
const BLIND_SEVERE_THRESHOLD = 25;     // 严重盲区阈值（覆盖分 < 25：七类几乎全缺）
const VERIFY_TOLERANCE = 1.15;         // 盲区复核实测容忍系数（超 15% 判插值偏乐观）

const isoCache = new Cache(64);

/* ---------------- 基础几何（零依赖） ---------------- */
const R_EARTH = 6371000;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

/** 两点球面距离（米）。城市尺度下 GCJ-02 近似 WGS-84 球面计算，误差可忽略 */
function haversine(lng1, lat1, lng2, lat2) {
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(a));
}

/** 从起点沿方位角 bearingDeg 走 dist 米的目标点（球面正解） */
function destination(lng, lat, bearingDeg, dist) {
  const br = rad(bearingDeg);
  const la1 = rad(lat);
  const lo1 = rad(lng);
  const dr = dist / R_EARTH;
  const la2 = Math.asin(Math.sin(la1) * Math.cos(dr) + Math.cos(la1) * Math.sin(dr) * Math.cos(br));
  const lo2 =
    lo1 +
    Math.atan2(
      Math.sin(br) * Math.sin(dr) * Math.cos(la1),
      Math.cos(dr) - Math.sin(la1) * Math.sin(la2)
    );
  return { lng: deg(lo2), lat: deg(la2) };
}

/** 射线法：点是否在多边形内（GCJ-02 平面近似） */
function pointInPolygon(lng, lat, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].lng;
    const yi = poly[i].lat;
    const xj = poly[j].lng;
    const yj = poly[j].lat;
    const hit = yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}

/** Catmull-Rom 闭合样条：把 36 个离散可达点插值成平滑等时圈轮廓（空间插值核心） */
function catmullRomClosed(pts, seg = 8) {
  const n = pts.length;
  if (n < 3) return pts.slice();
  const out = [];
  const p = (i) => pts[((i % n) + n) % n];
  for (let i = 0; i < n; i++) {
    const p0 = p(i - 1);
    const p1 = p(i);
    const p2 = p(i + 1);
    const p3 = p(i + 2);
    for (let t = 0; t < seg; t++) {
      const s = t / seg;
      const s2 = s * s;
      const s3 = s2 * s;
      out.push({
        lng:
          0.5 *
          (2 * p1.lng +
            (-p0.lng + p2.lng) * s +
            (2 * p0.lng - 5 * p1.lng + 4 * p2.lng - p3.lng) * s2 +
            (-p0.lng + 3 * p1.lng - 3 * p2.lng + p3.lng) * s3),
        lat:
          0.5 *
          (2 * p1.lat +
            (-p0.lat + p2.lat) * s +
            (2 * p0.lat - 5 * p1.lat + 4 * p2.lat - p3.lat) * s2 +
            (-p0.lat + 3 * p1.lat - 3 * p2.lat + p3.lat) * s3),
      });
    }
  }
  return out;
}

/** 鞋带公式估算多边形面积（㎡）；cos(lat) 修正经度收敛 */
function polygonArea(poly, latRef) {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    a += poly[j].lng * poly[i].lat - poly[i].lng * poly[j].lat;
  }
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos(rad(latRef));
  return Math.abs(a / 2) * mPerDegLat * mPerDegLng;
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : 0;
}

/* ---------------- 批量矩阵算路（多端点候选 + 进程内记忆） ---------------- */
/**
 * 批量算路 endpoint 实测（2026-10，真实 AK 验证）：
 *   ✅ /routematrix/v2/walking  —— 参数名是 coordtype（无下划线），3=GCJ-02；
 *      不传 coordtype 会按 BD-09 解释入参 → 整体偏移 500~900m。
 *   ⚠️ /direction/v2/matrix     —— 备用端点，实测返回 inner error，仅作保险。
 * 返回结构与 directionlite 不同：result[i].distance/duration 是 {text,value} 对象。
 * ⚠️ 配额池独立性（实测）：批量算路与 place 检索配额池互不共享 ——
 *   place 302（天配额超限）时矩阵算路仍可用，反之亦然。因此矩阵层有独立的
 *   matrixBlockedUntil 短路器，不接入共享检索熔断，避免「检索挂了连累真算路」。
 */
let matrixEndpoint = null;
let matrixBlockedUntil = 0;
function isMatrixBlocked() {
  return Date.now() < matrixBlockedUntil;
}
function noteMatrixError(e) {
  /* V1.0.27：401 并发超限是瞬时的，45 秒短熔断即恢复（此前一律 10 分钟，
   * 算路熔断期间等时圈被迫降级理想圆，与检索熔断叠加造成"全页没数据"观感）；
   * 302 天配额仍熔断 10 分钟。 */
  if (e && e.baiduStatus === 302) {
    matrixBlockedUntil = Date.now() + 10 * 60 * 1000;
    logger.warn('isochrone', 'matrix quota blocked (status=302 天配额), 算路熔断 10 分钟');
    return true;
  }
  if (e && e.baiduStatus === 401) {
    matrixBlockedUntil = Date.now() + 45 * 1000;
    logger.warn('isochrone', 'matrix quota blocked (status=401 并发超限), 算路短熔断 45 秒');
    return true;
  }
  return false;
}
function parseMatrixVal(v) {
  // 兼容 {text,value} 对象式与数字式两种形态
  const n = Number(v && v.value !== undefined ? v.value : v);
  return Number.isFinite(n) ? n : 0;
}
async function walkMatrixBatch(origin, dests) {
  if (isMatrixBlocked()) throw Object.assign(new Error('matrix quota blocked'), { matrixBlocked: true });
  const o = `${origin.lat},${origin.lng}`;
  const d = dests.map((p) => `${p.lat},${p.lng}`).join('|');
  // issue #3：记住的端点若以「非配额类」原因失败（改版/临时故障），立即失效缓存并
  // 回退完整候选列表重试一次（递归自带守卫：缓存已清空，第二轮不会再进本分支）。
  const cached = matrixEndpoint;
  const candidates = cached
    ? [cached]
    : [
        { path: '/routematrix/v2/walking', params: { coordtype: 'gcj02' } }, // 实测可用（GCJ-02）
        { path: '/routematrix/v2/walking', params: { coordtype: 3 } }, // 数字风格也实测兼容
        { path: '/direction/v2/matrix', params: { coordtype: 'gcj02' } }, // 备用端点
      ];
  let lastErr = null;
  for (const c of candidates) {
    try {
      const raw = await baiduMap.call(
        c.path,
        { ...c.params, origins: o, destinations: d },
        { ttl: MATRIX_TTL, cacheKey: `mtx:${c.path}:${JSON.stringify(c.params)}:${o}:${d}` }
      );
      const arr = (raw.result || []).map((it) => ({
        distance: parseMatrixVal(it.distance),
        duration: parseMatrixVal(it.duration),
      }));
      if (arr.length !== dests.length) throw new Error(`matrix size ${arr.length} != ${dests.length}`);
      matrixEndpoint = c;
      return arr;
    } catch (e) {
      lastErr = e;
      // 算路配额类错误换端点也没用，直接上抛走降级链
      if (e.baiduStatus === 302 || e.baiduStatus === 401) throw e;
      logger.warn('isochrone', `matrix endpoint ${c.path}(${JSON.stringify(c.params)}) failed: ${e.message}`);
      if (cached && c === cached) {
        matrixEndpoint = null; // 失效即重置，下次（含本轮递归）重新尝试全部候选端点
        return walkMatrixBatch(origin, dests);
      }
    }
  }
  throw lastErr || new Error('matrix all endpoints failed');
}

/* ---------------- 令牌桶 + 并发单点算路（降级链第二层） ---------------- */
function makeTokenBucket({ capacity = 8, refillEveryMs = 130 } = {}) {
  let tokens = capacity;
  let last = Date.now();
  return async function take() {
    for (;;) {
      const now = Date.now();
      // ⚠️ 只有真正累积了令牌才推进 last：若每轮循环都 last=now，
      //   elapsed 永远 ≈0 → 令牌永不回流 → 并发任务全部挂死（实测踩过）
      const elapsed = now - last;
      if (elapsed >= refillEveryMs) {
        tokens = Math.min(capacity, tokens + Math.floor(elapsed / refillEveryMs));
        last = now - (elapsed % refillEveryMs);
      }
      if (tokens > 0) {
        tokens -= 1;
        return;
      }
      await new Promise((r) => setTimeout(r, refillEveryMs));
    }
  };
}

/** 并发 directionlite/walking：单点失败不炸整批，返回 {results, okCount} */
async function walkConcurrent(origin, dests, { concurrency = 8 } = {}) {
  const take = makeTokenBucket({ capacity: concurrency, refillEveryMs: 130 });
  const results = new Array(dests.length).fill(null);
  let idx = 0;
  let okCount = 0;
  async function worker() {
    for (;;) {
      const i = idx++;
      if (i >= dests.length) return;
      await take();
      try {
        const r = await baiduMap.route({
          mode: 'walking',
          origin: `${origin.lat},${origin.lng}`,
          destination: `${dests[i].lat},${dests[i].lng}`,
        });
        if (r.duration > 0) {
          results[i] = { distance: r.distance, duration: r.duration };
          okCount++;
        }
      } catch (e) {
        /* 单点失败留 null；算路池配额类错误熔断并让 worker 提前收工，避免空烧 */
        if (e.baiduStatus === 302 || e.baiduStatus === 401) {
          noteMatrixError(e);
          return;
        }
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return { results, okCount };
}

/* ------------------------------------------------------------------ */
/* 盲区判定辅助（纯函数，CI 可测）                                      */
/* ------------------------------------------------------------------ */
/**
 * 盲区分级（可解释口径）：
 *  - severe   覆盖分 < 25：七类设施几乎全缺，居民基本生活服务无法步行获得；
 *  - moderate 覆盖分 25~40：存在明显短板（通常缺 2~3 类）；
 *  - null     非盲区。
 */
function blindLevel(score) {
  if (score === null || score === undefined) return null;
  if (score < BLIND_SEVERE_THRESHOLD) return 'severe';
  if (score < BLIND_SCORE_THRESHOLD) return 'moderate';
  return null;
}

/** 盲区占比（0~100）→ 治理等级：<10 良好 · 10~25 一般 · ≥25 待改善 */
function blindGrade(ratioPct) {
  if (ratioPct < 10) return '良好';
  if (ratioPct < 25) return '一般';
  return '待改善';
}

/** 盲区网格密度自适应：小半径圆格距小，自动加密网格保证盲区判读分辨率 */
function resolveGridN(requested, minutesN) {
  const n = Math.round(Number(requested) || 0);
  if (n) return Math.min(9, Math.max(3, n)); // 显式指定优先（越界钳制 3~9）
  if (minutesN <= 10) return 7;              // ≤10 分钟：格距约 260~400m，抓细碎盲区
  if (minutesN <= 20) return 6;              // 11~20 分钟：格距约 450~600m
  return 5;                                  // >20 分钟：格距约 700m+，控制复核矩阵调用量
}

/** 盲区格 4-邻接连通聚类：把离散格聚成可治理地块（单格孤点也算独立地块） */
function clusterBlindCells(blindCells) {
  const key = (c) => c.i + ',' + c.j;
  const blindSet = new Set(blindCells.map(key));
  const seen = new Set();
  const clusters = [];
  for (const c0 of blindCells) {
    if (seen.has(key(c0))) continue;
    const stack = [c0];
    seen.add(key(c0));
    const comp = [];
    while (stack.length) {
      const cur = stack.pop();
      comp.push(cur);
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ni = cur.i + di;
        const nj = cur.j + dj;
        const nk = ni + ',' + nj;
        if (blindSet.has(nk) && !seen.has(nk)) {
          seen.add(nk);
          const nb = blindCells.find((x) => x.i === ni && x.j === nj);
          if (nb) stack.push(nb);
        }
      }
    }
    clusters.push(comp);
  }
  return clusters;
}

/** 地块短板归因：聚类内某类「步行超时/缺失」格占比 ≥50% 判该地块缺这类 */
function clusterLacking(comp, coverageCats, minutesN) {
  return coverageCats
    .filter((c) => !c.failed)
    .map((c) => {
      let miss = 0;
      for (const cell of comp) {
        const w = cell.walkMinByCategory[c.key];
        if (w === null || w === undefined || w >= minutesN) miss++;
      }
      return { key: c.key, name: c.name, gapPct: Math.round((miss / comp.length) * 100) };
    })
    .filter((x) => x.gapPct >= 50)
    .sort((a, b) => b.gapPct - a.gapPct)
    .slice(0, 3);
}

/**
 * 子预算可达半径插值（多档等时圈核心，纯函数，CI 可测）：
 * 用该方向二分过程中全部 (dist, duration) 实测样本做分段线性插值，
 * 样本不覆盖目标预算时按均匀速度从最近样本外推，最后用主预算半径约束单调性
 * （时间更短 → 可达距离不得反超主档，±5% 容差防插值毛刺）。
 * @returns 半径（米）；无任何有效样本时返回 null
 */
function interpolateReach(samples, budgetSec, maxRadius) {
  const pts = (samples || [])
    .filter((s) => s && s.dist > 0 && s.duration > 0)
    .sort((a, b) => a.duration - b.duration);
  if (!pts.length) return null;
  let est;
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (budgetSec <= first.duration) {
    est = first.dist * (budgetSec / first.duration); // 样本全部超时 → 向内推
  } else if (budgetSec >= last.duration) {
    est = last.dist * (budgetSec / last.duration); // 样本全部可达 → 向外推
  } else {
    for (let k = 1; k < pts.length; k++) {
      if (pts[k].duration >= budgetSec) {
        const a = pts[k - 1];
        const b = pts[k];
        const t = (budgetSec - a.duration) / (b.duration - a.duration);
        est = a.dist + t * (b.dist - a.dist); // 区间内分段线性插值
        break;
      }
    }
  }
  if (Number.isFinite(maxRadius)) est = Math.min(est, maxRadius * 1.05);
  return Math.max(est, 0);
}

/* ------------------------------------------------------------------ */
/* 主流程：buildIsochrone                                              */
/* ------------------------------------------------------------------ */
/**
 * @param {object} p
 * @param {number} p.lng 家经度（GCJ-02）
 * @param {number} p.lat 家纬度（GCJ-02）
 * @param {number} [p.minutes=15] 等时圈分钟数（5~60）
 * @param {number} [p.grid] 盲区网格 N×N（3~9；缺省按分钟数自适应：≤10→7×7，≤20→6×6，更大→5×5）
 */
async function buildIsochrone({ lng, lat, minutes = 15, grid } = {}) {
  const center = { lng: Number(lng), lat: Number(lat) };
  if (!Number.isFinite(center.lng) || !Number.isFinite(center.lat)) {
    throw new Error('lng/lat invalid');
  }
  const minutesN = Math.min(60, Math.max(5, Number(minutes) || 15));
  const gridN = resolveGridN(grid, minutesN);

  const cacheKey = `iso:${center.lng.toFixed(4)},${center.lat.toFixed(4)}:${minutesN}:${gridN}`;
  const cached = isoCache.get(cacheKey);
  if (cached) return cached;

  const budget = minutesN * 60; // 秒
  const idealR = minutesN * SPEED_M_PER_MIN * DETOUR_FACTOR; // 理想直线可达半径
  const rMax0 = idealR * 1.5; // 二分上限富余 1.5 倍

  const lo = new Array(BEARINGS).fill(0);
  const hi = new Array(BEARINGS).fill(rMax0);
  const lastProbe = new Array(BEARINGS).fill(null); // {dist, duration} 每方向最近一次实测
  const samples = Array.from({ length: BEARINGS }, () => []); // 每方向全部实测样本（多档等时圈插值用）

  let engine = null;
  let matrixRounds = 0;
  let matrixOkRounds = 0;

  /* —— 阶段 2 提前并行：七类设施检索不依赖真实 radii，用保守半径 idealR×2
   *    （理论 maxR ≤ 1.575×idealR，×1.25 = 1.97×idealR < 2×idealR 必然覆盖），
   *    与批量矩阵同时发起 —— 省掉原先串行等待的整个阶段 2（约 1.5~2s）。
   *    检索半径略大只会让「每类最近设施」找得更准，盲区判定无副作用。 —— */
  const preRadius = Math.ceil(idealR * 2);
  const catsPromise = Promise.all(
    CATEGORIES.map(async (c, i) => {
      if (isQuotaBlocked()) return { ...c, items: [], failed: true, quota: true };
      await new Promise((r) => setTimeout(r, catStagger(i))); // 类间错峰（按百度 QPS 上限动态节奏，防 401 并发超限）
      const ck = `lite:${c.key}:${center.lng.toFixed(4)},${center.lat.toFixed(4)}:${preRadius}`;
      const cached = poiCacheGet(ck);
      if (cached) return { ...c, items: cached, failed: false };
      try {
        const r = await baiduMap.poiSearch({
          query: c.keywords.join('|'),
          lng: center.lng,
          lat: center.lat,
          radius: preRadius,
          pageSize: 20,
        });
        const items = dedupePOIs((r.items || []).filter((x) => Number.isFinite(x.lng) && Number.isFinite(x.lat))); // 去重后再入缓存/计数（与体检评分口径一致）
        if (items.length) poiCacheSet(ck, items); // 只缓存有效结果，失败留白下次重试
        return { ...c, items, failed: false };
      } catch (e) {
        noteQuotaError(e);
        return { ...c, items: [], failed: true };
      }
    })
  );

  /* —— 阶段 1：批量矩阵二分收敛（只看算路池熔断，不受检索配额影响） —— */
  if (!isMatrixBlocked()) {
    for (let round = 0; round < BISECT_ROUNDS; round++) {
      const mids = new Array(BEARINGS);
      const dests = new Array(BEARINGS);
      for (let i = 0; i < BEARINGS; i++) {
        mids[i] = (lo[i] + hi[i]) / 2;
        dests[i] = destination(center.lng, center.lat, (360 / BEARINGS) * i, mids[i]);
      }
      try {
        const arr = await walkMatrixBatch(center, dests);
        matrixRounds++;
        let okCount = 0;
        for (let i = 0; i < BEARINGS; i++) {
          const it = arr[i];
          if (!it || !(it.duration > 0)) continue; // 该方向本轮失败 → 区间不动
          okCount++;
          lastProbe[i] = { dist: mids[i], duration: it.duration };
          samples[i].push({ dist: mids[i], duration: it.duration });
          if (it.duration <= budget) lo[i] = mids[i];
          else hi[i] = mids[i];
        }
        if (okCount < BEARINGS * 0.5) {
          logger.warn('isochrone', `matrix round ${round + 1}: only ${okCount}/${BEARINGS} valid`);
        }
        matrixOkRounds++;
      } catch (e) {
        noteMatrixError(e);
        logger.warn('isochrone', `matrix batch failed at round ${round + 1}: ${e.message}`);
        break; // 整轮失败 → 跳出走降级链
      }
    }
  }
  const matrixUsable = matrixOkRounds > 0 && lastProbe.some(Boolean);

  let radii;
  if (matrixUsable) {
    /* —— 阶段 1.5：按最近一次实测外推每方向可达半径（空间插值第一层） —— */
    engine = 'routematrix-batch';
    const fallbackMedian = median(lastProbe.filter(Boolean).map((p) => p.dist));
    radii = new Array(BEARINGS);
    for (let i = 0; i < BEARINGS; i++) {
      const probe = lastProbe[i];
      if (!probe || !(probe.duration > 0)) {
        radii[i] = fallbackMedian || idealR; // 从未测到的方向用中位数兜底
        continue;
      }
      // 已知 probe.dist 处耗时 probe.duration，均匀速度外推可达距离，
      // 再与二分区间交叉约束（防单点噪声把半径炸飞/压扁）
      const est = probe.dist * (budget / probe.duration);
      radii[i] = Math.min(Math.max(est, lo[i]), Math.max(hi[i], probe.dist) * 1.05);
    }
  } else if (!isMatrixBlocked()) {
    /* —— 降级链第二层：并发 directionlite/walking（同属算路池） —— */
    const dests = Array.from({ length: BEARINGS }, (_, i) =>
      destination(center.lng, center.lat, (360 / BEARINGS) * i, idealR)
    );
    try {
      const { results, okCount } = await walkConcurrent(center, dests);
      if (okCount > 0) {
        engine = 'directionlite-concurrent';
        radii = results.map((r, i) => {
          if (!r || !(r.duration > 0)) return idealR;
          samples[i].push({ dist: idealR, duration: r.duration }); // 并发降级路径也留样本，多档环同样可用
          const est = idealR * (budget / r.duration); // 实测耗时反推真实可达距离
          return Math.min(Math.max(est, idealR * 0.2), idealR * 2.5);
        });
      }
    } catch (e) {
      logger.warn('isochrone', `concurrent fallback failed: ${e.message}`);
    }
  }
  if (!radii) {
    /* —— 降级链第三层：理想圆（显式标注 degraded，不冒充真算路） —— */
    engine = 'ideal-circle-degraded';
    radii = new Array(BEARINGS).fill(idealR);
  }

  const bearings = radii.map((r, i) => {
    const b = (360 / BEARINGS) * i;
    const pt = destination(center.lng, center.lat, b, r);
    return { bearing: b, lng: pt.lng, lat: pt.lat, radiusM: Math.round(r) };
  });
  // Catmull-Rom 闭合样条：36 离散点 → 平滑等时圈多边形（空间插值第二层）
  const polygon = catmullRomClosed(
    bearings.map((b) => ({ lng: b.lng, lat: b.lat })),
    8
  );

  /* —— 多档等时圈（V1.0.27 算法升级）：一次算路，多档环零额外成本 ——
   * 二分探针已实测每方向多个 (距离, 耗时) 样本，子预算用分段线性插值直接得出，
   * 不再发任何算路请求；理想圆降级时按时间比等比缩小。 */
  const ringSteps = [...new Set([Math.round(minutesN / 3), Math.round((minutesN * 2) / 3)])]
    .filter((m) => m >= 3 && m < minutesN)
    .sort((a, b) => a - b);
  const rings = ringSteps.map((m) => {
    const sec = m * 60;
    const radii2 =
      engine === 'ideal-circle-degraded'
        ? radii.map((r) => r * (m / minutesN))
        : radii.map((r, i) => {
            const est = interpolateReach(samples[i], sec, r);
            return est === null ? r * (m / minutesN) : est;
          });
    const poly = catmullRomClosed(
      radii2.map((r, i) => destination(center.lng, center.lat, (360 / BEARINGS) * i, r)),
      8
    );
    return { minutes: m, polygon: poly, areaKm2: Math.round((polygonArea(poly, center.lat) / 1e6) * 100) / 100 };
  });

  /* —— 阶段 2：七类设施检索（已在阶段 1 前并行发起，此处仅收割结果） —— */
  const maxR = Math.max(...radii);
  const cats = await catsPromise;

  /* —— 阶段 3：N×N 网格盲区判定 —— */
  /**
   * BLIND_RULE（盲区口径，可解释可复现）：
   *  - 论域：等时圈多边形内部的网格（圈外步行本来就超时，不算「盲」）。
   *  - 每格每类步行分钟 = haversine(格中心, 该类最近设施) × 1.3 ÷ 80。
   *    （官方允许：设施覆盖用直线 × 弯曲系数估算，无需逐格真算路）
   *  - 类覆盖度 cov_c = max(0, 1 - walk_c / minutes)；无设施 = 0。
   *  - 格加权覆盖分 = Σ cov_c × weight_c / Σ weight_c × 100
   *    （检索异常的类不参计分，权重归一化 —— 与 /life/report 口径一致）。
   *  - 盲区：insideCircle && score < 40。
   *  - 复核：候选盲区格再用一次 1×M 批量矩阵实测「家→格中心」，
   *    实测 > minutes×60×1.15 → 插值偏乐观，改判圈外（outsideVerified）。
   */
  const lons = polygon.map((p) => p.lng);
  const lats = polygon.map((p) => p.lat);
  const bbox = {
    minLng: Math.min(...lons),
    maxLng: Math.max(...lons),
    minLat: Math.min(...lats),
    maxLat: Math.max(...lats),
  };

  const cells = [];
  for (let j = 0; j < gridN; j++) {
    for (let i = 0; i < gridN; i++) {
      const lngC = bbox.minLng + ((i + 0.5) / gridN) * (bbox.maxLng - bbox.minLng);
      const latC = bbox.minLat + ((j + 0.5) / gridN) * (bbox.maxLat - bbox.minLat); // j=0 为最南
      const insideCircle = pointInPolygon(lngC, latC, polygon);
      const walkByCategory = {};
      let wSum = 0;
      let wDiv = 0;
      let minWalk = null;
      for (const c of cats) {
        let best = null;
        for (const it of c.items) {
          const d = haversine(lngC, latC, it.lng, it.lat);
          if (best === null || d < best.d) best = { d, name: it.name };
        }
        const walkMin = best ? (best.d * DETOUR_FACTOR) / SPEED_M_PER_MIN : null;
        walkByCategory[c.key] = walkMin === null ? null : Math.round(walkMin * 10) / 10;
        if (c.failed) continue; // 检索异常类不参计分
        const cov = walkMin === null ? 0 : Math.max(0, 1 - walkMin / minutesN);
        wSum += cov * c.weight;
        wDiv += c.weight;
        if (walkMin !== null && (minWalk === null || walkMin < minWalk)) minWalk = walkMin;
      }
      const score = wDiv > 0 ? Math.round((wSum / wDiv) * 100) : null;
      const level = insideCircle ? blindLevel(score) : null;
      cells.push({
        i,
        j,
        lng: Math.round(lngC * 1e6) / 1e6,
        lat: Math.round(latC * 1e6) / 1e6,
        insideCircle,
        walkMinByCategory: walkByCategory,
        nearestWalkMin: minWalk === null ? null : Math.round(minWalk * 10) / 10,
        score,
        level,
        blind: Boolean(level),
      });
    }
  }

  // 盲区复核：一次 1×M 批量矩阵实测「家→格中心」（矩阵挂了就沿用插值结论）
  const blindCandidates = cells.filter((c) => c.blind);
  let verifiedCells = 0;
  if (blindCandidates.length && !isMatrixBlocked()) {
    try {
      const arr = await walkMatrixBatch(
        center,
        blindCandidates.map((c) => ({ lng: c.lng, lat: c.lat }))
      );
      blindCandidates.forEach((c, k) => {
        const it = arr[k];
        if (it && it.duration > 0) {
          verifiedCells++;
          if (it.duration > budget * VERIFY_TOLERANCE) {
            c.blind = false;
            c.level = null;
            c.outsideVerified = true; // 实测步行超时：其实不在生活圈内（多边形插值偏乐观）
          }
        }
      });
    } catch (e) {
      logger.warn('isochrone', `blind verify matrix failed: ${e.message}`);
    }
  }

  const insideCells = cells.filter((c) => c.insideCircle && !c.outsideVerified);
  const blindCells = insideCells.filter((c) => c.blind);

  // 每类覆盖率 = 圈内饰加权平均；平均步行分钟 = 圈内饰对该类 walk 的均值
  const coverage = cats.map((c) => {
    if (c.failed) {
      return { key: c.key, name: c.name, weight: c.weight, count: 0, ratio: null, avgWalkMin: null, failed: true };
    }
    let sum = 0;
    let walkSum = 0;
    let walkN = 0;
    for (const cell of insideCells) {
      const w = cell.walkMinByCategory[c.key];
      sum += w === null ? 0 : Math.max(0, 1 - w / minutesN);
      if (w !== null) {
        walkSum += w;
        walkN++;
      }
    }
    return {
      key: c.key,
      name: c.name,
      weight: c.weight,
      count: c.items.length,
      ratio: insideCells.length ? Math.round((sum / insideCells.length) * 100) : 0,
      avgWalkMin: walkN ? Math.round((walkSum / walkN) * 10) / 10 : null,
      failed: false,
    };
  });
  const covValid = coverage.filter((c) => !c.failed);
  const covW = covValid.reduce((a, b) => a + b.weight, 0) || 1;
  const coverageScore = Math.round(covValid.reduce((a, b) => a + b.ratio * (b.weight / covW), 0));

  /* ===== 服务盲区分析（工业级指标，纯后处理，不动引擎主链路） =====
   *  - blindAreaHa   盲区面积（公顷）= 盲区格数 × 单格面积
   *  - detourIndex   绕行系数 = 真实最远可达 ÷ 理想直线半径（路网弯曲的实际体现）
   *  - categoryGaps  分类缺口率 = 盲区格中该类「步行超时/缺失」的比例
   *  - hotspots      优先改造地块 = 盲区格 4-邻接连通聚类，按 面积 × 缺口强度 排序 Top3
   */
  const latRad = (center.lat * Math.PI) / 180;
  const cellWM = ((bbox.maxLng - bbox.minLng) / gridN) * 111320 * Math.cos(latRad);
  const cellHM = ((bbox.maxLat - bbox.minLat) / gridN) * 110540;
  const cellHa = (cellWM * cellHM) / 10000;
  const blindAreaHa = Math.round(blindCells.length * cellHa * 100) / 100;
  const idealRadius = minutesN * SPEED_M_PER_MIN;
  const detourIndex = idealR > 0 ? Math.round((maxR / idealRadius) * 100) / 100 : null;

  const categoryGaps = coverage
    .filter((c) => !c.failed)
    .map((c) => {
      let miss = 0;
      for (const cell of blindCells) {
        const w = cell.walkMinByCategory[c.key];
        if (w === null || w === undefined || w >= minutesN) miss++;
      }
      return {
        key: c.key,
        name: c.name,
        gapPct: blindCells.length ? Math.round((miss / blindCells.length) * 100) : 0,
      };
    })
    .sort((a, b) => b.gapPct - a.gapPct);

  const clusters = clusterBlindCells(blindCells);
  const hotspots = clusters
    .map((comp) => {
      const avgScore = Math.round(comp.reduce((a, b) => a + (b.score || 0), 0) / comp.length);
      const walkMins = comp.map((x) => x.nearestWalkMin).filter((x) => x !== null && x !== undefined);
      const avgNearest = walkMins.length
        ? Math.round((walkMins.reduce((a, b) => a + b, 0) / walkMins.length) * 10) / 10
        : null;
      return {
        cells: comp.length,
        areaHa: Math.round(comp.length * cellHa * 100) / 100,
        level: blindLevel(avgScore), // 地块分级：severe 优先改造
        avgScore,
        avgNearestWalkMin: avgNearest,
        lacking: clusterLacking(comp, cats, minutesN), // 地块缺哪几类（归因）
        center: {
          lng: Math.round((comp.reduce((a, b) => a + b.lng, 0) / comp.length) * 1e6) / 1e6,
          lat: Math.round((comp.reduce((a, b) => a + b.lat, 0) / comp.length) * 1e6) / 1e6,
        },
        priority: Math.round(comp.length * cellHa * (100 - avgScore) * 100) / 100,
      };
    })
    .sort((a, b) => (b.level === 'severe') - (a.level === 'severe') || b.priority - a.priority)
    .slice(0, 3);
  const gridCellM = Math.round((cellWM + cellHM) / 2);
  const blindRatioPct = insideCells.length ? Math.round((blindCells.length / insideCells.length) * 100) : 0;
  const blindAnalysis = {
    blindAreaHa,
    blindRatioPct,
    grade: blindGrade(blindRatioPct), // 良好 / 一般 / 待改善
    severeCells: blindCells.filter((c) => c.level === 'severe').length,
    detourIndex,
    categoryGaps,
    hotspots,
    gridCellM,
    blindScoreThreshold: BLIND_SCORE_THRESHOLD,
    severeScoreThreshold: BLIND_SEVERE_THRESHOLD,
    method: `栅格 ${gridCellM}m · 判定阈值 覆盖分<${BLIND_SCORE_THRESHOLD}（严重<${BLIND_SEVERE_THRESHOLD}）· 36 方向真实路网标定`,
  };

  /* ===== 百度底图静态图 =====
   * 微信小程序 <map> 组件的底图由微信平台固定用腾讯地图渲染，代码层无法更换。
   * 这里用百度【静态图 API】把同一份等时圈多边形画在真正的百度底图上，
   * 端上「百度底图」开关切换查看 —— 数据引擎（算路/POI/静态图）全栈百度。
   * 安全(2026-10-06 升级)：旧版直接返回带 ak 的百度静态图 URL → 端上抓包/开发者
   * 工具面板即可扒走 AK（本次 API 被盗渠道之一）。现在改为返回本服务代理路径
   * staticPath（不含任何密钥），由 GET /api/v1/map/staticimg 服务端拉图回传二进制；
   * routes/life.js 负责把 staticPath 拼成完整 URL。 */
  let baiduStatic = null;
  if (config.baidu && config.baidu.ak && polygon.length > 2) {
    try {
      const bdPoly = polygon.map((p) => gcj02ToBd09(p.lng, p.lat));
      // 降采样到 ≤72 点：静态图 URL 过长会被服务端截断
      const step = Math.max(1, Math.ceil(bdPoly.length / 72));
      const pathsStr = bdPoly
        .filter((_, i) => i % step === 0)
        .map((p) => p.lng.toFixed(6) + ',' + p.lat.toFixed(6))
        .join(';');
      const cBd = gcj02ToBd09(center.lng, center.lat);
      // 图宽 640px 需覆盖 ≥2.6× 最远可达，按墨卡托分辨率反推 zoom
      const cosLat = Math.cos(rad(center.lat));
      const needRes = (2.6 * Math.max(maxR, 400)) / 640;
      const zoom = Math.max(11, Math.min(17, Math.round(Math.log2((156543 * cosLat) / needRes))));
      const f6 = (n) => Number(n).toFixed(6);
      // 代理路径只携带绘图参数,AK 由 /map/staticimg 服务端注入,永不下发
      const staticPath =
        '/api/v1/map/staticimg' +
        '?center=' + encodeURIComponent(f6(cBd.lng) + ',' + f6(cBd.lat)) +
        '&zoom=' + zoom + '&width=640&height=480' +
        '&markers=' + encodeURIComponent(f6(cBd.lng) + ',' + f6(cBd.lat)) +
        '&paths=' + encodeURIComponent(pathsStr) +
        '&pathStyles=0x1677FF,3,0.25';
      baiduStatic = { staticPath, zoom, proxied: true };
    } catch (e) {
      logger.warn('isochrone', `baidu static map build failed: ${e.message}`);
    }
  }

  // 两个配额池独立（实测）：算路池挂 → 等时圈退化；检索池挂 → 覆盖率降级
  const poiQuotaExhausted = isQuotaBlocked() && cats.every((c) => c.failed);
  const isoDegraded = engine === 'ideal-circle-degraded';
  const hints = [];
  if (isoDegraded) hints.push('真实步行算路暂不可用，等时圈退化为理想圆估算（步行 15 分钟 ×80m/min ×路网弯曲 1.3）。');
  if (poiQuotaExhausted) hints.push('今日百度地图检索配额已用完（每日 0 点自动恢复），覆盖率与盲区部分暂时降级；等时圈不受影响。');
  else if (engine === 'directionlite-concurrent') hints.push('批量算路接口暂不可用，已降级为并发单点算路（耗时略增，精度相当）。');
  const result = {
    center,
    minutes: minutesN,
    grid: gridN,
    walkSpeed: SPEED_M_PER_MIN,
    detourFactor: DETOUR_FACTOR,
    polygon, // GCJ-02 平滑闭合多边形
    bearings, // 36 方向原始采样点
    coverage,
    coverageScore,
    blindZones: blindCells.map((c) => ({
      i: c.i,
      j: c.j,
      lng: c.lng,
      lat: c.lat,
      score: c.score,
      level: c.level,
      nearestWalkMin: c.nearestWalkMin,
    })),
    cells, // 全部网格（前端画覆盖热力 / 盲区标注）
    rings, // 多档等时圈（主档外的子档环，零额外算路成本）
    summary: {
      minutes: minutesN,
      gridInside: insideCells.length,
      gridTotal: gridN * gridN,
      blindCount: blindCells.length,
      blindRatio: insideCells.length ? Math.round((blindCells.length / insideCells.length) * 100) : 0,
      blindGrade: blindAnalysis.grade,
      severeCount: blindAnalysis.severeCells,
      circleAreaKm2: Math.round((polygonArea(polygon, center.lat) / 1e6) * 100) / 100,
      maxReachM: Math.round(maxR),
      verifiedCells,
    },
    engine,
    degraded: isoDegraded,
    analysis: blindAnalysis,
    baiduStatic,
    quotaExhausted: poiQuotaExhausted,
    hint: hints.join(' ') || undefined,
    generatedAt: new Date().toISOString(),
  };
  isoCache.set(cacheKey, result, ISO_CACHE_TTL);
  logger.info(
    'isochrone',
    `engine=${engine} rounds=${matrixOkRounds}/${matrixRounds} blind=${blindCells.length}/${insideCells.length} verify=${verifiedCells} cov=${coverageScore}`
  );
  return result;
}

// in-flight 去重(2026-10-06 高并发升级):相同参数的并发请求合并为一次计算,
// 多端同时进页 / 恶意并发只打一次百度,结果共享(配合 TTL 缓存防雪崩)。
const security = require('../utils/security');
const _buildIsochroneRaw = buildIsochrone;
function buildIsochroneDedup(opts) {
  // issue #4：去重 key 与 buildIsochrone 内部 cacheKey 同口径 —— grid 未指定时
  // 用 resolveGridN(自适应 7/6/5) 而非固定 5，避免不同 minutes 的请求 key 碰撞语义混乱。
  const gridN = resolveGridN(opts.grid, opts.minutes || 15);
  const key = `iso:${Number(opts.lng).toFixed(4)}:${Number(opts.lat).toFixed(4)}:${opts.minutes || 15}:${gridN}`;
  return security.dedup(key, () => _buildIsochroneRaw(opts));
}

module.exports = {
  buildIsochrone: buildIsochroneDedup,
  // 纯函数导出：供 CI 自检与单元测试
  haversine,
  destination,
  pointInPolygon,
  catmullRomClosed,
  polygonArea,
  walkMatrixBatch,
  walkConcurrent,
  blindLevel,
  blindGrade,
  resolveGridN,
  clusterBlindCells,
  clusterLacking,
  interpolateReach,
  SPEED_M_PER_MIN,
  DETOUR_FACTOR,
  BLIND_SCORE_THRESHOLD,
  BLIND_SEVERE_THRESHOLD,
};
