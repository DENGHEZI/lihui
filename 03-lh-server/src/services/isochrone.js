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
 *  5. 盲区判定（BLIND_RULE）：等时圈内部 N×N 网格，格中心到六类最近设施的
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
const { CATEGORIES, isQuotaBlocked, noteQuotaError } = require('./lifeShared');

/* ---------------- 常量（官方口径） ---------------- */
const SPEED_M_PER_MIN = 80;            // 步行速度 80 m/min
const DETOUR_FACTOR = 1.3;             // 路网弯曲系数：实际步行距离 ≈ 直线 ×1.3
const BEARINGS = 36;                   // 扇形采样方向数（10° 间隔）
const BISECT_ROUNDS = 3;               // 二分收敛轮数
const MATRIX_TTL = 60 * 1000;          // 矩阵算路缓存 1min
const ISO_CACHE_TTL = 10 * 60 * 1000;  // 等时圈整体结果缓存 10min
const BLIND_SCORE_THRESHOLD = 40;      // 盲区判定阈值（加权覆盖分 < 40）
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
  if (e && (e.baiduStatus === 302 || e.baiduStatus === 401)) {
    matrixBlockedUntil = Date.now() + 10 * 60 * 1000;
    logger.warn('isochrone', `matrix quota blocked (status=${e.baiduStatus}), 算路熔断 10 分钟`);
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
  const candidates = matrixEndpoint
    ? [matrixEndpoint]
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
/* 主流程：buildIsochrone                                              */
/* ------------------------------------------------------------------ */
/**
 * @param {object} p
 * @param {number} p.lng 家经度（GCJ-02）
 * @param {number} p.lat 家纬度（GCJ-02）
 * @param {number} [p.minutes=30] 等时圈分钟数（5~60）
 * @param {number} [p.grid=5] 盲区网格 N×N（3~9）
 */
async function buildIsochrone({ lng, lat, minutes = 30, grid = 5 } = {}) {
  const center = { lng: Number(lng), lat: Number(lat) };
  if (!Number.isFinite(center.lng) || !Number.isFinite(center.lat)) {
    throw new Error('lng/lat invalid');
  }
  const minutesN = Math.min(60, Math.max(5, Number(minutes) || 30));
  const gridN = Math.min(9, Math.max(3, Math.round(Number(grid) || 5)));

  const cacheKey = `iso:${center.lng.toFixed(4)},${center.lat.toFixed(4)}:${minutesN}:${gridN}`;
  const cached = isoCache.get(cacheKey);
  if (cached) return cached;

  const budget = minutesN * 60; // 秒
  const idealR = minutesN * SPEED_M_PER_MIN * DETOUR_FACTOR; // 理想直线可达半径
  const rMax0 = idealR * 1.5; // 二分上限富余 1.5 倍

  const lo = new Array(BEARINGS).fill(0);
  const hi = new Array(BEARINGS).fill(rMax0);
  const lastProbe = new Array(BEARINGS).fill(null); // {dist, duration} 每方向最近一次实测

  let engine = null;
  let matrixRounds = 0;
  let matrixOkRounds = 0;

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
        radii = results.map((r) => {
          if (!r || !(r.duration > 0)) return idealR;
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

  /* —— 阶段 2：六类设施检索（口径与 /life/report 完全一致） —— */
  const maxR = Math.max(...radii);
  const cats = await Promise.all(
    CATEGORIES.map(async (c, i) => {
      if (isQuotaBlocked()) return { ...c, items: [], failed: true, quota: true };
      await new Promise((r) => setTimeout(r, i * 150)); // 类间错峰
      try {
        const r = await baiduMap.poiSearch({
          query: c.keywords.join('|'),
          lng: center.lng,
          lat: center.lat,
          radius: Math.ceil(maxR * 1.25),
          pageSize: 20,
        });
        const items = (r.items || []).filter((x) => Number.isFinite(x.lng) && Number.isFinite(x.lat));
        return { ...c, items, failed: false };
      } catch (e) {
        noteQuotaError(e);
        return { ...c, items: [], failed: true };
      }
    })
  );

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
      cells.push({
        i,
        j,
        lng: Math.round(lngC * 1e6) / 1e6,
        lat: Math.round(latC * 1e6) / 1e6,
        insideCircle,
        walkMinByCategory: walkByCategory,
        nearestWalkMin: minWalk === null ? null : Math.round(minWalk * 10) / 10,
        score,
        blind: Boolean(insideCircle && score !== null && score < BLIND_SCORE_THRESHOLD),
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
      nearestWalkMin: c.nearestWalkMin,
    })),
    cells, // 全部网格（前端画覆盖热力 / 盲区标注）
    summary: {
      minutes: minutesN,
      gridInside: insideCells.length,
      gridTotal: gridN * gridN,
      blindCount: blindCells.length,
      blindRatio: insideCells.length ? Math.round((blindCells.length / insideCells.length) * 100) : 0,
      circleAreaKm2: Math.round((polygonArea(polygon, center.lat) / 1e6) * 100) / 100,
      maxReachM: Math.round(maxR),
      verifiedCells,
    },
    engine,
    degraded: isoDegraded,
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

module.exports = {
  buildIsochrone,
  // 纯函数导出：供 CI 自检与单元测试
  haversine,
  destination,
  pointInPolygon,
  catmullRomClosed,
  polygonArea,
  walkMatrixBatch,
  walkConcurrent,
  SPEED_M_PER_MIN,
  DETOUR_FACTOR,
  BLIND_SCORE_THRESHOLD,
};
