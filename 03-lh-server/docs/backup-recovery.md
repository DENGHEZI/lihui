# 备份与恢复演练手册（鲤慧 LiHui 服务端）

> Docker 卷持久化 ≠ 备份：卷只解决「容器重建数据还在」，解决不了误删、损坏、
> 误操作覆盖、勒索加密。本服务内置零依赖备份闭环，配合本手册形成可用灾备。

## 1. 备份机制（已内置）

| 项 | 说明 | 环境变量 |
|---|---|---|
| 备份内容 | `data/` 顶层全部 `*.json` + sqlite 库三件套（db/-wal/-shm） | — |
| 备份位置 | `data/backups/<时间戳>/`（gzip + manifest.json，含每个文件 sha256） | — |
| 定时 | 服务内每 24h 一次；启动时若距上次超间隔会补一次 | `LH_BACKUP_INTERVAL_H`（0=关闭） |
| 轮转 | 保留最近 14 份 | `LH_BACKUP_KEEP` |
| 管理端点 | `GET/POST /api/v1/system/backups`、`POST /api/v1/system/backups/restore`（admin） | — |

## 2. 命令行（cron 友好）

```bash
cd 03-lh-server
node scripts/backup.js              # 立即备份
node scripts/restore.js list        # 查看可恢复列表
node scripts/restore.js 2026-10-09T03-30-00   # 恢复指定备份
```

cron 示例（宿主机每天 03:30，独立于服务内定时，双保险）：

```cron
30 3 * * * cd /app/03-lh-server && node scripts/backup.js >> data/logs/backup.log 2>&1
```

## 3. 恢复演练（建议每月一次）

1. **备份**：`node scripts/backup.js`，记下输出里的备份名。
2. **注入故障**：向 `data/shop.json` 写入损坏内容（如 `{"broken":`）。
3. **恢复**：`node scripts/restore.js <备份名>` —— 应看到 sha256 校验通过、文件覆盖成功。
4. **验证**：重启服务 → `curl :8809/api/v1/shop/list` 返回正常商品列表（非空、非 500）。
5. **记录**：在值班表登记演练日期/结果；连续两次演练失败 = P1 事件排查备份链路。

## 4. 边界与注意

- 恢复只覆盖 manifest 清单内的文件，**不会删除**清单外文件（不引入未知内容）。
- json 驱动有内存态：恢复后必须重启服务；sqlite 恢复前先停写（停服务再恢复最稳）。
- 备份目录在 `data/backups/`，随数据卷一起持久化；**异地容灾请另行把该目录同步到
  对象存储/另一台机器**（rclone / rsync 均可，本服务不内置外发，避免把凭据写进代码）。
