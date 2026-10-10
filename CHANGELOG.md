# 更新日志 · Changelog

鲤慧 LiHui —— 15 分钟生活圈智能体检与规划助手。
遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 习惯，按日期倒序记录。

---

## [V1.0.15] · 2026-10-10 · 养老设施检测维度 + 文档体系补齐（贡献指南/路线图）

### 👵 新增第七类「养老」设施检测（`services/lifeShared.js` + `data/standards.json`）
- **口径依据**：《国家积极应对人口老龄化中长期规划》与 TD/T 1062—2021 将「养老服务」列入基础保障型服务要素；原六类口径对养老配套完全盲检。
- **宽词干检索**：关键词 `养老 / 敬老院 / 老年公寓 / 老年食堂 / 日间照料`——「养老」宽词兜底（养老院/养老服务中心/康养中心等名称各异，窄词易漏检），另列四个典型业态补全类型覆盖度；`need=1`（半径内 1 处即达标）。
- **五城权重归一化**：国家标准 medical .22/transit .18/market .18/education .13/food .09/leisure .10/elder .10；上海（elder .09）、长沙（居家养老每百户 ≥30㎡ 折入，elder .09）、深圳（elder .09）、苏州（elder .10）——各城七类权重和保持 1，`note` 均补养老出处。
- **联动面**：等时圈雷达图 N 轴自动扩展、小程序/网页类目列表动态渲染零改动；网页端便民速查新增「🧓 养老」入口；「六类」口径文案全量同步为「七类」。
- 内置 FALLBACK 国家标准同步补权重；测试 lifeScore 22 条全绿（新增养老宽词干/业态覆盖/权重和 3 条）+ isochrone 15 条全绿。

### 📖 文档体系补齐
- **新增 [CONTRIBUTING.md](CONTRIBUTING.md)**：项目结构 / 环境准备 / 分支与提交规范 / 测试要求（含网页单文件三查铁律）/ 代码风格 / 安全隐私红线（AK 不下发、账号锚定矩阵、隐私三权）/ PR 与文档同步义务。
- **新增 [ROADMAP.md](ROADMAP.md)**：已完成台账（V1.0.x 勾选）+ 近期 V1.1（管理端用户管理/报告导出/骑行公交等时圈等）+ 中期 V1.2（多城规范扩充/无障碍维度/配额自治）+ 远期 V2.0（开放 API/多端 APP/社区共建 POI）。
- README §6 文档表挂载两份新文档；§7 参与指引改为「贡献先读指南，方向看路线图」。

## [V1.0.14] · 2026-10-10 · 账号锚定 + 用户数据独立沙箱 + 网页端头像上传

### 🔑 账号锚定（`services/auth.js resolveOwner` + 四路由）
- **数据归属重构**：登录用户一律按 `user:<uid>` 锚定（独立沙箱），未登录按设备匿名键兜底（裸 deviceId，**历史数据零迁移**）；设备/联网信号不再锚定注册用户——换设备登录同一账号，画像 / 配额 / 隐私同意全部跟随账号。
- 接入面：用户画像（`/profile/track|me|reset`）、搜索埋点与个性化排序（`/map/poi/search`）、Agent 对话与识图（`/agent/chat|vision`，含 Token 用量 `tokenMeter`）、隐私同意/撤回/导出/删除（`/privacy/*`，登录态 body.deviceId 被忽略）。
- 响应新增 `ownerType`（user/device）字段，端上可感知当前数据归属。
- 小程序端零改动自动生效（request 已带 Authorization）；网页端此前无登录体系，本次补齐。

### 🌐 网页端：登录 / 注册 / 头像上传（`static/web/index.html`）
- **登录注册浮层**：header 新增「登录 / 注册」入口；登录后展示头像 + 昵称，可退出。api() / apiPost() / 隐私同意横幅自动附带 `Authorization`。
- **头像上传**：点击头像 → 选图 → canvas 居中裁剪压缩 256px（webp 优先/jpeg 回落，≤190KB）→ `POST /auth/profile`；默认「鲤」字回落，头像与昵称小程序端同步显示。
- 服务端头像校验回归：MIME 白名单（png/jpg/webp dataURL）+ 190KB 上限 + 空串清空（`tests/owner.test.js` 10 条全绿：锚定矩阵 6 条 + 头像校验 4 条）。

### 📱 小程序端
- 无需改动：头像上传（wx.chooseMedia→base64→`/auth/profile`）与账号锚定（request 已带 Authorization）均已在 V1.0.12 前具备，服务端升级后自动按账号沙箱生效。

## [V1.0.13] · 2026-10-10 · 评分真实权重 + POI 去重计数 + 体检提速 + README 重写

