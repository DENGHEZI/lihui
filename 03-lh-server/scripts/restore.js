#!/usr/bin/env node
/**
 * 鲤慧 LiHui · 恢复 CLI（灾难恢复 / 每月演练用）
 *
 * 用法：
 *   node scripts/restore.js <备份名>            # 如 2026-10-09T03-30-00
 *   node scripts/restore.js list               # 查看可恢复的备份列表
 *
 * 恢复后请重启服务（json 存储有内存态；sqlite 建议一并停写后恢复）。
 * ⚠️ 恢复只覆盖 manifest 清单内的文件，清单外文件不会被触碰或删除。
 */
process.env.LH_CLI = '1';
const backup = require('../src/services/backup');

const arg = process.argv[2] || '';
if (!arg || arg === 'list') {
  const rows = backup.list();
  console.log(rows.length ? rows.map((r) => `${r.name}  files=${r.files}  ${(r.bytes / 1024).toFixed(1)}KB`).join('\n') : '（暂无备份）');
  process.exit(0);
}

try {
  const r = backup.restore(arg);
  const bad = r.results.filter((x) => !x.ok);
  console.log(JSON.stringify({ ok: bad.length === 0, name: r.name, restored: r.restored, total: r.total, failed: bad }, null, 2));
  console.log('提示：请重启服务使恢复的数据生效。');
  process.exit(bad.length ? 1 : 0);
} catch (e) {
  console.error('恢复失败:', e.message);
  process.exit(1);
}
