# 贡献指南 · Contributing

鲤慧 LiHui —— 15 分钟生活圈智能体检与规划助手。欢迎 Issue 与 PR！

在动手之前，请先花 3 分钟读完本指南——它能让你的贡献更快被合并。

---

## 1. 项目结构

```
lihui/
├── 03-lh-server/            # 服务端（纯 Node.js 标准库，无 npm install）
│   ├── src/
│   │   ├── app.js           # 入口：node src/app.js 即起
│   │   ├── routes/          # 路由层（profile/map/agent/privacy/life/auth...）
│   │   ├── services/        # 业务层（auth/lifeShared/isochrone/standards...）
│   │   ├── static/web/      # 网页版单页应用（index.html 单文件）
│   │   └── mcp/             # MCP Hub（8 Servers 即插即用）
│   ├── data/                # 版本化数据（standards.json 城市规范等）
│   └── tests/               # 零依赖测试（node tests/xxx.test.js 直跑）
├── 02-lh-wechat-mp/         # 微信小程序（原生框架，微信开发者工具打开）
│   ├── pages/               # 页面（index/map/life/mine/privacy...）
│   └── utils/               # request/token/privacy/api/theme...
├── docs/                    # 项目文档与图集
├── README.md / CHANGELOG.md / ROADMAP.md / CONTRIBUTING.md
```

## 2. 环境准备

- **Node.js ≥ 18**（服务端只用标准库，无需 `npm install`）。
- **百度地图 AK**：申请后配置 `BAIDU_AK` 环境变量（多 AK 池可用逗号分隔）；所有地图能力经服务端中转，**AK 永不下发端上**。
- 启动服务端：

  ```bash
  cd 03-lh-server
  node src/app.js          # 默认端口见 src/app.js，或 PORT=xxxx 指定
  ```

- 小程序端：微信开发者工具打开 `02-lh-wechat-mp/`（项目目录必须精确到含 `app.json` 的那一层）。

## 3. 分支与提交规范

- 主干分支 `master`；功能开发请新建分支：`feat/<主题>`、`fix/<主题>`。
- 提交信息遵循 Conventional Commits，描述用中文、说清「为什么」：

  ```
  feat: 新增养老设施检测维度（七类口径+五城权重归一化）
  fix(mp): 用户ID登录后才编排——未登录不显示设备指纹
  fix(readme): 补入未入库帧图（远端 404 致 G 占位）
  ```

- 一次 PR 聚焦一件事；大改动请先开 Issue 对齐方案。

## 4. 测试要求（合并前必过）

服务端测试零依赖、直跑即验：

```bash
cd 03-lh-server
for f in tests/*.test.js; do node "$f"; done
```

- 修 BUG 必须先补「能复现 BUG」的用例再修（现有先例：`lifeScore.test.js` 里重复 POI 100 分→43 分的修复对照）。
- 新功能必须带单测：纯函数放 `tests/` 对应文件；评分/权重类改动需同步校验「权重和=1」。
- 涉及数据文件（如 `data/standards.json`）的改动，测试里已有键完整性与权重和校验，改完先跑测试。

### 网页版单文件铁律（`static/web/index.html`）

任何对 index.html 的大段插入/删除，提交前自检三件事：

1. **div 平衡**：`<div` 与 `</div>` 计数一致；
2. **关键资源在位**：`leaflet.js` 等资源行未被误删；
3. **JS 可编译**：每个 `<script>` 块用 `new vm.Script(block)` 过一遍。

> 历史教训：HTML 解析器会依据 `</script>` 字面量断块——**内联 JS 的注释里禁止出现 script 标签字面量**。

## 5. 代码风格

- 服务端 **CommonJS + 纯标准库**：新增依赖需在 Issue 里论证（默认拒绝）。
- 注释中文、写「为什么」而不是「是什么」；关键口径（评分权重、达标线、熔断时长）必须注明出处。
- 服务层读不到数据时打 `logger.warn`，**不要静默返回空**（历史踩坑：Dockerfile 漏 COPY 导致「接口 200 但列表空白」）。
- 数组元素的关键字段用前先断言（`isFinite`/存在性），入口启动自检关键 data 文件。

## 6. 安全与隐私红线

- **AK/密钥不下发端上**：地图与 LLM 调用一律经服务端中转；出网响应过脱敏层（`tests/sanitize.test.js` 有专项用例）。
- **用户数据归属**：改动画像/配额/隐私同意等 owner 相关逻辑时，`tests/owner.test.js` 的账号锚定矩阵（`user:<uid>` vs 裸 deviceId）必须全绿；历史匿名数据零迁移是硬约束。
- **隐私三权**：政策 / 同意 / 导出+删除端点行为不得回退；小程序端画像采集必须过 `utils/privacy.js` 的同意门控。

## 7. 提交 PR / Issue

- **Issue**：报 bug 请附系统/浏览器（或微信基础库）版本、复现步骤、截图、服务端日志片段；功能建议请说明使用场景。
- **PR**：面向 [Gitee 仓库](https://gitee.com/deng-he-ziyan/lihui)（主仓，GitHub 同步镜像）；描述里写清改动点、测试结果（贴测试输出）、截图（UI 改动）。
- 合并后请同步更新：`CHANGELOG.md`（新版本条目）、README 对应小节、`ROADMAP.md` 勾选已完成项。

## 8. 文档同步义务

| 改动类型 | 需同步 |
| --- | --- |
| 新功能 / 行为变化 | CHANGELOG 条目 + README 对应小节 |
| 评分口径 / 权重 | `data/standards.json` note 出处 + 测试 + README 架构亮点表 |
| 新环境变量 | README 快速上手的变量表 |
| 接口增删 | README 接口小节 + 测试 |

---

<p align="center">鲤慧 · 让 15 分钟生活圈可度量、可改善。<br>⭐ 觉得有帮助就点个 Star 吧</p>
