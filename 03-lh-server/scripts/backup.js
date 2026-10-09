#!/usr/bin/env node
/**
 * 鲤慧 LiHui · 手动备份 CLI（配合 cron / 计划任务 / 恢复演练）
 *
 * 用法：
 *   node scripts/backup.js              # 备份到 data/backups/<时间戳>/
 *   LH_DATA_DIR=/data/lh node scripts/backup.js   # 指定数据目录（容器挂载卷场景）
 *
 * cron 示例（每天 03:30）：
 *   30 3 * * * cd /app/03-lh-server && node scripts/backup.js >> data/logs/backup.log 2>&1
 */
process.env.LH_CLI = '1';
const backup = require('../src/services/backup');

const r = backup.create();
console.log(JSON.stringify({ ok: true, name: r.name, dir: r.dir, files: r.files, bytes: r.bytes }, null, 2));
