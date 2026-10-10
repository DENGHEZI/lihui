/**
 * 等时圈引擎数学自测（零依赖，node tests/isochrone.test.js）
 * 只测纯函数的数学性质，不触发任何网络请求 —— CI 可安全运行。
 */
const assert = require('assert');
const {
  haversine,
  destination,
  pointInPolygon,
  catmullRomClosed,
  polygonArea,
  SPEED_M_PER_MIN,
  DETOUR_FACTOR,
} = require('../src/services/isochrone');

let passed = 0;
function t(name, fn) {
  fn();
  passed++;
  console.log('  ok - ' + name);
}

/* ---- haversine ---- */
t('haversine: 同点为 0', () => {
  assert.strictEqual(haversine(113.014, 25.57, 113.014, 25.57), 0);
});
t('haversine: 北京→上海 ≈ 1067km（±60km 容差）', () => {
  const d = haversine(116.404, 39.915, 121.473, 31.231);
  assert.ok(Math.abs(d - 1067000) < 60000, 'got ' + d);
});
t('haversine: 对称性', () => {
  const a = haversine(113.0, 25.5, 113.5, 26.0);
  const b = haversine(113.5, 26.0, 113.0, 25.5);
  assert.ok(Math.abs(a - b) < 0.5);
});

/* ---- destination ---- */
t('destination: 正北 1000m，球面距离自洽', () => {
  const p = destination(113.014, 25.57, 0, 1000);
  const d = haversine(113.014, 25.57, p.lng, p.lat);
  assert.ok(Math.abs(d - 1000) < 2, 'got ' + d);
});
t('destination: 正北移动 lng 不变、lat 增', () => {
  const p = destination(113.014, 25.57, 0, 1000);
  assert.strictEqual(p.lng, 113.014);
  assert.ok(p.lat > 25.57);
});
t('destination: 东西南北 1000m 等距', () => {
  const base = [113.014, 25.57];
  const dists = [0, 90, 180, 270].map((b) => {
    const p = destination(base[0], base[1], b, 1000);
    return haversine(base[0], base[1], p.lng, p.lat);
  });
  for (const d of dists) assert.ok(Math.abs(d - 1000) < 2);
});

/* ---- pointInPolygon ---- */
const square = [
  { lng: 113.0, lat: 25.5 },
  { lng: 113.1, lat: 25.5 },
  { lng: 113.1, lat: 25.6 },
  { lng: 113.0, lat: 25.6 },
];
t('pointInPolygon: 圆心内 true', () => {
  assert.strictEqual(pointInPolygon(113.05, 25.55, square), true);
});
t('pointInPolygon: 圆外 false', () => {
  assert.strictEqual(pointInPolygon(113.2, 25.55, square), false);
  assert.strictEqual(pointInPolygon(112.9, 25.7, square), false);
});
t('pointInPolygon: 凹多边形（L 形）正确', () => {
  const lShape = [
    { lng: 0, lat: 0 }, { lng: 2, lat: 0 }, { lng: 2, lat: 1 },
    { lng: 1, lat: 1 }, { lng: 1, lat: 2 }, { lng: 0, lat: 2 },
  ];
  assert.strictEqual(pointInPolygon(0.5, 0.5, lShape), true);
  assert.strictEqual(pointInPolygon(1.5, 1.5, lShape), false); // L 的缺口
});

/* ---- catmullRomClosed ---- */
t('catmullRomClosed: 4 点 × 8 段 = 32 点', () => {
  const out = catmullRomClosed(square, 8);
  assert.strictEqual(out.length, 32);
});
t('catmullRomClosed: 样条点贴近原控制点（插值性）', () => {
  const out = catmullRomClosed(square, 8);
  // 每个控制点处（t=0）样条应精确过该点：out[0]≈square[0], out[8]≈square[1]...
  assert.ok(Math.abs(out[0].lng - square[0].lng) < 1e-9);
  assert.ok(Math.abs(out[8].lng - square[1].lng) < 1e-9);
});
t('catmullRomClosed: 闭合性（t=0 处精确过每个控制点）', () => {
  const out = catmullRomClosed(square, 8);
  [0, 1, 2, 3].forEach((k) => {
    assert.ok(Math.abs(out[k * 8].lng - square[k].lng) < 1e-9, 'seg ' + k + ' lng');
    assert.ok(Math.abs(out[k * 8].lat - square[k].lat) < 1e-9, 'seg ' + k + ' lat');
  });
});

/* ---- polygonArea ---- */
t('polygonArea: 1km×1km 正方形 ≈ 1e6 ㎡（±3%）', () => {
  const km = (m) => m / 111320; // 度
  const sq = [
    { lng: 113, lat: 25 },
    { lng: 113 + km(1000) * 1, lat: 25 }, // 近似：小范围
    { lng: 113 + km(1000), lat: 25 + km(1000) / Math.cos((25 * Math.PI) / 180) },
    { lng: 113, lat: 25 + km(1000) / Math.cos((25 * Math.PI) / 180) },
  ];
  const a = polygonArea(sq, 25);
  assert.ok(Math.abs(a - 1e6) / 1e6 < 0.03, 'got ' + a);
});

/* ---- 常量口径 ---- */
t('官方口径常量：步速 80m/min、弯曲系数 1.3', () => {
  assert.strictEqual(SPEED_M_PER_MIN, 80);
  assert.strictEqual(DETOUR_FACTOR, 1.3);
});

/* ---- 模块图完整性（循环依赖/导出缺失自检） ---- */
t('模块图完整：lifeShared 与 isochrone 可互相协作', () => {
  const shared = require('../src/services/lifeShared');
  assert.strictEqual(shared.CATEGORIES.length, 7); // 2026-10-10 六类+养老
  assert.ok(typeof shared.fetchCategory === 'function');
  assert.ok(typeof shared.isQuotaBlocked === 'function');
  const routes = require('../src/routes/life');
  assert.ok(typeof routes['GET /life/isochrone'] === 'function', '缺 isochrone 路由');
  assert.ok(typeof routes['GET /life/report'] === 'function');
});

console.log('\n' + passed + ' tests passed');
