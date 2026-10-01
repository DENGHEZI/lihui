<div align="center">

# 🐟 鲤慧 · LiHui

**基于百度地图开放能力的「15 分钟生活圈」智能体检与规划助手**

*15 分钟，看清你的生活半径。*

![Platform](https://img.shields.io/badge/端-微信小程序_|_Android_|_HarmonyOS_|_iOS-1677FF)
![Server](https://img.shields.io/badge/服务端-Node.js_零依赖-00B96B)
![MCP](https://img.shields.io/badge/MCP-8_Servers_即插即用-FF8A00)
![License](https://img.shields.io/badge/License-MIT-8F959E)

</div>

---

## 📖 项目简介

**鲤慧**是一套「**一码多端 + 服务端中转 + MCP 工具生态**」的地图智能助手：

- 客户端只负责「**呈现 + 采集**」；
- 百度地图能力、大模型调用、MCP 工具调度、Token 计量全部由服务端**统一中转**；
- 从而做到三件事：**AK 不落端、能力可插拔、成本可核算**。

围绕赛题核心「15 分钟生活圈」，鲤慧为每一类人群回答三个问题：

> 🏥 我的生活圈**缺什么**？（六类设施体检评分）
> 🚶 缺的东西**去哪补**？（周边检索 + 路线规划）
> 💬 补的过程**谁帮我**？（AI 助手 · MCP 工具编排 · 语音交互）

---

## 📱 真机一览

| 地图主页 · 便民服务 | 15 分钟生活圈 | 生活圈体检报告 |
|:---:|:---:|:---:|
| ![地图主页](docs/screenshots/01-home-map.jpg) | ![15分钟圈](docs/screenshots/02-home-circle.jpg) | ![体检报告](docs/screenshots/03-life-report.jpg) |

| 个性化生活圈方案 | AI 助手 | Token 用量 · 平台信息 |
|:---:|:---:|:---:|
| ![个性化方案](docs/screenshots/04-life-plan.jpg) | ![AI助手](docs/screenshots/05-assistant.jpg) | ![我的](docs/screenshots/06-mine.jpg) |

---

## ✨ 核心功能

### 🆓 免费基础版（开箱即用，无需任何 Key）

| 功能 | 说明 |
|---|---|
| 📍 **IP 自动锚定** | 端上 GPS 校正 → 百度 IP 定位 → 逆地理补区县 → 内置城市兜底，四级策略链 |
| 🎯 **生活圈体检** | 六类设施加权评分（医疗 25% · 商业 20% · 交通 20% · 教育 15% · 餐饮 10% · 休闲 10%），短板定位 + 步行可达分析 |
| 🔍 **周边便民检索** | 看病买药 / 买菜购物 / 公交地铁 等 8 类一键直达，复合关键词自动拆分检索 |
| 🗺 **路线规划** | 步行 / 骑行 / 驾车（实时避堵）/ 公交四种模式，省钱方案对比 |
| 🗣 **语音交互** | 录音 → 识别 → 播报全链路，自定义音色 / 语速 / 方言 / 唤醒词 |
| 👵 **关怀模式** | 一键适老化：大字号、高对比（WCAG AAA）、慢速语音、单步引导 |
| 💰 **Token 计量** | 按天 / 设备 / 模型聚合记账，配额校验，本机实测 313 Token ≈ ¥0.0004 |

### 🔑 接入 API 后（能力全开）

| 功能 | 说明 |
|---|---|
| 🤖 **AI 助手** | 意图识别 → MCP 工具编排 → 汇总生成人性化回复 + 结构化卡片 |
| 🌐 **多供应商模型** | OpenAI 兼容 / Anthropic / Gemini / Ollama / 百度千帆 / DeepSeek，客户端可视化增删改测 |
| 🧩 **MCP 工具生态** | 8 个 MCP Server 即插即用，支持从 ModelScope 检索安装 |
| ☀️ **天气与景区** | 实时天气 + AQI，周边出行休闲推荐 |
| 🖥 **桌面动作** | 生成 `baidumap://` 等 URI Scheme，一键跳转地图 App 导航 |

---

## 🏗 系统架构

```
┌─────────────────────────── 客户端层（只做呈现与采集） ───────────────────────────┐
│  01-lh-uniapp-多端APP  (Android / HarmonyOS / iOS)     02-lh-wechat-mp (微信小程序) │
│   · <map> 底图渲染            · 百度地图 AK 直连(小程序端)                        │
│   · 语音采集/播报             · 其余能力统一走服务端                             │
└───────────────────────────────┬─────────────────────────────────────────────────┘
                                │ HTTPS  (X-Device-Id / X-Plan)
┌───────────────────────────────▼─────────────────────────────────────────────────┐
│                        03-lh-server（能力中转 + 编排）                            │
│  /api/v1/ip/locate     自动锚定用户 IP → 城市/坐标/运营商                        │
│  /api/v1/map/*         百度地图 Web 服务 API 代理（AK 仅存服务端，端上不可见）      │
│  /api/v1/agent/chat    Agent 编排：意图 → 工具 → 汇总 → 人性化回复                │
│  /api/v1/mcp/*         MCP Server 注册 / ModelScope 下载 / 启停                   │
│  /api/v1/model/*       用户自定义模型与 API Key（6 类供应商）                     │
│  /api/v1/voice/*       自定义语音（音色、语速、唤醒词、TTS 供应商）               │
│  /api/v1/token/*       Token 计量与配额                                          │
└───────────────────────────────┬─────────────────────────────────────────────────┘
                                │ MCP (JSON-RPC 2.0 over stdio)
┌───────────────────────────────▼─────────────────────────────────────────────────┐
│                     04-lh-mcp-servers（工具生态，即插即用）                       │
│  baidu-map · life-circle · cost-optimizer · ip-anchor                            │
│  desktop-action · emotion · voice · feedback                                     │
└─────────────────────────────────────────────────────────────────────────────────┘
```

> **Agent = MCP Client**：`03-lh-server/src/mcp/client.js` 实现完整 MCP 客户端，
> 启动时逐个拉起 MCP Server（stdio 子进程，崩溃自动重启 ≤3 次），
> `initialize → tools/list` 完成能力发现，按用户意图 `tools/call`，支持 `toOpenAITools()` 转 function-calling。

---

## 📦 目录结构

```
鲤慧-LiHui/
├── 00-设计文档/            # 产品与架构 · UI 规范 · 接口文档 · 部署指南 · 设计令牌
├── 01-lh-uniapp-多端APP/   # uni-app 工程 → Android / HarmonyOS / iOS
├── 02-lh-wechat-mp/        # 微信原生小程序工程
├── 03-lh-server/           # Node.js 零依赖服务端（50+ 路由）
├── 04-lh-mcp-servers/      # 8 个独立 MCP Server
├── docs/screenshots/       # 真机截图
└── README.md
```

> ⚠️ **五个包完全独立**：各自拥有 `package.json` / `manifest.json` / `project.config.json`，
> 无共享目录、无跨包相对引用，删掉任意一个包，其余照常编译。

---

## 🚀 快速开始

### ① 启动服务端（Node ≥ 18，零依赖）

```bash
cd 03-lh-server
cp .env.example .env        # 填入你的百度地图服务端 AK
node src/app.js             # 默认 0.0.0.0:8809
```

### ② 微信小程序

```
微信开发者工具 → 导入项目 → 目录选择 02-lh-wechat-mp/
（项目根必须精确到含 app.json 的这一层）
```

真机调试：`utils/config.js` 的 `dev` 改为电脑局域网 IP（如 `http://192.168.0.106:8809`），
手机与电脑连同一 WiFi，并放行防火墙 8809 入站。

### ③ 多端 APP（Android / HarmonyOS / iOS）

```
HBuilderX → 打开目录 01-lh-uniapp-多端APP/ → 运行到手机或模拟器
发行：Android 云打包(.apk) / HarmonyOS(.hap) / iOS(.ipa)
```

### ④ 单独运行某个 MCP Server

```bash
cd 04-lh-mcp-servers/baidu-map
node index.js               # stdio JSON-RPC 2.0，可用任意 MCP Client 挂载
```

### ⑤ Docker 一键部署（推荐服务器场景）

```bash
# 方式一：docker compose（自动持久化 data 卷）
BAIDU_AK=<你的百度AK> docker compose up -d

# 方式二：原生 docker
docker build -t lihui-server .
docker run -d --name lihui -p 8809:8809 -e BAIDU_AK=<你的百度AK> lihui-server

# 健康检查
curl http://127.0.0.1:8809/api/v1/health
```

> 镜像基于 `node:22-alpine`；服务端零依赖，无需 `npm install`；
> AK 通过环境变量注入，**不写进镜像**；`data/` 运行时数据（Token 账本、反馈）走 Docker 卷持久化。

---

## 🧩 MCP 工具清单（16+）

| MCP Server | 工具 | 能力 |
|---|---|---|
| `baidu-map` | geocode / reverse_geocode / poi_search / route_plan / weather / scenic_recommend | 百度地图全能力 |
| `life-circle` | diagnose / customize_plan / service_rating | 生活圈体检与个性化方案 |
| `cost-optimizer` | optimize_plan / promo_push | 出行成本优化 |
| `ip-anchor` | locate / batch_locate | IP 定位锚定 |
| `desktop-action` | open_app / desktop_operate | 跨 App 跳转（安全白名单） |
| `emotion` | soothe / detect_mood | 情绪安抚（含心理援助热线） |
| `voice` | list_speakers / tts_plan / asr_hint | 语音能力规划 |
| `feedback` | submit / list_pending / handle / summary | 反馈闭环 |

---

## 🔑 密钥与安全

| 密钥 | 位置 | 说明 |
|---|---|---|
| 百度服务端 AK | `03-lh-server/.env`（不入库） | 多端共用，**绝不进客户端包** |
| 百度小程序 AK | `02-lh-wechat-mp/utils/config.js` | 仅小程序端直连，需绑定 AppID 白名单 |
| LLM API Key | 客户端「我的 → 模型设置」可视化录入，或 `.env` 全局兜底 | 支持遮蔽显示 |

---

## 🛠 技术栈

`微信原生小程序` · `uni-app (Vue2)` · `Node.js 零依赖 (node:http)` · `MCP 2024-11-05 协议` · `JSON-RPC 2.0 stdio` · `高德风格设计语言 #1677FF`

---

## 🗺 Roadmap

- [x] 微信小程序端全功能
- [x] uni-app 多端工程（Android / HarmonyOS / iOS）
- [x] MCP Server 生态 + Agent Client 编排
- [x] Token 计量与配额体系
- [ ] HTTPS 域名部署 + Nginx 反代（见 `00-设计文档/04-部署与发布指南.md`）
- [ ] ModelScope 一键安装 MCP Server
- [ ] 生活圈历史体检对比

---

## 📄 License

[MIT](LICENSE) © 邓何子彦（deng-he-ziyan）

<div align="center">
<sub>Built with 🗺 百度地图开放能力 · Powered by MCP Protocol</sub>
</div>
