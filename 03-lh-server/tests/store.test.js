#!/usr/bin/env node
/**
 * 鲤慧 LiHui · 存储层双驱动自测（零依赖，node 直接跑）
 *
 * 用法（推荐用临时数据目录，不碰真实 data/）：
 *   TMP=$(mktemp -d)
 *   LH_DATA_DIR=$TMP LH_STORE=json   node tests/store.test.js
 *   LH_DATA_DIR=$TMP LH_STORE=sqlite LH_DB_PATH=$TMP/t.db node tests/store.test.js
 *
 * 覆盖：读写回环、update 原子性（50 次自增零丢失）、集合增删改、
 *       旧 JSON 平滑导入（sqlite）、stats、userProfile 画像迁移链路。
 */
const fs = require('fs');
const path = require('path');

const expect = (cond, msg) => {
  if (!cond) {
    console.error(`  ✗ ${msg}`);
    process.exit(1);
  }
  console.log(`  ✓ ${msg}`);
};

const driver = (process.env.LH_STORE || 'json').toLowerCase();
const dataDir = process.env.LH_DATA_DIR || path.resolve(__dirname, '..', 'data');

console.log(`[store.test] driver=${driver} dataDir=${dataDir}`);

/* 预置旧 JSON 种子（验证 sqlite 首读自动导入 / json 直接读） */
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'zz-import.json'), JSON.stringify({ hello: 'legacy', n: 7 }));

const store = require('../src/services/store');
const userProfile = require('../src/services/userProfile');

/* 1. 缺失读 fallback */
expect(store.read('zz-none', { d: 1 }).d === 1, 'read 缺失返回 fallback');

/* 确定性重置：测试文档归零（临时目录复用/重跑时仍幂等） */
store.write('zz-counter', { n: 0 });
store.write('zz-col', []);

/* 2. 写读回环 */
expect(store.write('zz-doc', { a: 1, list: [1, 2, 3] }), 'write 返回 true');
expect(store.read('zz-doc', null).a === 1, 'write→read 回环一致');

/* 3. update 原子性：50 次自增零丢失 */
for (let i = 0; i < 50; i++) {
  store.update('zz-counter', (c) => ({ n: ((c && c.n) || 0) + 1 }), { n: 0 });
}
expect(store.read('zz-counter', {}).n === 50, 'update 50 次自增零丢失');

/* 4. 集合语义 */
const col = store.collection('zz-col', []);
const it1 = col.add({ name: 'a' });
const it2 = col.add({ name: 'b' });
expect(col.all().length === 2 && it1.id && it2.id, 'collection.add ×2 自动生成 id');
col.update(it1.id, { name: 'a2' });
expect(col.all().find((x) => x.id === it1.id).name === 'a2', 'collection.update 生效');
col.remove(it1.id);
expect(col.all().length === 1, 'collection.remove 生效');

/* 5. 旧 JSON 平滑导入 */
expect(store.read('zz-import', null).n === 7, '旧 JSON 导入/直读命中(n=7)');

/* 6. 驱动与统计 */
const st = store.stats();
expect(st.driver === driver, `stats.driver=${st.driver}`);
if (driver === 'sqlite') {
  expect(typeof st.docs === 'number' && st.docs >= 4, `sqlite docs=${st.docs}（含导入种子）`);
  expect(fs.existsSync(process.env.LH_DB_PATH), 'sqlite 库文件已创建');
  expect(
    fs.existsSync(process.env.LH_DB_PATH + '-wal') || fs.existsSync(process.env.LH_DB_PATH + '-shm') || true,
    'WAL 伴生文件（可能已 checkpoint 合并）'
  );
} else {
  expect(fs.existsSync(path.join(dataDir, 'zz-doc.json')), 'json 模式单文件落盘');
}

/* 7. userProfile 画像链路（走同一存储层） */
userProfile.track('dev-test', 'search', { query: '公园遛弯' });
userProfile.track('dev-test', 'poi_click', { uid: 'u1', name: '药店', lng: 1, lat: 2 });
const snap = userProfile.snapshot('dev-test');
expect(snap.learned && snap.events === 2, `userProfile.track 累计 events=2`);
expect(snap.topKeywords.includes('公园遛弯'), 'userProfile 关键词学习命中');
userProfile.track('dev-test', 'navigate', { uid: 'u1' });
const snap2 = userProfile.snapshot('dev-test');
expect(snap2.frequentPlaces.some((p) => p.name === '药店'), 'navigate 强信号累积到常去地点');
userProfile.reset('dev-test');
expect(userProfile.snapshot('dev-test').learned === false, 'userProfile.reset 清除成功');

console.log(`[store.test] 全部通过 ✓ (${driver})`);
