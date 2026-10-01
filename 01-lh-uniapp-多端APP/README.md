# 01 · 鲤慧多端 APP（HBuilderX / uni-app）

一套代码，同时发行 **Android / HarmonyOS / iOS** 三个原生包。

## 一、为什么用 uni-app

赛题要求「基于本地已有的 HBuilderX 等开发者工具提供的架构分别建立 APP」。
本工程直接基于 HBuilderX 内置模板 `uniapp_vue/default.zip` 的骨架建立，
目录结构、`manifest.json` / `pages.json` / `main.js` / `App.vue` / `uni.scss` 全部沿用官方约定，
用 HBuilderX 打开即可识别、运行、云打包。

## 二、导入与运行

```
HBuilderX → 文件 → 打开目录 → D:/鲤慧-LiHui/01-lh-uniapp-多端APP
```

| 目标 | 操作 |
|---|---|
| Android 真机 | 运行 → 运行到手机或模拟器 → 运行到 Android App 基座 |
| HarmonyOS | 运行 → 运行到手机或模拟器 → 运行到鸿蒙（需 DevEco Studio） |
| iOS 真机 | 需 macOS + Xcode，运行 → 运行到 iOS App 基座 |
| H5 预览 | 运行 → 运行到浏览器（最快验证 UI） |
| 微信小程序 | 运行 → 运行到小程序模拟器 → 微信开发者工具（也可用 `02-lh-wechat-mp` 原生包） |

> 运行前请先启动 `03-lh-server`，并把 `utils/config.js` 里的 `ENV.dev`
> 改成你电脑的局域网 IP（真机调试用），例如 `http://192.168.1.34:8809`。

## 三、目录结构

```
01-lh-uniapp-多端APP/
├── manifest.json            # 三端打包配置（含 Android 权限 / iOS 隐私描述 / 鸿蒙 bundle）
├── pages.json               # 页面路由 + tabBar
├── main.js / App.vue        # 入口（启动时初始化设备指纹与关怀模式）
├── uni.scss                 # 全局 SCSS 变量（与设计令牌一一对应）
├── api/                     # 服务端接口封装
│   ├── request.js           #   统一请求（自动带 X-Device-Id、错误提示、Token 记录）
│   ├── map.js               #   百度地图能力（经服务端中转）
│   ├── agent.js             #   鲤慧 Agent 对话
│   ├── life.js              #   生活圈体检 / 反馈 / Token / 应用跳转
│   └── user.js              #   模型、语音、平台配置 + 定位（GPS→IP 兜底）
├── utils/
│   ├── config.js            # 配置（不含任何服务端 AK）
│   ├── token.js             # 设备指纹 / 套餐 / 操作日志
│   ├── care.js              # 关怀模式
│   ├── voice.js             # 语音播报与识别（自定义语音）
│   └── action.js            # 外部应用跳转（百度地图/高德/淘宝…）
├── components/
│   ├── lh-search-bar.vue    # 高德风格顶部胶囊搜索框（含输入联想）
│   ├── lh-poi-item.vue      # POI 行
│   └── lh-score-ring.vue    # 生活圈评分环
├── pages/
│   ├── index/index.vue      # 地图主页：底部抽屉 + 快捷服务 + 悬浮按钮 + 语音
│   ├── life/life.vue        # 15 分钟生活圈体检报告
│   ├── assistant/assistant.vue  # 鲤慧对话（卡片 + 语音 + 动作确认）
│   ├── route/route.vue      # 路线规划（含实时避堵与省钱对比）
│   ├── settings/settings.vue    # 自定义模型/API + 自定义语音
│   ├── feedback/feedback.vue    # 反馈 → 管理端
│   └── mine/mine.vue        # 我的：Token 消耗、平台信息、关怀模式
└── harmony-configs/         # 鸿蒙权限与能力配置片段
```

## 四、三端差异处理

| 能力 | Android | HarmonyOS | iOS | 处理方式 |
|---|---|---|---|---|
| 定位 | ✔ | ✔ | ✔ | 统一 `uni.getLocation`，失败回落服务端 IP 锚定 |
| 底图 | 百度地图 SDK | 百度地图 SDK | 百度地图 SDK | `manifest.json → app-plus.distribute.sdkConfigs.maps.baidu` |
| 语音播报 | 系统 TTS / 百度 TTS | 系统 TTS | AVSpeechSynthesizer | `utils/voice.js` 内条件编译 |
| 跳转外部 App | Intent URL | Want | URL Scheme | `utils/action.js` → `plus.runtime.openURL` |
| 录音 | ✔ | @ohos.multimedia.audio | ✔ | `uni.getRecorderManager` 统一 |

条件编译指令在各文件中以 `// #ifdef APP-PLUS` / `// #ifdef APP-HARMONY` 标注。

## 五、打包前必须补的东西

1. **百度地图端上 AK**：`manifest.json → app-plus.distribute.sdkConfigs.maps.baidu`
   填入 Android / iOS 各自的 AK（**注意：这与服务端 AK `ismiBf…` 不是同一个**，
   服务端 AK 只留在 `03-lh-server/.env`）。
2. **Android 签名**：`*.keystore`
3. **iOS 证书**：`*.p12` + `*.mobileprovision`，以及 App Store 的 Bundle ID
4. **HarmonyOS 签名**：DevEco Studio 生成的 `.cer` / `.p7b` / `.p12`
5. 服务器域名换成 HTTPS（iOS 强制 ATS）

## 六、当前工程不包含（避免影响编译）

- 不含任何 `node_modules`
- 不含证书文件
- 不含服务端代码（在 `03-lh-server`）
- 不引用其他包的相对路径