### ⚖️ 评分修复（`services/lifeShared.js` + `routes/life.js` + `data/standards.json`）
- **POI 去重计数**（新增纯函数 `dedupePOIs`）：第一遍按 uid 去重，第二遍按「名称@量化坐标(~11m)」合并同店不同 uid 的脏数据；同名不同址的连锁分店正常保留。此前重复 POI 直接推高数量达标度（同一医院被重复收录 4 次可白拿一倍分）。
- **真实权重**：`data/standards.json` 五部城市规范（国家标准 TD/T 1062—2021 / 上海 / 长沙 / 深圳 / 苏州）新增 `categoryWeights`（按各规范服务要素分级折算，附 `note` 出处说明）；体检请求带 `city` 时自动匹配适用规范权重，报告透出 `weightSource` / `weightNote`；未收录城市回落国家标准口径。`standards.js` 内置 FALLBACK 同步补权重——数据缺失环境也走有出处的真实权重。
- 单测 `tests/lifeScore.test.js`（19 条全绿）：去重矩阵、BUG 修复对照（重复 uid 4 条→100 分修复后 43 分）、权重归一化、五部标准权重和=1 校验。

### ⚡ 体检提速（`services/lifeShared.js` + `services/isochrone.js`）
- **类内 12s 熔断**：此前单百度请求最坏 9s×2 轮 ≈ 36s/类拖垮整份体检；现单类超时即标记 failed 快速返回。
- **受控并发**：二次确认从 3 关键词全并发收敛为前 2 词（防百度 401 并发超限后的重试雪崩）；类间错峰 200ms→150ms。
- 等时圈 lite 检索入口同样接入去重（与体检评分口径完全一致）。
- 报告缓存键纳入 city（不同城市权重不同，缓存不串味）。

### 📖 README 重写（保留 APIJSON 范式结构）
- 章节骨架（TOC 1-9 / 核心特性 / 架构亮点表）不变；内容更新至 V1.0.13：真实权重与 POI 去重说明、隐私合规三端小节（含 6 端点表）、体检提速口径、功能测试命令、新增环境变量表（隐私/备份/监控）。
- **完善功能测试图片**：等时圈（f03/f04）、智能助手（f07/f09）、商城（f10/f11）四组静态实测帧图补入对应小节——README 图片引用从 9 张增至 15 张，全部经脚本校验存在、无死链。

## [V1.0.12] · 2026-10-09 · 小程序端隐私服务补齐（对齐网页端合规能力）

### 📱 微信小程序（`02-lh-wechat-mp`）
- **隐私中心页**（`pages/privacy/privacy`，新）：版本化隐私政策全文（`GET /privacy/policy`，10 分钟缓存，失败本地摘要兜底）+ 当前同意状态（本地与服务端双查）+ 数据权利自助：同意 / 撤回（停采+删画像）/ 导出（JSON 复制剪贴板）/ 删除（两次确认，不可恢复）。入口：「我的 → 隐私中心」。
- **首次启动同意弹窗**（`utils/privacy.js ensureFirstRun`）：未做过选择才弹（延迟 1.2s 避让定位授权弹窗）；确定=同意（本地+服务端双记），取消=仅基础功能；已同意用户启动时静默补登服务端（幂等）。
- **画像采集前置门控**（`utils/profile.js`）：`track()` 未同意端上直接不采集（与服务端 V1.0.10 门控双保险）；原「个性化推荐」开关（settings 页）仍独立有效。
- 端到端联调：云托管服务端 policy / consent 双记 / 状态查询 / 导出 / 删除全链路实测通过（测试数据已清理）。

## [V1.0.11] · 2026-10-09 · 网页版精确定位（三段式 + 错误归因）

### 🌐 网页版（`src/static/web/index.html`）
- **定位升级三段式**：① 浏览器 GPS 高精度（10s 超时——修复台式机冷启动 >6s 一次超时即掉 IP 的缺陷）→ ② GPS 超时/不可用时改用浏览器网络定位（通常数百米级，仍远好于 IP 城市中心）→ ③ 均失败回落服务端 IP 锚定。
- **错误归因区分**：拒绝授权（code 1）不再空转重试，直接 IP 兜底并给出自救指引（地址栏 🔒/ⓘ → 位置改「允许」→ 刷新 → 重新定位）；超时/不可用则提示「稍后重试或手动选城市」。此前三种失败共用同一句「未授权精确定位」，用户无从补救。
- **定位来源可视化**：定位卡实时显示 `浏览器 GPS · ±xxm` / `浏览器网络定位 · ±xxm` / `IP 锚定 · 城市级`，过程状态（正在精确定位…/GPS 慢，改用网络定位…）全程可见。
- 右上角定位徽标 title 修正为「点击选择城市 / 手动纠正定位」（原「点击重新定位」与实际弹城市选择层的行为不符）。
- **修复隐私同意横幅「无法交互」**：横幅脚本此前未包裹进脚本标签（裸露在主脚本闭合标记之后），浏览器将其当 HTML 文本渲染——页面底部出现代码原文、按钮看似存在但无任何事件绑定，点击无效。现补回包裹 + 按钮绑定判空 + `deviceId` 存在性保护；并注意脚本注释内不得出现 script 标签字面量（HTML 解析器会据此提前断块）。

## [V1.0.10] · 2026-10-09 · 网页版助手下线 + 监控告警/备份恢复/隐私合规 + 业务单测

### 🌐 网页版（`src/static/web/index.html`）
- **智能助手卡片下线**（地图数据源配额受限期间对话质量不达标）：`#aiCard` 与能力卡隐藏，后端 Agent 接口保留，恢复后移除隐藏即可。
- 生活圈体检渲染补上服务端配额提示（`r.hint`）：配额受限时明确显示「今日百度地图检索配额已用完（每日 0 点自动恢复）」，不再让用户对着 0 分困惑。

