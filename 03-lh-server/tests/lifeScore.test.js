/**
 * 鲤慧 LiHui · 生活圈评分单测（2026-10-10 评分 BUG 修复回归）
 * 覆盖：
 *  1. dedupePOIs：uid 去重 / 同名同址跨 uid 脏数据合并 / 同名不同址连锁分店保留 / 脏输入
 *  2. scoreCategory：重复 POI 不再推高数量达标度（BUG 修复对照）+ failed → null + count 为去重数
 *  3. scoreSummary：真实权重归一化 + 失败类剔除
 *  4. standards.json categoryWeights：五部标准权重和=1、键完整、lifeShared.CATEGORIES 默认权重和=1
 */
process.env.LH_DATA_DIR = require('os').tmpdir() + '/lh_test_life_' + Date.now();
const assert = require('assert');
const {
  CATEGORIES, dedupePOIs, scoreCategory, scoreSummary,
} = require('../src/services/lifeShared');
const standardsData = require('../data/standards.json');

let pass = 0, failCount = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓', name); }
  catch (e) { failCount++; console.error('  ✗', name, '->', e.message); }
}

/* ---------- 1. dedupePOIs ---------- */
console.log('dedupePOIs');
t('同 uid 重复 POI 合并为 1', () => {
  const items = [
    { uid: 'u1', name: '老百姓大药房', lng: 112.0001, lat: 27.7001 },
    { uid: 'u1', name: '老百姓大药房', lng: 112.0001, lat: 27.7001 },
  ];
  assert.strictEqual(dedupePOIs(items).length, 1);
});
t('同名同址不同 uid（脏数据）合并为 1', () => {
  const items = [
    { uid: 'a1', name: '焰色餐饮店', address: '大街3号', lng: 112.99901, lat: 25.79901 },
    { uid: 'b2', name: '焰色餐饮店', address: '大街3号', lng: 112.99902, lat: 25.79902 },
  ];
  assert.strictEqual(dedupePOIs(items).length, 1);
});
t('同名不同址连锁分店保留', () => {
  const items = [
    { uid: 'a1', name: '新佳超市', lng: 112.0001, lat: 27.7001 },
    { uid: 'a2', name: '新佳超市', lng: 112.0500, lat: 27.7500 },
  ];
  assert.strictEqual(dedupePOIs(items).length, 2);
});
t('不同 uid 不同名同址保留（同一楼栋不同业态）', () => {
  const items = [
    { uid: 'a1', name: '肯德基', lng: 112.0001, lat: 27.7001 },
    { uid: 'a2', name: '中国联通营业厅', lng: 112.0001, lat: 27.7001 },
  ];
  assert.strictEqual(dedupePOIs(items).length, 2);
});
t('脏输入（null / 非数组）不抛错', () => {
  assert.strictEqual(dedupePOIs(null).length, 0);
  assert.strictEqual(dedupePOIs('x').length, 0);
  assert.strictEqual(dedupePOIs([null, undefined, { uid: 'u1', name: 'x', lng: 1, lat: 1 }]).length, 1);
});

/* ---------- 2. scoreCategory（BUG 修复对照） ---------- */
console.log('scoreCategory');
const medical = CATEGORIES.find((c) => c.key === 'medical'); // need=2, keywords 3 个
t('重复 uid 不再推高数量达标度（修复前 4 条重复→100 分，修复后真实 2 家→73 分）', () => {
  const dup = (uid) => ({ uid, name: '市第一医院', tag: '医疗', type: '医院', lng: 112.001, lat: 27.7 });
  const items = [dup('a'), dup('a'), dup('a'), dup('a')]; // 同一家医院被重复收录 4 次
  const r = scoreCategory(medical, items, false);
  assert.strictEqual(r.count, 1); // 去重后 1 家
  // ratio = min(1, 1/2)=0.5 → 0.6*50=30；typeRatio=1/3 → 0.4*33.33=13.33 → 43
  assert.strictEqual(r.score, 43);
});
t('真实 2 家不同医院 → 数量达标（ratio=1）', () => {
  const items = [
    { uid: 'a', name: '市第一医院', type: '医院' },
    { uid: 'b', name: '仁爱诊所', type: '诊所' },
  ];
  const r = scoreCategory(medical, items, false);
  assert.strictEqual(r.count, 2);
  assert.strictEqual(r.score, Math.round((1 * 0.6 + (1 / 3) * 0.4) * 100)); // 73
});
t('failed → score=null 但仍返回去重 count', () => {
  const r = scoreCategory(medical, [], true);
  assert.strictEqual(r.score, null);
  assert.strictEqual(r.count, 0);
});
t('同名同址脏数据计入前被合并（count 不虚高）', () => {
  const items = [
    { uid: 'a', name: '仁爱诊所', address: 'X路1号', lng: 112.1, lat: 27.7 },
    { uid: 'b', name: '仁爱诊所', address: 'X路1号', lng: 112.10001, lat: 27.70001 },
    { uid: 'c', name: '市第一医院', address: 'Y路2号', lng: 112.2, lat: 27.71 },
  ];
  const r = scoreCategory(medical, items, false);
  assert.strictEqual(r.count, 2);
  assert.strictEqual(r.score, 73);
});

