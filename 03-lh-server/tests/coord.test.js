/**
 * 坐标系换算单测（零依赖，node tests/coord.test.js）
 * 覆盖：GCJ-02↔BD-09 往返闭合、境外直通、脏数据安全转换。
 * 业务背景：混用坐标系会让检索圆心偏 500~900m —— 这是「定位不准」的头号根因。
 */
const os = require('os');
const path = require('path');
process.env.LH_DATA_DIR = process.env.LH_DATA_DIR || path.join(os.tmpdir(), 'lh-test-coord-' + process.pid);

const assert = require('assert');
const { wgs84ToGcj02, gcj02ToWgs84, gcj02ToBd09, bd09ToGcj02, safeBd09ToGcj02 } = require('../src/utils/coord');
const { haversine } = require('../src/services/isochrone');

let passed = 0;
function t(name, fn) {
  fn();
  passed++;
  console.log('  ok - ' + name);
}

const CHANGSHA = { lng: 112.932, lat: 28.228 }; // 长沙五一广场附近（中国大陆内）

t('gcj02→bd09→gcj02 往返闭合误差 < 10m', () => {
  const bd = gcj02ToBd09(CHANGSHA.lng, CHANGSHA.lat);
  const back = bd09ToGcj02(bd.lng, bd.lat);
  const d = haversine(CHANGSHA.lng, CHANGSHA.lat, back.lng, back.lat);
  assert.ok(d < 10, '往返误差 ' + d.toFixed(1) + 'm');
});

t('gcj02↔wgs84 往返闭合误差 < 5m', () => {
  const w = gcj02ToWgs84(CHANGSHA.lng, CHANGSHA.lat);
  const g = wgs84ToGcj02(w.lng, w.lat);
  const d = haversine(CHANGSHA.lng, CHANGSHA.lat, g.lng, g.lat);
  assert.ok(d < 5, '往返误差 ' + d.toFixed(1) + 'm');
});

t('gcj02→bd09 偏移量在合理区间（约 300~1200m，方向固定）', () => {
  const bd = gcj02ToBd09(CHANGSHA.lng, CHANGSHA.lat);
  const d = haversine(CHANGSHA.lng, CHANGSHA.lat, bd.lng, bd.lat);
  assert.ok(d > 300 && d < 1200, '偏移 ' + d.toFixed(0) + 'm');
});

t('境外坐标：wgs↔gcj 直通不做椭球偏移；gcj→bd09 仅加百度常量偏移', () => {
  const ny = { lng: -74.006, lat: 40.7128 };
  const g = wgs84ToGcj02(ny.lng, ny.lat);
  assert.strictEqual(g.lng, ny.lng);
  assert.strictEqual(g.lat, ny.lat);
  const bd = gcj02ToBd09(ny.lng, ny.lat);
  // bd09 定义 = wgs + 固定常量(0.0065, 0.006)；境外只跳过椭球偏移，常量偏移保留
  assert.ok(Math.abs(bd.lng - (ny.lng + 0.0065)) < 1e-9, 'lng=' + bd.lng);
  assert.ok(Math.abs(bd.lat - (ny.lat + 0.006)) < 1e-9, 'lat=' + bd.lat);
});

t('safeBd09ToGcj02：脏数据返回 null，不污染缓存', () => {
  assert.strictEqual(safeBd09ToGcj02('abc', 'def'), null);
  assert.strictEqual(safeBd09ToGcj02(undefined, null), null);
  assert.strictEqual(safeBd09ToGcj02(NaN, Infinity), null);
  const g = safeBd09ToGcj02('112.9385', '28.2340'); // 字符串数字也要能用（POI 落库常是字符串）
  assert.ok(g && isFinite(g.lng) && isFinite(g.lat));
});

t('边界：数值字符串与数字输入结果一致', () => {
  const a = bd09ToGcj02(112.9385, 28.234);
  const b = bd09ToGcj02('112.9385', '28.234');
  assert.ok(Math.abs(a.lng - b.lng) < 1e-9 && Math.abs(a.lat - b.lat) < 1e-9);
});

console.log(`coord.test.js: ${passed} passed`);
