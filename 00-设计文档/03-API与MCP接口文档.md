# 鲤慧 · API 与 MCP 接口文档

- Base URL：`http://127.0.0.1:8809`（生产替换为你的域名，必须 HTTPS）
- 统一前缀：`/api/v1`
- 鉴权：请求头 `X-Device-Id: <设备指纹>`；写接口额外 `Authorization: Bearer <用户token>`
- 返回结构：`{ "code": 0, "msg": "ok", "data": {...}, "traceId": "..." }`，`code != 0` 为错误
- 每个请求都会经过 `tokenMeter`，响应头带 `X-Token-Cost`

---

## 一、位置与 IP 自动锚定

### 1.1 `GET /api/v1/ip/locate`

自动锚定用户 IP，返回城市级位置（**无需传参**，服务端从连接头解析）。

**响应**
```json
{
  "code": 0,
  "data": {
    "ip": "110.53.xx.xx",
    "city": "长沙市",
    "province": "湖南省",
    "district": "岳麓区",
    "point": { "lng": 112.938814, "lat": 28.228209 },
    "isp": "中国电信",
    "confidence": 0.92,
    "source": "baidu-ip",
    "cached": false
  }
}
```

| 字段 | 说明 |
|---|---|
| `confidence` | 定位可信度 0–1，< 0.5 时端上应再调 GPS 校正 |
| `source` | `baidu-ip` / `cache` / `fallback`（降级为内置城市表） |

### 1.2 `POST /api/v1/loc/report`

端上 GPS 校正结果回传，用于修正该 IP 的缓存。

```json
{ "ip": "110.53.xx.xx", "lng": 112.938814, "lat": 28.228209, "accuracy": 25 }
```

---

## 二、地图能力（百度地图 AK 中转）

> 端上不持有服务端 AK。所有接口由服务端注入 `ak=<你的百度AK>`。

### 2.1 `GET /api/v1/map/geocode`
地址 → 坐标。参数：`address`（必填）、`city`（可选）。

### 2.2 `GET /api/v1/map/reverse-geocode`
坐标 → 地址。参数：`lng`、`lat`（必填）。

### 2.3 `GET /api/v1/map/poi/search`
周边 POI 搜索。参数：

| 参数 | 必填 | 说明 |
|---|---|---|
| `query` | 是 | 关键词，如「药店」「公园」 |
| `lng` / `lat` | 是 | 中心点 |
| `radius` | 否 | 半径（米），默认 1200（≈15 分钟步行） |
| `pageNum` / `pageSize` | 否 | 分页，默认 0 / 20 |

**响应**（节选）
```json
{ "code": 0, "data": { "total": 37, "items": [
  { "uid":"...", "name":"老百姓大药房(麓山南路店)", "address":"麓山南路 123 号",
    "lng":112.941,"lat":28.230,"distance":312, "tag":"药店", "detail":"" }
]}}
```

### 2.4 `GET /api/v1/map/route`
路线规划。参数：`mode`（`walking`|`riding`|`driving`|`transit`）、`origin`、`destination`（`lng,lat`），
`realtime`（可选，驾车实时避堵）。

**响应**（节选）
```json
{ "code": 0, "data": {
  "mode":"driving", "distance":8421, "duration":1560,
  "trafficLight":9, "congestion":"轻度拥堵",
  "steps":[ { "instruction":"沿麓山南路向东行驶 800 米", "distance":800, "duration":120, "path":"112.94,28.23;112.95,28.23" } ],
  "polyline":"112.94,28.23;..." } }
```

### 2.5 `GET /api/v1/map/weather`
行政区天气（用于出行建议）。参数：`district` 或 `lng,lat`。

### 2.6 `GET /api/v1/map/suggest`
输入联想。参数：`keyword`、`city`。

---

## 三、15 分钟生活圈体检

### 3.1 `GET /api/v1/life/report`
参数：`lng`、`lat`、`radius`（默认 1200）、`categories`（可选，逗号分隔）。

**响应**
```json
{ "code": 0, "data": {
  "score": 78,
  "level": "良好",
  "center": { "lng":112.938814, "lat":28.228209 },
  "radius": 1200,
  "categories": [
    { "key":"medical", "name":"医疗", "weight":0.25, "score":88,
      "count":11, "types":["医院","社区卫生服务中心","药店"],
      "nearest": { "name":"岳麓区社区卫生服务中心", "distance":430 } },
    { "key":"transit", "name":"交通", "weight":0.2, "score":55, "count":3, "types":["公交站"] }
  ],
  "shortboards": ["交通：15 分钟步行可达 3 个公交站，最近地铁需 1.8km"],
  "suggestions": ["向东北方向 900m 有地铁 4 号线，建议优先考虑该方向出行"]
}}
```

### 3.2 `POST /api/v1/life/customize`
个性化生活圈方案定制。

