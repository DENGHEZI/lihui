/**
 * RRF 融合检索单测（零依赖，node tests/rrf.test.js）
 * 覆盖：分数数学（k=60 论文值）、多通道融合、按 id 去重、自定义 keyOf、脏输入容错。
 * 业务背景：标准知识库 RAG 三通道（BM25/标签/类目先验）靠 rrfFuse 融合排序。
 */
const assert = require('assert');
const { rrfFuse } = require('../src/utils/rrf');

let passed = 0;
function t(name, fn) {
  fn();
  passed++;
  console.log('  ok - ' + name);
}

t('RRF 分数严格按 Σ 1/(k+rank) 计算（k=60）', () => {
  const out = rrfFuse([
    [{ id: 'a' }, { id: 'b' }],
    [{ id: 'b' }, { id: 'c' }],
  ]);
  // a: 通道1第1名 = 1/61；b: 1/61 + 1/62；c: 1/62
  const byId = {};
  out.forEach((x) => (byId[x.item.id] = x.score));
  assert.ok(Math.abs(byId.a - 1 / 61) < 1e-12, 'a=' + byId.a);
  assert.ok(Math.abs(byId.b - (1 / 61 + 1 / 62)) < 1e-12, 'b=' + byId.b);
  assert.ok(Math.abs(byId.c - 1 / 62) < 1e-12, 'c=' + byId.c);
  assert.deepStrictEqual(out.map((x) => x.item.id), ['b', 'a', 'c'], '双通道命中者应排第一');
});

t('同文档多通道命中分数可加（融合优势）', () => {
  const single = rrfFuse([[{ id: 'x' }]])[0].score;
  const fused = rrfFuse([
    [{ id: 'x' }],
    [{ id: 'x' }],
  ])[0].score;
  assert.ok(Math.abs(fused - 2 * single) < 1e-12);
  assert.ok(fused > single);
});

t('自定义 keyOf（元素本身无 id 字段时）', () => {
  const out = rrfFuse([[{ chunkId: 's1' }, { chunkId: 's2' }]], { keyOf: (x) => x.chunkId });
  assert.strictEqual(out[0].item.chunkId, 's1');
  assert.strictEqual(out.length, 2);
});

t('{item, id} 包装形式与裸元素形式等价', () => {
  const wrapped = rrfFuse([
    [{ item: { id: 'a' }, id: 'a' }],
    [{ item: { id: 'a' }, id: 'a' }],
  ]);
  const bare = rrfFuse([
    [{ id: 'a' }],
    [{ id: 'a' }],
  ]);
  assert.ok(Math.abs(wrapped[0].score - bare[0].score) < 1e-12);
});

t('脏输入容错：非数组通道 / null 元素 / 空 id 被跳过，不抛错', () => {
  const out = rrfFuse([null, [], [{ id: 'a' }], [null, { id: '' }, { id: 'b' }], 'not-array']);
  assert.deepStrictEqual(out.map((x) => x.item.id), ['a', 'b']);
});

t('全空输入返回空数组；k 参数可自定义', () => {
  assert.deepStrictEqual(rrfFuse([]), []);
  const out = rrfFuse([[{ id: 'a' }]], { k: 1 });
  assert.ok(Math.abs(out[0].score - 1 / 2) < 1e-12, 'k=1 时 rank1 分数应为 1/2');
});

console.log(`rrf.test.js: ${passed} passed`);