### 📊 监控告警（`services/monitor.js`，零依赖）
- 主动巡检闭环：CPU/内存（RSS+heap）/MCP 进程存活/Token 配额/HTTPS 证书到期 → 阈值判定（纯函数）→ 告警落库（同 key 去重、自动恢复）→ `ALERT_WEBHOOK_URL` 外发。
- 端点：`GET /system/metrics`、`GET /system/alerts`、`POST /system/alerts/check`（admin）。阈值/间隔全部环境变量可调（`LH_ALERT_*`、`MONITOR_CERT_HOST`）。

### 💾 备份恢复（`services/backup.js` + `scripts/{backup,restore}.js` + `docs/backup-recovery.md`）
- 定期备份（`LH_BACKUP_INTERVAL_H`，默认 24h）gzip + sha256 manifest，轮转保留 `LH_BACKUP_KEEP` 份（默认 14）；恢复逐文件校验 sha256、只覆盖清单内文件。
- 管理端点 `GET/POST /system/backups`、`POST /system/backups/restore`（admin，需 `confirm:"RESTORE"`）；CLI 脚本配合 cron 与每月恢复演练（手册含演练清单）。

### 🔐 隐私合规（`services/privacy.js` + `routes/privacy.js` + `/privacy` 政策页 + 网页版同意横幅）
- 版本化隐私政策（`/api/v1/privacy/policy` + 自包含静态页 `/privacy`，含自助「同意/撤回/导出/删除」按钮）。
- **画像采集前置同意门控**：未同意不采集（`LH_PRIVACY_REQUIRE_CONSENT=false` 可关）；同意/撤回版本化落库。
- 个人权利端点：`POST /privacy/consent`、`POST /privacy/withdraw`、`GET /privacy/export`（可携权）、`POST /privacy/delete`（被遗忘权，需 `confirm:"DELETE"`）。

### 🧪 业务单元测试（零依赖，`node tests/*.test.js`）
- 新增：坐标系换算（GCJ↔BD09 往返闭合/境外直通/脏数据）、RRF 融合检索（k=60 分数数学/多通道融合/脏输入）、生活圈评分纯函数（单类评分/加权归一/等级边界）。
- 生活圈评分逻辑从 `routes/life.js` 抽出为 `lifeShared.scoreCategory / scoreSummary` 纯函数（行为不变），业务口径与单测共用一份实现。
- `.gitignore` 补：`00-设计文档/05-需求对照与交付清单.md`（内部交付文档不入库）与新运行时数据（alerts/consents/backups）。

---

## [V1.0.9] · 2026-10-09 · 项目落地页（仿 AI Helper 版式，明暗 + 中英双语）

