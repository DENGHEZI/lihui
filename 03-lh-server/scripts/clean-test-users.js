#!/usr/bin/env node
/**
 * 鲤慧 LiHui · 遗留测试账号清理（V1.1）
 *
 * 用法：
 *   node scripts/clean-test-users.js            # 预览（只列出，不删）
 *   node scripts/clean-test-users.js --apply    # 实际删除
 *
 * 清理范围（用户名匹配任一模式）：
 *   uitest_*  e2euser_*  smoke*  tester*
 * 永不触碰：播种管理员（seeded）、role=admin。
 *
 * 开机自检：服务启动时调用本模块 checkTestUsers()：
 *   - LH_CLEANUP_TEST_USERS=true → 自动清理并告警；
 *   - 否则只打 warn 提示存量数量与清理命令。
 */
const store = require('../src/services/store');
const logger = require('../src/utils/logger');

const TEST_PATTERNS = [/^uitest_/, /^e2euser_/, /^smoke/, /^tester\d*$/];

function isTestUser(u) {
  if (!u || !u.username) return false;
  if (u.seeded || u.role === 2) return false; // 播种管理员 / admin 永不清理
  return TEST_PATTERNS.some((re) => re.test(u.username));
}

function listTestUsers() {
  const users = store.collection('users', []).all();
  return users.filter(isTestUser).map((u) => ({ id: u.id, username: u.username, createdAt: u.createdAt }));
}

function cleanTestUsers() {
  const victims = listTestUsers();
  if (!victims.length) return { removed: [] };
  const ids = new Set(victims.map((v) => v.id));
  store.collection('users', []).save(
    store.collection('users', []).all().filter((u) => !ids.has(u.id))
  );
  return { removed: victims };
}

/** 开机自检（app.js 启动时调用） */
function checkTestUsers() {
  const victims = listTestUsers();
  if (!victims.length) return;
  if (String(process.env.LH_CLEANUP_TEST_USERS || '').toLowerCase() === 'true') {
    const { removed } = cleanTestUsers();
    logger.warn('auth', `开机自检：已自动清理 ${removed.length} 个遗留测试账号（LH_CLEANUP_TEST_USERS=true）: ${removed.map((u) => u.username).join(', ')}`);
  } else {
    logger.warn('auth', `开机自检：发现 ${victims.length} 个遗留测试账号（${victims.map((u) => u.username).join(', ')}）。清理：node scripts/clean-test-users.js --apply，或设 LH_CLEANUP_TEST_USERS=true 自动清理。`);
  }
}

module.exports = { isTestUser, listTestUsers, cleanTestUsers, checkTestUsers };

/* ---------------- CLI ---------------- */
if (require.main === module) {
  const apply = process.argv.includes('--apply');
  const victims = listTestUsers();
  if (!victims.length) {
    console.log('✅ 没有匹配测试模式的遗留账号，无需清理。');
    process.exit(0);
  }
  console.log(`发现 ${victims.length} 个测试账号：`);
  victims.forEach((u) => console.log(`  - ${u.username}  (id=${u.id}, created=${u.createdAt || '?'})`));
  if (!apply) {
    console.log('\n预览模式（未删除）。确认无误后执行：node scripts/clean-test-users.js --apply');
    process.exit(0);
  }
  const { removed } = cleanTestUsers();
  console.log(`\n🗑️ 已删除 ${removed.length} 个测试账号。`);
}