/* ---------- 3. scoreSummary（真实权重归一化） ---------- */
console.log('scoreSummary');
t('按传入真实权重加权（medical 0.5 / market 0.3 / food 0.2）', () => {
  const cats = [
    { name: '医疗', weight: 0.5, need: 2, score: 80, count: 2 },
    { name: '商业', weight: 0.3, need: 2, score: 60, count: 2 },
    { name: '餐饮', weight: 0.2, need: 3, score: 40, count: 1 },
  ];
  const r = scoreSummary(cats);
  assert.strictEqual(r.score, Math.round(80 * 0.5 + 60 * 0.3 + 40 * 0.2)); // 66
  assert.strictEqual(r.level, '良好');
});
t('失败类（score=null）剔除后权重重新归一化', () => {
  const cats = [
    { name: '医疗', weight: 0.5, need: 2, score: 100, count: 2 },
    { name: '商业', weight: 0.5, need: 2, score: null, count: 0 },
  ];
  const r = scoreSummary(cats);
  assert.strictEqual(r.score, 100);
});
t('全部失败 → 0 分不抛错', () => {
  const r = scoreSummary(CATEGORIES.map((c) => ({ ...c, score: null, count: 0 })));
  assert.strictEqual(r.score, 0);
});

/* ---------- 4. 真实权重数据校验 ---------- */
console.log('standards categoryWeights');
const KEYS = ['medical', 'transit', 'market', 'education', 'food', 'leisure'];
for (const s of standardsData.items) {
  t(`${s.id} categoryWeights 键完整且和=1`, () => {
    const w = s.metrics && s.metrics.categoryWeights;
    assert.ok(w, '缺 categoryWeights');
    KEYS.forEach((k) => assert.ok(Number.isFinite(Number(w[k])) && Number(w[k]) > 0, `缺键 ${k}`));
    const sum = KEYS.reduce((a, k) => a + Number(w[k]), 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, `权重和 ${sum} ≠ 1`);
    assert.ok(w.note && w.note.length > 8, '缺 weightNote 出处说明');
  });
}
t('lifeShared.CATEGORIES 默认权重和=1（回落口径自洽）', () => {
  const sum = CATEGORIES.reduce((a, c) => a + c.weight, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
});
t('standards.resolve() 透出 categoryWeights（城市命中链路）', () => {
  // 隔离环境默认走 FALLBACK 国家标准（也带真实权重）
  const standards = require('../src/services/standards');
  let r = standards.resolve('深圳市');
  assert.ok(r.standard.metrics.categoryWeights, 'resolve 未透出权重');
  if (r.matched) {
    // 数据层可用时应命中深圳标准（轨道主导，transit 权重最高 0.28）
    assert.strictEqual(r.standard.id, 'shenzhen-2035');
    assert.strictEqual(r.standard.metrics.categoryWeights.transit, 0.28);
  } else {
    // 数据缺失时回落国家标准权重（transit 0.2），仍是有出处的真实权重
    assert.strictEqual(r.standard.metrics.categoryWeights.transit, 0.2);
    console.log('  ℹ standards 数据未入隔离目录，验证的是 FALLBACK 权重链路');
  }
});

console.log(`\n结果: ${pass} 通过, ${failCount} 失败`);
process.exit(failCount ? 1 : 0);