### 🌐 落地页（`docs/landing/index.html`，单文件零依赖）
- 仿 [ai-helper](https://xiweicheng.github.io/ai-helper/) 版式：白色默认 + 紫→粉渐变主视觉，顶部导航（核心能力 / 亮点对比 / 典型场景 / 系统预览 / 架构 / 快速开始）+ GitHub / Gitee 入口 + 中文 / English + 🌙 / ☀️ 切换。
- 区块：Hero（徽章 + 渐变大标题 + 数据指标）→ 为什么选鲤慧（传统地图 vs 鲤慧 对比卡）→ 核心能力（12 张能力卡）→ 典型场景（6 张用例卡）→ 系统预览（4 张 GIF，引用 `../readme/{hero,isochrone,shop,assistant}-zh.gif`，加载失败自动回落占位）→ 系统架构（3 张架构卡）→ 快速开始（3 步代码块）→ 页脚。
- **明暗主题**：CSS 变量驱动，`html[data-theme]` 切换，localStorage 持久化（`lh_theme`）。
- **中英双语**：`data-zh` / `data-en` 双属性 + `setLang()` 注入（用 `innerHTML` 以保留条目内嵌 `<code>` 标记），localStorage 持久化（`lh_lang`）。
- 直接双击在浏览器打开即可，无需构建；图片相对路径引用仓库内既有 GIF 资源。

---

## [V1.0.8] · 2026-10-09 · 个人资料：自定义昵称与头像（对接 RBAC 账号体系）

### 👤 服务端（`services/auth.js` / `routes/auth.js` / `app.js`）
- 用户记录新增 `nickname` / `avatar` 字段；`publicUser` 透出二者。
- 新端点 `POST /api/v1/auth/profile`（`ROUTE_ROLE` 施加 `user` 角色）：`{ nickname?, avatar? }` 至少传一个；
  - 昵称 1~24 字符；头像为 png/jpg/webp 的 dataURL，base64 全长 ≤ 256KB（约 190KB 二进制），超限/格式非法直接拒绝，传空串清除头像回落默认「鲤」字；
  - 头像 base64 直存用户记录——量级合适（单枚压缩头像几十 KB）、零文件路由依赖，端上 `<image src="{{dataURL}}">` 直接显示。
- `GET /api/v1/auth/me` 改为从库读实时资料（令牌载荷只含 uid/username/role，资料改动返回最新值）。

### 📱 微信小程序端（`pages/mine/*` / `utils/*`）
- 「我的」页资料卡升级：**点头像换头像、点昵称改名字**（含 ✎ 角标与操作提示）；未登录显示「点击登录」。
- 新增内嵌登录/注册卡（用户名+密码，登录/注册一键切换），对接 `POST /auth/login`、`POST /auth/register`。
- 换头像链路：`wx.chooseMedia`（compressed）→ 大于 200KB 先 `wx.compressImage`(q40) → 读 base64 拼 dataURL → **走 JSON 通道上传（免 uploadFile 域名校验）** → 更新服务端与本地缓存。
- `utils/token.js` 新增登录态存取（`lh_auth`：token + user，含 `patchAuthUser` 局部更新）；`utils/request.js` 全局自动附 `Authorization: Bearer <token>`；`utils/api.js` 新增 `authLogin/authRegister/authMe/authProfile`。
- 进「我的」页静默 `authMe` 同步资料；401 就地清登录态回落匿名。

### ✅ 验证
- E2E：注册 → 未登录改资料 401 → 改昵称/头像 200 → 非法格式拒、超大头像拒、空昵称拒、超长昵称拒 → `/auth/me` 读回含 nickname/avatar。
- 安全套件 **459/459 全绿**（清空历史蜜罐持久化封禁后）。

---

## [V1.0.7] · 2026-10-09 · 外卖平台「联网识别」（美团 / 饿了么 / 抖音）

### 🥡 门店维度外卖平台识别（`services/supplier.js` / `services/catalog.js` / `routes/shop.js`）
- 用户诉求：每个附近门店要能识别「在不在美团 / 饿了么 / 抖音、什么价、什么评分」。
- **硬约束（合规）**：美团 / 饿了么 / 抖音【没有】公开 POI / 店铺检索 API（无商户 / 渠道资质调不了，爬取违反 robots + 小程序审核过不了，见 `06-真实价格接口接入指南.md`）。因此**不能靠逐店自动拉取真实在架状态**——任何「自动识别」都只能来自你自配的 `*_URL` 真实接口。
- **两层设计（诚实不造假）**：
  - ① **静态层（零网络，构建期落库）**：`mapPoi` 给每个门店挂 `platforms` 字段 = 美团 / 饿了么 / 抖音按店名的【搜这家店】公开深链（`verified:false` / `onShelf:null`）。前端展示「去美团 / 饿了么 / 抖音看看这家店」，用户点开即见平台实时在架 / 价格 / 评分——把用户接到平台去亲眼确认，**不编造数据**。
  - ② **实时层（按需 `/shop/identify`，配了 `*_URL` 才联网）**：拉到真实 `onShelf/price/rating` → 标 `verified:true`；接口通但查无此店 → `verified:true`+`onShelf:false`（明确「未上架」）；没配 key → 回落深链（`verified:false`）。**绝不返回假在架 / 假价格**。
- `PLATFORMS` 新增 `eleme`（饿了么）、`douyin`（抖音），各带 `kind:'delivery'` 与公开 `searchUrl` 模板（env 可覆盖为 `*_SEARCH_URL`）；`ctrip` 标 `kind:'travel'`（不参与外卖识别）；`status()` 透出 `kind` 供前端区分。
- 新增 `searchUrlOf` / `platformsOf`（同步链接）/ `identifyPlatforms`（异步核实）三函数；导出 `DELIVERY_PLATFORMS`。
- 新端点 `GET /api/v1/shop/identify?id=b_xxx`：返回该店各外卖平台 `{ onShelf, price, rating, url, verified, searchUrl }`。`/shop/sync`、`/shop/source`、`/shop/item` 返回条目的 `platforms` 字段已含三平台深链。

### ⚠️ 说明
- 无商户 / 渠道 API 时，本能力是「引导式识别」（深链到平台自查），而非「服务端自动识别」。要自动核实，需在 `.env` 配 `MEITUAN_URL` / `ELEME_URL` / `DOUYIN_URL`（及可选 `RATING_PATH`），请求模板仍完全由环境变量驱动、不改代码。
- `/shop/identify` 不在 `ROUTE_ROLE` 表里 → 默认 `guest` 可匿名调用（与 `/shop/price` 一致）。

---

## [V1.0.6] · 2026-10-09 · 店源覆盖度补齐（学校食堂 / 零食很忙 等）

### 🛒 店源检索词表扩充（`services/catalog.js` / `services/shop.js`）
- 用户反馈：附近店源缺**学校食堂、零食很忙**等高频生活场景。根因：原 `QUERIES.near` 仅覆盖酒店/公园/餐厅/火锅/奶茶/小吃/家政/大学，没有食堂/零食/便利店/超市类检索词。
- 新增「便利店超市」类目 `market`（🛒，美团下单）：检索词补 **便利店 / 超市 / 零食 / 水果店**；`food` 补 **食堂 / 早餐 / 咖啡**；`service` 补 **药店**。单次同步 place 检索 14→22 次（结果落盘 1h + 去重 + 内存缓存三道闸，同步频率不变前提下配额可控）。
- `HOT_CITY`（本城热门）同步补 market 词；`build()` 类目排序 `order` 与 `fillMissing` 兜底加 `market`；`shop.js` 静态类目 `CATEGORIES` 加 `market`，避免 `/shop/categories` 与 `/shop/items` 校验挡掉新类目。
- 关于「用美团的库」：美团无公开 POI/店源检索 API（数据在 App 内、需商家资质，爬取违反 robots+用户协议且小程序审核过不了，见 `catalog.js` 注释）。学校食堂/零食很忙 在百度 POI 均有收录，故在现有百度体系内补齐检索词，而非接美团。

### ✅ 验证
- 因百度 place 日配额当时已耗尽（既有「日配额爆」问题，非本次引入），未做真接口召回验证；以 mock `baiduMap.poiSearch` 跑通 `build()` 全链路：22 词全部下发、market 类目正确归便利店/超市/零食/水果店、食堂归入 food。配额恢复（每日 0 点）后强制同步 `force=1` 即见真实门店。

---

## [V1.0.5] · 2026-10-09 · RBAC 用户鉴权 + 角色感知限流

### 🔐 RBAC 用户鉴权（零三方依赖，`services/auth.js` / `routes/auth.js` / `app.js`）
- **三角色最小权限**：`guest(0) < user(1) < admin(2)`；`ROUTE_ROLE` 表对管理/运维端点（安全事件、Memory 分析/核验/决策、MCP 管理、反馈处理、语音配置、统计等）施加最低角色，改一行即可收紧任意路由，C 端（体检/地图/助手/商城）保持匿名可用不破坏既有调用；
- **登录/注册/我**：`POST /auth/login`、`POST /auth/register`（公开仅 user；申请 admin 须已登录管理员；`LH_AUTH_ALLOW_REGISTER=false` 时整体 403）、`GET /auth/me`（需 user）；
- **口令安全**：`crypto.scryptSync` 加盐哈希 + `crypto.timingSafeEqual` 防时序攻击，无明文落盘；
- **无状态令牌**：HMAC-SHA256 签名的不透明 token（类 JWT，载荷含 `iat/exp`，零三方库），`LH_AUTH_SECRET` 作密钥；缺失则退化进程内密钥并告警（重启失效，仅本地开发）；
- **默认管理员播种**：首次启动（`store.collection('users')` 为空）从 `LH_ADMIN_USER/LH_ADMIN_PASS` 播种默认 admin，库内已有用户即跳过，凭据不入库（已由 `.gitignore` 排除 `data/users.json`）；
- **回环豁免默认关闭**：`LH_AUTH_ALLOW_LOOPBACK_ADMIN` 默认 `false`（原默认 true 会让 127.0.0.1 任意匿名=admin，RBAC 形同虚设）；本地无令牌调试才显式开启。Memory 另有 `X-Admin-Token` 兜底，不受影响。

### ⚡ 角色感知限流：令牌桶 + 标准响应头（`app.js`）
- **按身份限速**：`admin 2000rpm/200burst`、`user 300/40`、`guest 60/10` + **单 IP 地板** `120/20` 仅对非回环来源生效（防客户端伪造 `x-device-id` 绕过）；
- **标准头**：每个非探活响应携带 `X-RateLimit-Limit / Remaining / Reset`，超限返回 `429` + `Retry-After`；令牌桶平滑突发，桶过期自动回收；
- **限流与鉴权解耦**：限流键优先用已登录 `uid`，匿名回退 `x-device-id`/IP，回环免 IP 地板。

### 🧪 E2E 安全套件收尾（`tests/security-e2e.mjs`）
- 新增 RBAC/限流断言块：错误密码→401、无令牌→401、默认管理员→200+token、注册 user→200+token、user 令牌访问 admin 端点→403、响应含 `X-RateLimit-*`、固定 device-id 打满→429；
- 修复既有误报：蜜罐用例原本在 RBAC 断言前把 loopback 自封导致后续全 403，已移至套件末尾；`/map/ak-status` 提示文案去掉字面 `BAIDU_AK=` 避免命中密钥正则；XSS 回显断言收窄到 `text/html` 语境（JSON API 回显用户输入非漏洞）；坏 JSON 由 500 改为 400；
- 现状：**459/459 全绿**（含 RBAC/限流，五条铁律）。

### 📝 文档
- README（中/英）核心特性、架构亮点、安全生态补充 RBAC + 限流；快速上手加管理员登录示例与关键环境变量表；常见问题加 RBAC 条目。

---

## [V1.0.0] · 2026-10-07 · 首个正式发行版

**发行版内容（自 V1.0.0 起按语义化版本发布）：**

- 🐟 微信小程序端（测试版已上传微信平台 1.0.0，总包 217.9 KB）：地图主页 / 生活圈体检 / 步行等时圈 / 商城 / 多模态识图 / 语音对话与播报 / Memory
- 🌐 网页版 Premium 仪表盘（定位 → 天气 → 体检 → 等时圈 → 速查 → 店源 → 能力全景 → Memory）
- 🗺 百度底图测试页 `/map-home`（Referer 代理 + 瓦片代理，AK 零下发）
- 🛡 密钥零暴露体系：蜜罐假密钥 / 脱敏出网 / 服务端代理 / /health 探针
- 🧠 Memory 人机协同安全运维 + 用户画像学习 + JSON/SQLite 双驱动存储
- 📦 服务端 Node.js 零依赖 · 微信云托管自动构建部署 · 双远程仓库（Gitee / GitHub）

**测试版入口：** 微信扫码 `docs/release/v1.0.0-mp-preview-qr.png` 即打开小程序测试版。

---

## [V1.0.4] · 2026-10-09 · LLMWiki 图扩展 + E2E 安全测试 + 浏览器沙箱 + 体检 SWR 提速

### 🧠 RAG 升级 LLMWiki：词条图 + 一跳扩展检索（`services/standards.js` / `data/standards-kb.json`）
- 知识库从「扁平段落检索」升级为**维基式词条图**：14 部标准互为词条页，`related` 互链成图（知识库版本 `+wiki1`）；
- 检索命中后沿 related **一跳扩展**，把相关标准词条的 TL;DR（summary）作「参见」块注入 LLM 上下文——问 ISO 37120 自动带出 SDG 11 / ISO 37122 关联口径，单次检索跨标准联想；
- 注入块使用要求追加第 4 条（参见条目仅确有关联时简述，防过度引用）；
- 调试接口 `GET /agent/standards` 返回体新增 `wikiSeeAlso`（图扩展结果可视化）；
- 扩词条零代码：kb json 加一条 docs + related 即自动入图。

### 🛡 安全升级：浏览器沙箱隔离 + 海量 E2E 安全测试（`app.js` / `tests/security-e2e.mjs`）
- **浏览器沙箱响应头**（根 HTML / 静态资源 / vendor 三路生效）：CSP（default-src 'self'、img-src 仅放行高德瓦片与 data:、frame-ancestors 'none'）+ `X-Frame-Options: DENY`（防点击劫持）+ `X-Content-Type-Options: nosniff` + `Referrer-Policy` + `Permissions-Policy`（geolocation 仅同源，摄像头/麦克风全禁）——外域注入脚本、iframe 嵌套、追踪像素全部被浏览器侧拒绝；
- **海量 E2E 安全测试套件**（零依赖 `node tests/security-e2e.mjs`）：payload 字典 45 条（SQLi/NoSQLi/XSS/SSTI/路径穿越/命令注入/SSRF/CRLF/原型污染/超长溢出/蜜罐假 key）× 8 端点 × query/body/path 三注入位自动展开 **459 用例**，并发 12 实测 247ms 跑完；断言五条铁律「不 5xx、不泄露密钥、无 XSS 回显、无 CRLF 头污染、蜜罐封禁生效」；溢出类被 Node 头大小限制 RST 拒收识别为预期防护。首跑 **459/459 全绿**。

### ⚡ 生活圈体检二段提速：stale-while-revalidate（`routes/life.js`）
- TTL（10min）过期后的 **30min 宽限期**内命中：**立即返回旧值**（`stale:true` 标注）并后台静默重建——冷启动 1.3s 从用户路径整体摘除；仅宽限期也超时才同步等待重建；
- 重建作业提取为 `buildReportJob`，与并发去重（reportInflight）复用同一函数，双端同页共享一次重建。

---

## [V1.0.3] · 2026-10-08 · 网页版实景化 + RAG 标准库 + AK 池自愈

**本版概要（小程序测试版已上传 1.0.3；服务端同 commit 随 Gitee push 自动部署云托管）：**

- 🐟 网页版等时圈内嵌真实地图（Leaflet + 高德 GCJ-02 瓦片，周边街道建筑全可见）+ 网页版智能助手上线
- 📚 对话接入 RRF 三通道检索 + 14 部国际标准知识库（RAG），回答带「依据：GB 50180-2018…」编号出处
- 🔊 语音播报修复：播放会话令牌锁定当前气泡，彻底解决串音/读错
- 🛒 商城距离真实化（步行矩阵实测）+ 店源覆盖翻倍（41→102 家）
- ⚡ 百度 AK 池：多钥匙自动轮换，配额打满/被停用自动切换，Key 掉线自愈

### 🐟 网页版补齐：等时圈实景地图 + 智能助手（`static/web/index.html` / `app.js`）
- **等时圈真实地图（Leaflet + 高德 GCJ-02 瓦片）**：网页版「步行等时圈」卡片内嵌真实地图——真实街道/湘江/建筑/学校/POI 注记全部可见，等时圈多边形、盲区红格/正常蓝格、家点叠加其上，`fitBounds` 自动取景；**「真实地图 / 示意图」一键切换**；异常自动回落原 SVG 示意图，绝不白屏。
  - 方案演进（踩坑记录）：百度 JS API `qt=vtile` 自定义瓦片层 2026-10-08 起对**任意参数**（改 v/udt/坐标系/带不带 key）一律回 210 字节透明 PNG（256×256，接口改版特征签名）；JS API 默认底图又强依赖「浏览器端 AK」（未配置时脚本 URL 注入蜜罐 key 被瓦片接口拒绝）→ 底图整片空白。
  - 最终方案：**Leaflet 1.9.4 本地化**到 `/vendor/`（app.js 新增 vendor 静态路由 + MIME 补 .js/.css，无 CDN 运行时依赖）+ **高德 appmaptile 栅格瓦片**（免 key、无 Referer 校验、长期稳定），且高德瓦片网格本身就是 **GCJ-02**——与全站统一坐标系零转换直接对齐。
  - app.js 根路径渲染注入 `__AK__`（akBrowser 优先、蜜罐兜底）的机制保留备用。
- **智能助手上线网页版**：新增全功能对话卡片——调用同一 `/agent/chat` 后端（多轮会话 sessionId 持久化 localStorage、定位上下文注入、轻量富化渲染（转义防注入 → `**加粗**` → `<b>`、换行 → `<br>`）、打字机三点动画、常用问法 chips、Enter 发送、错误友好气泡）。
- 能力全景「地图主页/智能助手」改为「✅ 网页版已支持」。

### 📚 RAG 升级：RRF 三通道检索 + 国际标准知识库（`utils/rrf.js` / `services/standards.js`）
- **通用 RRF 工具**（`utils/rrf.js`）：Reciprocal Rank Fusion（k=60，与 baiduMap 复合词融合同参数）——多路检索排名融合的国际标准做法（Cormack et al. 2009），单一通道的字面/语义盲区互相补齐。
- **国际标准知识库**（`data/standards-kb.json`，14 部 31 段权威要点）：GB 50180-2018（生活圈分级国标）、TD/T 1062-2021（社区生活圈规划指南）、上海 15 分钟社区生活圈导则、商务部一刻钟便民生活圈指南、完整社区建设指南、ISO 37120/37101/37122/37170、UN SDG 11、15-Minute City（Moreno）、WHO 步行与健康城市、LEED-ND、BREEAM Communities。
- **三通道 RRF 检索**：BM25-lite（中文 bigram + 编号整词、进程内 IDF）×标签/标题覆盖 ×类目先验 → RRF 融合取 top4（每部标准≤2 段防刷屏）。实测：国际问题命中 ISO、国内问题命中 GB、精确编号命中原文、闲聊零命中零消耗。
- **对话接线**（`services/agent.js` 3c 步）：问题触发词命中（标准/规范/指标/国际/ISO/GB…）→ 检索注入模型上下文，提示词强制「编号只能来自注入原文，禁止凭记忆编造」（大模型对 ISO/GB 编号极易幻觉）；本地兜底路径回复自动附「依据：[n] 标准号《名称》」；`toolCallsLog` 登记 `standards-kb rrf_search`。
- 新增调试接口 `GET /agent/standards?q=`（直接查看 RRF 融合命中与得分）。

### ⚡ 生活圈体检提速（`routes/life.js`）
- 原架构「MCP 先行(8s 限时)→失败才本地」纯串行，最坏 10s+；新架构：**报告级缓存（量化圆心 10min TTL，命中 5.6ms）→ 并发去重（多端同页共享一次计算）→ 本地引擎优先（与等时圈共享 POI 5min 缓存，冷启动实测 1.34s）→ MCP 降级为本地异常兜底（6s 限时）**。

### 💬 聊天对话框美化（小程序）
- 新增零依赖轻量 Markdown 渲染器 `utils/md.js`：`**加粗**` / `- 列表` / `1. 编号` / 分节标题全部结构化，满屏星号的原始文本成为历史。
- 分段卡片化：结论🎯 / 工具结果🔧 / 替代建议💡 / 出行方案🚗 / 省钱方案💰 / 提醒⚠️ 等自动匹配**渐变图标徽章**（小图装饰）+ 强调渐隐线 + 发光列表点 + 编号徽章 + 「🐟 鲤慧为你整理」尾签。
- 明暗主题全适配（CSS 变量）；语音播报同步去除 `**` 星号不再念出来。

### 🧩 MCP 自扩展：不确定时自动从 ModelScope 接入新能力（`services/agent.js`）
- 触发条件：工具全失败 / 回复含「查不到、不确定、建议扩大范围」/ 用户点名联网搜索 / 无匹配工具。
- 动作：提取关键词 → ModelScope MCP 广场检索（离线自动回落内置精选目录）→ 按 Star 数择优 → **自动安装并接入**（npx/uvx/node/HTTP remote-proxy 四通道）→ 工具清单注入模型润色上下文，回复附「🧩 已自动接入 XX」。
- 安全护栏：限时 8s、进程生命周期安装上限 3 个、同包去重、失败静默降级绝不拖垮对话。

### 🔊 语音播报修复：严格锁定当前气泡，不再串音读错（`utils/voice.js`）
- **病灶 1**：`playB64` 固定写死同一个临时文件 `lihui_tts.mp3`——自动播报（每条回复触发）与手动点播并发时互相覆盖文件内容，播着 A 的播放器读到 B 的音频 →「读上面的/读错」。**修复**：每次播放写独立临时文件（递增序号），播完/失败立即删除。
- **病灶 2**：在途 TTS 请求不取消——自动播报晚到后照样开播，顶掉用户手动选中的消息。**修复**：引入**播放会话令牌**（speakToken），任何时刻只有最后一次 `speak` 有权出声，晚到的旧结果一律判 `aborted` 静默作废；`stopSpeak` 同步作废在途请求。
- 手动播放同步剥掉 `**`/`#` 记号再合成（TTS 不念符号）；被新播报抢占时不再误弹「播报没成功」toast。

### 🛒 商城真实化：距离走路实测 + 店源覆盖翻倍（`services/catalog.js` / `routes/shop.js`）
- **距离真实化**：商城距离从「直线距离（鸟飞的）」升级为**真实步行距离 + 步行时长**——复用体检引擎的百度 routematrix 批量矩阵算路，直线 8km 内最近 40 家店实测「步行 198m·约3分钟」，实测后按步行距离重排（隔河/高架的店直线近走路远，直线序会骗人）。配额三防线：只实测前 40 家 / (uid+量化圆心) 缓存 2h（二次查询 1ms）/ 算路与 place 检索配额池独立，失败自动回落直线距离并标记。
- **店源覆盖翻倍**：检索词表每类 2 词 → 3~5 词（补**大学**、奶茶、小吃、风景区、广场、洗衣店、健身房），pageSize 6 → 10，实测单城目录 41 条 → **102 条**（用户点名的湖南工业大学等高校已覆盖）；顺带修复 `fillMissing` 在命中统计前就执行的顺序 bug（兜底词每次白跑）。
- **详情补全（合规版）**：百度 scope=2 详情透传——评分 rating（实测 89/102 条带分）、品类标签并入搜索关键词（搜「中餐」也能命中）、行政区级地址显式标记 `addressEstimated`。**不爬美团**：爬取违反 robots 与用户协议、小程序审核必挂；用「百度详情补全 + 多关键词全覆盖 + 真实步行距离」达成同样效果，「去下单」仍按真实店名跳美团/携程小程序直达。

---

## [2026-10-07] 今日发布

### 🌐 网页版 Premium 改版（`src/static/web/index.html`）
- **仪表盘双栏布局**：主栏（生活圈体检 / 步行等时圈）+ 侧栏（便民速查 / 真实店源），Memory 面板全宽压轴；≤1020px 自动折叠单列。
- **Hero 实时数据胶囊条**：生活圈总分 / 等时圈覆盖分 / 服务盲区格数 / 实时气温，数据加载后自动回填。
- **「能力全景」矩阵**：10 项能力（网页版 4 项 ✅ / 小程序端 5 项 / 双端共用 1 项）一屏总览。
- 视觉升级：卡片顶部流光描边、悬停阴影抬升、h2 竖向强调条、Hero 深海蓝渐变加深、卡片滚动渐入（IntersectionObserver，不支持时自动直出）。
- 兼容性承诺：全部 DOM ID / 类名 / fetch 接口契约不变，纯展示层升级。

### 📷 AI 识图链路（`src/services/vision.js`）
- 多通道实战收敛：百度图像识别 REST（OAuth）→ 千帆 v2（bce-v3 IAM）→ **智谱 GLM-4.6V 定为最终主通道**（用户自有 API，云端实测正常）。
- 复合 Key（`bce-v3/ALTAK-xx/xx`）与 AK+SK（OAuth）双形态鉴权；百度 token 模块级缓存 25 天。
- 蜜罐假密钥防线：命中 `.env.cloud` 蜜罐即告警「🍯 蜜罐命中」并跳过通道。

### 🎙 语音能力（`src/services/voice.js`）
- 播报：Edge TTS 内置零密钥，云端实测 ✅。
- 识别：百度 ASR「有密钥即启用」（engine 门闩移除）；密钥失效错误如实透传 + 修复指引；err_no 全量映射（17/18/3301/216201/6）。

### 🩺 运维与安全
- `/health` 新增 `qianfan` / `voiceAsr` 诊断探针（只回显变量名，不回显值）。
- 商城定位漂移防线：定位状态条（精度/来源/一键重定位）+ `catalog.js` 缓存圆心校验收紧（radius×0.6）。
- 云托管排障经验：改环境变量需新版本注入才生效；Gitee push 静默失败用空提交重推。

---

## [2026-10-06]
- 🧠 Memory 人机协同安全运维：强制脱敏 → DeepSeek 分析（降级本地规则）→ 沙箱验证 → 人工批准产出工件，自动学习闭环；网页版 Memory 面板。
- 🗄 存储层 `store.js` 双驱动：JSON ⇄ SQLite（node:sqlite 零依赖），幂等导入；单机多进程与多实例横向扩就绪。
- 🧠 用户画像自动学习 + 个性化推荐（增量聚合 + 每日衰减，同距离带重排）。
- 🚨 蜜罐危险自动响应分级（L1 封 10min → L2 封 24h → L3 渠道泄露自动轮换蜜罐）。
- 🛡 API 密钥全链路收敛：3 个泄露渠道封堵、服务端代理回传、SSRF 白名单、4 把蜜罐假密钥。
- 🚦 出站令牌桶限流 + in-flight 去重 + JSON 原子写。
- 🗺 地图 3D 视角 + 🌙 全页夜间玻璃拟态。

## [2026-10-05]
- 🌙 夜间/白天双主题（11 页全接入）；📊 体检雷达图；📜 各地管理规范库（评分依据）；🕳 服务盲区识别分析面板；🗺 百度静态图底图模式；🆓 免费基础版定型（ModelScope Qwen 免费推理）；⚡ 等时圈并行计算 + 渐进呈现。

## [2026-10-04]
- ⏱ 等时圈档位化（15/30/45/60 分钟）；💰 订单金额口径统一；📍 地址补查用户共创；📡 定位变化广播；🤖 默认模型切免费 Qwen；🛡 网络降级回落。

---

[2026-10-07]: https://gitee.com/lihui-tech/lihui