```json
{ "lng":112.938814, "lat":28.228209,
  "preference": { "budget":"low", "withElderly":true, "needPark":true, "maxWalkMinutes":15 },
  "plan": "pro" }
```

---

## 四、Agent 对话（MCP Client 编排）

### 4.1 `POST /api/v1/agent/chat`

```json
{ "sessionId":"s_xxx", "text":"我妈妈 70 岁，附近 15 分钟能看病买菜吗？顺便算下最省钱方案",
  "careMode": true, "plan": "pro", "lng":112.938814, "lat":28.228209, "stream": false }
```

**响应**
```json
{ "code": 0, "data": {
  "reply": "已帮您看了下：\n1. 医疗：430 米有社区卫生服务中心，达标。\n2. 买菜：560 米有菜市场，达标。\n3. 交通：最近公交站 300 米，最近地铁 1.8 公里，这是短板。\n省钱方案：步行 + 公交，单次往返约 ¥2，比打车省 ¥18。",
  "cards": [ { "type":"life_score", "score":78 }, { "type":"route", "distance":1200, "duration":900 } ],
  "actions": [ { "type":"open_app", "app":"百度地图", "uri":"baidumap://..." } ],
  "toolCalls": [ { "server":"baidu-map", "tool":"poi_search", "ms":142 }, { "server":"life-circle", "tool":"diagnose", "ms":86 } ],
  "usage": { "prompt":1234, "completion":412, "total":1646, "costCny":0.0033, "model":"qwen-plus" }
}}
```

### 4.2 `GET /api/v1/agent/sessions` / `DELETE /api/v1/agent/sessions/:id`
会话列表 / 清空（长记忆存服务端 `data/sessions/{id}.json`）。

---

## 五、MCP 管理

### 5.1 `GET /api/v1/mcp/list`
已注册 MCP Server 列表（含 `status`：`running` / `stopped` / `error`、`tools[]`）。

### 5.2 `POST /api/v1/mcp/toggle`
```json
{ "id":"desktop-action", "enabled": false }
```

### 5.3 `GET /api/v1/mcp/registry/search?keyword=地图`
**从 ModelScope MCP 广场检索可用 MCP 协议**（服务端代理请求 ModelScope 开放接口，规避端上跨域）。

```json
{ "code": 0, "data": { "items": [
  { "id":"modelscope/mcp-server-amap", "name":"高德地图 MCP", "stars":1280,
    "description":"提供地理编码、路径规划…", "installType":"npm", "installRef":"@modelcontextprotocol/server-amap" }
]}}
```

### 5.4 `POST /api/v1/mcp/install`
```json
{ "id":"modelscope/mcp-server-amap", "installType":"npm", "installRef":"@modelcontextprotocol/server-amap",
  "env": { "AMAP_KEY":"***" }, "autoStart": true }
```
服务端执行：`npm install`（或直接登记 stdio 命令）→ 写入 `data/mcp.json` → 拉起进程 → `tools/list` 验证。

### 5.5 `POST /api/v1/mcp/call`
直接调试某个工具。
```json
{ "server":"baidu-map", "tool":"poi_search", "args": { "query":"药店", "lng":112.94, "lat":28.23 } }
```

---

## 六、用户自定义模型 / API

### 6.1 `GET /api/v1/model/list`
返回模型列表（`apiKey` 脱敏为 `sk-****abcd`）。

### 6.2 `POST /api/v1/model/save`
```json
{ "id":"", "name":"我的通义千问", "provider":"openai-compatible",
  "baseUrl":"https://dashscope.aliyuncs.com/compatible-mode/v1",
  "apiKey":"sk-xxx", "model":"qwen-plus", "isDefault":true }
```
`provider` 支持：`openai-compatible` / `anthropic` / `gemini` / `ollama` / `baidu-qianfan` / `deepseek`。

### 6.3 `POST /api/v1/model/test`
```json
{ "id":"m_xxx" }
```
→ 发一条 `ping`，返回 `{ "ok":true, "latencyMs":412, "reply":"pong" }`。

### 6.4 `DELETE /api/v1/model/:id`

---

## 七、自定义语音

### 7.1 `GET /api/v1/voice/config`
### 7.2 `POST /api/v1/voice/config`
```json
{ "engine":"baidu", "speaker":"per_4", "speed":1.0, "pitch":1.0, "volume":1.0,
  "wakeWord":"小鲤小鲤", "dialect":"putonghua", "autoSpeak":true, "careMode":false }
```
`engine` 支持 `baidu` / `azure` / `local`（系统 TTS）/ `custom`（自定义 HTTP 接口）。

### 7.3 `POST /api/v1/voice/tts`
```json
{ "text":"前面 300 米有药店", "format":"mp3" }
```
→ `{ "code":0, "data": { "audioUrl":"/static/tts/xxx.mp3", "durationMs":2100 } }`

