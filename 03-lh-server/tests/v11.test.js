/**
 * V1.1 单元自检：养老业态细分 / 测试号识别 / 骑行等时圈口径
 * 运行：node tests/v11.test.js
 */
const assert = require('assert');
const { elderBizBreakdown } = require('../src/services/lifeShared');
const { isTestUser } = require('../scripts/clean-test-users');
const { TRAVEL_MODES } = require('../src/services/isochrone');

let passed = 0;
function ok(name, cond) {
  if (!cond) {
    console.error('  ✗ ' + name);
    process.exit(1);
  }
  passed++;
  console.log('  ok - ' + name);
}

/* ---- elderBizBreakdown ---- */
const items = [
  { name: '株洲市天元区敬老院', address: '', distance: 580 },
  { name: '幸福社区老年食堂', address: '', distance: 300 },
  { name: '阳光日间照料中心', address: '幸福路', distance: 700 },
  { name: '康宁养老服务中心', address: '', distance: 900 },
  { name: '蜜雪冰城', address: '', distance: 120 }, // 不该计入任何业态
];
const biz = elderBizBreakdown(items);
const meal = biz.find((b) => b.key === 'meal');
const care = biz.find((b) => b.key === 'care');
const wellness = biz.find((b) => b.key === 'wellness');
ok('助餐命中老年食堂', meal.count === 1 && meal.nearest.name === '幸福社区老年食堂');
ok('照料命中日间照料+养老服务中心', care.count === 2);
ok('康养命中敬老院+养老服务中心', wellness.count === 2 && wellness.nearest.name === '株洲市天元区敬老院');
ok('空列表全为 0 且不抛错', elderBizBreakdown([]).every((b) => b.count === 0 && b.nearest === null));

/* ---- isTestUser ---- */
ok('uitest_ 前缀命中', isTestUser({ username: 'uitest_abc', role: 1 }));
ok('e2euser_ 前缀命中', isTestUser({ username: 'e2euser_123', role: 1 }));
ok('smoke 前缀命中', isTestUser({ username: 'smokeagg01', role: 1 }));
ok('tester+数字 命中', isTestUser({ username: 'tester01', role: 1 }));
ok('普通用户不命中', !isTestUser({ username: 'zhangsan', role: 1 }));
ok('admin 永不命中', !isTestUser({ username: 'uitest_admin', role: 2 }));
ok('播种管理员永不命中', !isTestUser({ username: 'uitest_x', role: 1, seeded: true }));

/* ---- TRAVEL_MODES ---- */
ok('步行速度 80m/min', TRAVEL_MODES.walking.speed === 80);
ok('骑行速度 200m/min 且端点为 routematrix riding', TRAVEL_MODES.riding.speed === 200 && TRAVEL_MODES.riding.endpoints[0].path === '/routematrix/v2/riding');
ok('公交无批量矩阵接口，不提供（诚实口径）', !TRAVEL_MODES.transit);

console.log(`\nv11.test.js: ${passed} passed`);
