/**
 * 鲤慧 LiHui · 账号锚定单测（V1.0.14）
 * 覆盖：
 *  1. resolveOwner：登录= user:<uid>（独立沙箱），loopback 回落设备，匿名= 裸 deviceId（兼容历史数据）
 *  2. body.deviceId 在登录态被忽略（账号锚定优先于设备/联网信号）
 *  3. updateProfile 头像校验回归（MIME 白名单 / 大小上限 / 清空）
 */
process.env.LH_DATA_DIR = require('os').tmpdir() + '/lh_test_owner_' + Date.now();
process.env.LH_PRIVACY_REQUIRE_CONSENT = 'false';
const assert = require('assert');
const auth = require('../src/services/auth');

let pass = 0, failCount = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓', name); }
  catch (e) { failCount++; console.error('  ✗', name, '->', e.message); }
}

/* ---------- 1. resolveOwner 锚定矩阵 ---------- */
console.log('resolveOwner');
t('登录用户 → user:<uid>，body.deviceId 被忽略（账号锚定优先）', () => {
  const req = { headers: { 'x-device-id': 'dev_a' }, auth: { uid: 'u_123', username: 'alice', role: 2 } };
  const o = auth.resolveOwner(req, { deviceId: 'dev_a' });
  assert.strictEqual(o.ownerKey, 'user:u_123');
  assert.strictEqual(o.ownerType, 'user');
  assert.strictEqual(o.userId, 'u_123');
});
t('loopback 调试身份不作为账号 → 设备键兜底', () => {
  const req = { headers: { 'x-device-id': 'dev_b' }, auth: { uid: 'loopback', role: 3 } };
  const o = auth.resolveOwner(req);
  assert.strictEqual(o.ownerKey, 'dev_b');
  assert.strictEqual(o.ownerType, 'device');
});
t('匿名 + X-Device-Id 头 → 裸 deviceId（兼容历史 profiles/consents 数据，零迁移）', () => {
  const req = { headers: { 'x-device-id': 'web_xyz' }, auth: null };
  const o = auth.resolveOwner(req);
  assert.strictEqual(o.ownerKey, 'web_xyz');
  assert.strictEqual(o.ownerType, 'device');
});
t('匿名 + body.deviceId 兜底', () => {
  const req = { headers: {}, auth: null };
  const o = auth.resolveOwner(req, { deviceId: 'dev_from_body' });
  assert.strictEqual(o.ownerKey, 'dev_from_body');
});
t('什么都没有 → anonymous（拒绝采集）', () => {
  const o = auth.resolveOwner({ headers: {} });
  assert.strictEqual(o.ownerKey, 'anonymous');
});
t('空串/匿名 deviceId 归一为 anonymous', () => {
  assert.strictEqual(auth.resolveOwner({ headers: { 'x-device-id': '' } }).ownerKey, 'anonymous');
});

/* ---------- 2. 头像校验回归 ---------- */
console.log('updateProfile avatar');
auth.bootstrapSeed();
const admin = auth.getUserByName('admin');
t('合法 png dataURL 可写入', () => {
  const tiny = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const r = auth.updateProfile(admin.id, { avatar: tiny });
  assert.ok(!r.error, r.error || '');
  assert.ok(r.user.avatar.startsWith('data:image/png'));
});
t('非图片 MIME 被拒', () => {
  const r = auth.updateProfile(admin.id, { avatar: 'data:text/html;base64,PGI+aGk8L2I+' });
  assert.ok(r.error && /png|image/.test(r.error));
});
t('超限头像（>190KB）被拒', () => {
  const big = 'data:image/png;base64,' + 'A'.repeat(300 * 1024);
  const r = auth.updateProfile(admin.id, { avatar: big });
  assert.ok(r.error && /190KB/.test(r.error));
});
t('空串清空头像回落默认', () => {
  const r = auth.updateProfile(admin.id, { avatar: '' });
  assert.ok(!r.error);
  assert.strictEqual(r.user.avatar, '');
});

console.log(`\n结果: ${pass} 通过, ${failCount} 失败`);
process.exit(failCount ? 1 : 0);
