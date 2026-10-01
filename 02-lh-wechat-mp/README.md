# 02 · 鲤慧微信小程序

基于微信开发者工具原生框架（`app.js` / `app.json` / `app.wxss` + `pages/*` 四件套），
与多端 APP 共用同一套服务端（`03-lh-server`）。

- **AppID**：`wxfc45acb99d454f8a`（已写入 `project.config.json` 与 `app.json`）
- **百度地图小程序端 AK**：`FbLtBDL1RuIxCR7iIrjHwkcJSZyrqQ9R`（在 `utils/config.js`）

---

## 一、导入运行

1. 打开**微信开发者工具** → 导入项目 → 目录选 `D:/鲤慧-LiHui/02-lh-wechat-mp`
2. AppID 保持 `wxfc45acb99d454f8a`
3. 详情 → 本地设置 → 勾选 **不校验合法域名、web-view、TLS 版本以及 HTTPS 证书**
4. 先启动服务端：`cd ../03-lh-server && node src/app.js`
5. 真机预览时，把 `utils/config.js` 里的 `ENV.dev` 改成电脑局域网 IP（如 `http://192.168.1.34:8809`）

---

## 二、上线前必做（否则真机报错）

### 2.1 服务器域名白名单
小程序后台 → 开发 → 开发设置 → 服务器域名：

| 类型 | 域名 |
|---|---|
| request 合法域名 | `https://api.map.baidu.com`、`https://你的服务端域名` |
| uploadFile 合法域名 | `https://你的服务端域名` |

### 2.2 百度地图 AK 配置
百度地图开放平台 → 应用管理 → 该 AK：
- Referer 白名单选「**微信小程序**」，并填写 AppID `wxfc45acb99d454f8a`
- 确认已开通「地理编码」「逆地理编码」「地点检索」等服务

### 2.3 隐私协议
`app.json` 已声明 `requiredPrivateInfos: ["getLocation"]`；
小程序后台「隐私保护指引」中需勾选 **位置信息**、**麦克风**（语音功能）。

### 2.4 语音合成插件（可选）
`utils/voice.js` 已预留微信「同声传译」插件兜底路径。
如需使用，在小程序后台添加插件 `wx069ba97219f66d99`，并在 `app.json` 增加：

```jsonc
"plugins": {
  "WechatSI": { "version": "0.3.5", "provider": "wx069ba97219f66d99" }
}
```

---

## 三、目录结构

```
02-lh-wechat-mp/
├── app.js / app.json / app.wxss   # 入口与全局样式（含关怀模式变量）
├── sitemap.json
├── project.config.json            # AppID 已配置
├── images/                        # tabBar 图标
├── utils/
│   ├── config.js                  # 配置（含小程序端百度 AK）
│   ├── request.js                 # 服务端请求封装
│   ├── token.js                   # 设备指纹 / 套餐 / 关怀模式
│   ├── api.js                     # 全部服务端接口
│   ├── bmap.js                    # 百度地图小程序端直连（低延迟场景）
│   ├── voice.js                   # 语音播报与识别
│   └── action.js                  # 跳转百度地图小程序
└── pages/
    ├── index/       地图主页（底部抽屉 + 快捷服务 + 语音）
    ├── life/        15 分钟生活圈体检
    ├── assistant/   鲤慧对话（卡片 + 语音 + 动作确认）
    ├── route/       路线规划（含实时避堵与省钱对比）
    ├── settings/    自定义模型 / API + 自定义语音
    ├── feedback/    反馈 → 管理端
    └── mine/        我的（Token 消耗、平台信息、关怀模式）
```

---

## 四、与 APP 端的差异

| 项 | 小程序 | APP |
|---|---|---|
| 百度地图 | 端上 AK 直连（行政区、联想）+ 服务端中转（POI/路线） | 全部走服务端中转 + 百度地图 SDK 渲染底图 |
| 跳转外部应用 | `wx.navigateToMiniProgram` 跳到百度地图小程序 | `plus.runtime.openURL` Intent / URL Scheme |
| 语音合成 | 服务端 TTS 音频 或 同声传译插件 | 服务端 TTS 音频 或 系统 TTS |
| 定位 | `wx.getLocation`（需隐私授权） | `uni.getLocation` |

---

## 五、接口对齐

小程序与 APP 共用 `03-lh-server` 的 `/api/v1/*`，字段完全一致，
详见 `00-设计文档/03-API与MCP接口文档.md`。
