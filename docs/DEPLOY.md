# 鲤慧 LiHui · 部署指南（存储与分布式）

> 2026-10-06 存储层升级：所有业务数据统一走 `03-lh-server/src/services/store.js`，
> 支持 **JSON 单文件**（默认，零改动兼容）与 **SQLite**（Node 22.13+ 内置 `node:sqlite`，
> 零 npm 依赖）双驱动，配套单机多进程与多实例横向扩容能力。

## 一、存储驱动：JSON → 数据库

### 为什么默认仍是 JSON

单实例场景下 JSON 文件（`data/*.json`，原子写 tmp+rename）最简单、可 grep、可直接看数据，
是比赛演示与本机开发的最低摩擦形态。**只有多进程 / 多实例需要共享状态时才必须切 SQLite。**

### 切换方式

```bash
# .env 或环境变量
LH_STORE=sqlite          # json（默认）| sqlite
LH_DB_PATH=/app/data/lihui.db   # 默认 data/lihui.db，多实例指向共享卷
```

### 平滑迁移（自动，无需脚本）

- 首次以 `LH_STORE=sqlite` 启动时，把 `data/*.json` 存量（profiles/sessions/tokens/
  feedback/orders/mcp/models/voice/poi/shop/standards/addr-fixes/quota…）**幂等导入**
  SQLite `docs` 表（库里已有的 doc 跳过）；之后 json 文件仅作种子/回退源，SQLite 为权威。
- 启动日志会打印：`存储驱动：sqlite（/app/data/lihui.db，N docs）`。
- `GET /api/v1/health` 返回 `store: { driver, dbPath, docs }`，运维一眼确认当前驱动。

### 回滚

`LH_STORE=json` 重启即回旧存储。⚠️ 切走 SQLite 期间产生的增量**不会**回写 json，
回滚前请先备份库文件（`lihui.db` + `lihui.db-wal` + `lihui.db-shm`）。

### 语义保障（两驱动一致）

| 接口 | 语义 |
|---|---|
| `store.read(name, fallback)` | 缺失/损坏返回 fallback，绝不抛错 |
| `store.write(name, data)` | 原子覆盖（json: tmp+rename / sqlite: upsert） |
| `store.update(name, fn, fallback)` | 原子读改写：json=同步 RMW（单进程）；sqlite=`BEGIN IMMEDIATE` 事务（跨进程安全） |
| `store.collection(name).add/update/remove` | 全部走 update 事务，多进程并发不丢数据 |

## 二、三种部署形态

### 档位 1 · 单机单实例（默认）

现状即默认，什么都不用改。`LH_STORE=json`（或省略）。

### 档位 2 · 单机多进程（利用多核）

```bash
LH_WORKERS=4 LH_STORE=sqlite node src/app.js
```

- 主进程 fork 4 个 worker，`cluster` 共享监听端口、均摊连接；
- worker 崩溃自动拉起替补；
- **必须** `LH_STORE=sqlite`：json 驱动多进程会互相覆盖（last-writer-wins）；
- 每个 worker 各拉一套 MCP 子进程（互为热备，进程轻量；介意可设 `MCP_AUTOSTART=false`）；
- 限流计数（60 次/分/设备）为**进程级**，多 worker 时实际阈值 ≈ 60 × worker 数。

### 档位 3 · 多实例横向扩（多容器 + 共享卷）

```bash
# 每个实例相同配置：
LH_STORE=sqlite
LH_DB_PATH=/app/data/lihui.db   # 指向共享持久卷挂载点
LH_WORKERS=1                    # 实例内不再多进程
```

- **微信云托管**：服务设置 → 实例副本数 ≥2 + 存储 → 挂载 CFS 到 `/app/data`；
- **自建**：nginx upstream 轮询多实例（样例见下）+ 共享盘挂载；
- 跨实例共享的能力：用户画像、会话、订单、反馈、Token 配额、商品/目录缓存、
  IP 封禁表（10s 收敛）、蜜罐轮换（30s 收敛）；
- ⚠️ **共享文件系统注意**：SQLite 依赖文件锁。本地盘/云块存储完全可靠；
  CFS/NFS 类共享盘在写入竞争激烈时可能出现 `SQLITE_BUSY`（已设 5s busy_timeout 重试），
  比赛/演示量级实测可用，生产大流量建议换平台 MySQL（需引入驱动，超出零依赖范围）。

<details>
<summary>nginx upstream 样例</summary>

```nginx
upstream lihui {
    server 10.0.0.11:8809 max_fails=3 fail_timeout=10s;
    server 10.0.0.12:8809 max_fails=3 fail_timeout=10s;
    keepalive 32;
}
server {
    listen 80;
    server_name lihui-tech.online;
    location / {
        proxy_pass http://lihui;
        proxy_set_header X-Real-IP $remote_addr;          # 封禁/限流按真实 IP
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Host $host;
        proxy_http_version 1.1;
    }
}
```

> `clientIp()` 已优先取 `X-Real-IP`/`X-Forwarded-For`，限流与封禁在 LB 后仍按真实来源生效。

</details>

## 三、健康检查与运维

```bash
curl http://127.0.0.1:8809/api/v1/health
# { "service":"lihui-server", "store":{ "driver":"sqlite", "dbPath":"/app/data/lihui.db", "docs":14 },
#   "pid":12, "mcp":{ "total":8, "running":8 }, ... }
```

- `/health`、`/ping`、`/api/v1/health` 三路等价探活；
- 多实例/多 worker 时响应里的 `pid` 可判断是哪个实例在应答；
- 数据库文件：`lihui.db`（主库）+ `-wal`/`-shm`（WAL 伴生，**不要**单独删除）；
  备份时三个文件一起拷贝，或用 `VACUUM INTO 'backup.db'`。

## 四、 checklist：从旧版本升级

1. 拉新代码重启即可 —— 默认 json 驱动，行为与旧版完全一致；
2. 要上多进程/多实例 → 设 `LH_STORE=sqlite`，首次启动观察日志确认「平滑导入 N 个文档」；
3. 确认 `GET /api/v1/health` 的 `store.driver` 与预期一致；
4. 稳定运行一段时间后，旧 `data/*.json` 仅剩种子作用，可归档留底。