### 7.4 `POST /api/v1/voice/asr`
上传音频（`multipart/form-data`，字段 `audio`）→ `{ "text":"附近有药店吗" }`

---

## 八、Token 计量与配额

### 8.1 `GET /api/v1/token/stats?range=7d`
```json
{ "code":0, "data": {
  "total": { "prompt":52310, "completion":18240, "total":70550, "costCny":0.141 },
  "quota": { "daily":200000, "usedToday":10240, "remainToday":189760 },
  "byDay": [ { "day":"2026-09-25", "total":8210, "costCny":0.016 } ],
  "byModel": [ { "model":"qwen-plus", "total":61000, "costCny":0.122 } ]
}}
```

### 8.2 `POST /api/v1/token/quota`
设置每日配额（管理端）。

---

## 九、用户反馈 → 管理端

### 9.1 `POST /api/v1/feedback`
```json
{ "type":"bug|feature|complaint|praise", "content":"…", "contact":"138****", "screenshots":["url"] }
```

### 9.2 `GET /api/v1/feedback/list?status=pending`（管理端）
### 9.3 `POST /api/v1/feedback/handle`
```json
{ "id":"fb_xxx", "status":"resolved", "reply":"已修复，请更新到 1.0.1" }
```

---

## 十、桌面应用自动操作（MCP：desktop-action）

### 10.1 `POST /api/v1/action/open-app`
```json
{ "app":"百度地图", "uri":"baidumap://map/direction?origin=我的位置&destination=xx&mode=walking" }
```
服务端返回可执行 `uri`，端上执行：
- uni-app（App 端）：`plus.runtime.openURL(uri)`
- 小程序：`wx.navigateToMiniProgram({ appId, path })`

### 10.2 `POST /api/v1/action/desktop-operate`
```json
{ "os":"windows", "target":"淘宝", "intent":"搜索并加入购物车：洗衣液",
  "constraints": { "maxPrice": 39, "preferFreeShipping": true } }
```
> 返回**操作脚本（安全白名单步骤）**，由配套桌面端执行器二次确认后执行。
> 服务端不做静默支付，涉及付款必须用户显式确认。

---

## 十一、MCP 工具清单（04-lh-mcp-servers）

| Server | Tool | 入参要点 | 说明 |
|---|---|---|---|
| `baidu-map` | `geocode` | `address, city?` | 地址转坐标 |
| | `reverse_geocode` | `lng, lat` | 坐标转地址 |
| | `poi_search` | `query, lng, lat, radius?` | 周边搜索 |
| | `route_plan` | `mode, origin, destination, realtime?` | 路线规划（含实时避堵） |
| | `weather` | `district \| lng,lat` | 天气 |
| | `scenic_recommend` | `lng, lat, radius?, tags?` | 景点/休闲推荐 |
| `life-circle` | `diagnose` | `lng, lat, radius?` | 15 分钟体检打分 |
| | `customize_plan` | `lng, lat, preference` | 个性化方案 |
| | `service_rating` | `uid \| name, lng, lat` | 服务质量评价参考 |
| `cost-optimizer` | `optimize_plan` | `plans[], incomeLevel?` | 成本最优方案 |
| | `promo_push` | `lng, lat, category` | 优惠信息聚合推送 |
| `ip-anchor` | `locate` | `ip?` | IP → 城市/坐标 |
| `desktop-action` | `open_app` | `app, uri?` | 唤起外部应用 |
| | `desktop_operate` | `os, target, intent, constraints` | 桌面应用操作脚本 |
| `emotion` | `soothe` | `text, mood?` | 情感疏通 |
| `voice` | `tts` | `text, speaker?, speed?` | 语音合成 |
| | `asr` | `audioPath` | 语音识别 |
| `feedback` | `submit` | `type, content, contact?` | 提交反馈 |
| | `list_pending` | `-` | 管理端拉取待处理 |

---

## 十二、错误码

| code | 含义 | 处理建议 |
|---|---|---|
| 0 | 成功 | — |
| 1001 | 参数缺失/非法 | 检查必填字段 |
| 1002 | 未授权设备 | 重新注册设备指纹 |
| 1003 | 超出配额 | 提示购买或次日重置 |
| 2001 | 百度地图 API 报错 | 检查 AK 配额/白名单 |
| 2002 | 百度地址解析失败 | 转 IP 兜底 |
| 3001 | 模型调用失败 | 端上提示「切换到备用模型」 |
| 3002 | 无可用模型 | 引导到「我的→模型设置」 |
| 4001 | MCP Server 未启动 | `POST /api/v1/mcp/toggle` 开启 |
| 4002 | MCP 工具不存在 | 调 `GET /api/v1/mcp/list` 查可用工具 |
| 5000 | 服务端内部错误 | 携带 `traceId` 反馈 |
