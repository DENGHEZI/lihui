/**
 * Memory 脱敏自测 —— 「绝密不出网」回归
 * 断言：真实 Key / 内网 IP / 本机网卡地址 在 sanitize 输出中绝不出现。
 * 运行：node tests/sanitize.test.js
 */
'use strict';
const os = require('os');
const { sanitize } = require('../src/services/memory');

let pass = 0;
let fail = 0;
function assert(name, cond) {
  if (cond) { pass += 1; console.log('  OK  ' + name); }
  else { fail += 1; console.log('  FAIL ' + name); }
}

// 样本：伪造值 + 一个典型 sk- 形态真值(会话中常见的 DeepSeek key 形态)
const SAMPLE_SK = 'sk-b32eec4a5ef8415d8be044ce1c85436a';
const SAMPLE_AK = 'Gx8yZqLmN0pR4tVwXyZ9aBcDeFgHiJkL'; // 32 位百度 AK 形态
const PRIV_IP = '192.168.1.34';
const PUB_IP = '203.0.113.88';
const DEV_ID = 'wx_9f8e7d6c5b4a3210fedcba9876543210abcdef98';

const input = [
  'Authorization: Bearer ' + SAMPLE_SK,
  'ak=' + SAMPLE_AK,
  'GET /api/life/isochrone from ' + PRIV_IP,
  '来源公网段 ' + PUB_IP + ' 每 50ms 一次请求',
  'device=' + DEV_ID,
  '蜜罐命中 ak=' + SAMPLE_AK + ' 来自 ' + PRIV_IP,
  'debug dump 中泄漏裸 key: ' + SAMPLE_AK,
].join('\n');

const { text, report } = sanitize(input);

console.log('— 脱敏报告 —');
console.log(JSON.stringify(report));

console.log('— 断言 —');
assert('sk- 真值被掩码(不出现原值)', !text.includes(SAMPLE_SK));
assert('sk- 掩码保留首尾形态', text.includes('sk-b3***') && text.includes('436a'));
assert('32 位 AK 被掩码', !text.includes(SAMPLE_AK) && text.includes('AK***'));
assert('ak= 参数被掩码', (text.match(/ak=\*\*\*/g) || []).length === 2);
assert('内网 IP 整段抹掉', !text.includes(PRIV_IP) && text.includes('<内网IP>'));
assert('公网 IP 只留前两段(源段可分析)', text.includes('203.0.*.*') && !text.includes(PUB_IP));
assert('设备 ID 被掩码', !text.includes(DEV_ID) && text.includes('<设备ID>'));

// 双保险：本机所有真实网卡地址逐个替换
const locals = [];
for (const ni of Object.values(os.networkInterfaces())) {
  for (const a of ni || []) if (a.address && a.address !== '::1' && a.address !== '0.0.0.0') locals.push(a.address);
}
if (locals.length) {
  const t2 = sanitize('本机地址是 ' + locals.join(' 和 ')).text;
  const leaked = locals.filter((a) => t2.includes(a));
  assert('本机全部网卡地址(' + locals.length + ' 个)不出网', leaked.length === 0);
} else {
  console.log('  SKIP 本机网卡地址双保险(无可用地址)');
}

assert('report.ips 计数正确(内网×2+公网×1)', report.ips === 3);
assert('report.keys 计数正确(sk×1+ak=×2)', report.keys === 3);
assert('report.akLike 计数正确(裸 32 位×1)', report.akLike === 1);

console.log('');
console.log('RESULT: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
