# 04 · 鲤慧 MCP Servers

8 个**可独立运行、可独立发布**的 MCP Server。每个子目录都是完整单文件实现，零外部依赖。

| # | Server | 工具 | 对应赛题功能 |
|---|---|---|---|
| 1 | `baidu-map` | `geocode` `reverse_geocode` `poi_search` `route_plan` `weather` `scenic_recommend` | 定位、周边便民服务、路线规划与避堵、景点推荐 |
| 2 | `life-circle` | `diagnose` `customize_plan` `service_rating` | 15 分钟生活圈体检、个性化方案、服务质量评价 |
| 3 | `cost-optimizer` | `optimize_plan` `promo_push` | 智能成本优化、商家优惠推送 |
| 4 | `ip-anchor` | `locate` `batch_locate` | 自动锚定用户 IP |
| 5 | `desktop-action` | `open_app` `desktop_operate` | 自动跳转应用、MCP 操作桌面应用购买 |
| 6 | `emotion` | `soothe` `detect_mood` | 用户情感疏通 |
| 7 | `voice` | `list_speakers` `tts_plan` `asr_hint` | 自定义语音 |
| 8 | `feedback` | `submit` `list_pending` `handle` `summary` | 用户反馈 → 管理端 |

---

## 一、协议实现

严格按 Model Context Protocol（`2024-11-05`）实现 stdio 传输：

```
← {"jsonrpc":"2.0","id":1,"method":"initialize","params":{...}}
→ {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{...}},"serverInfo":{...}}}
← {"jsonrpc":"2.0","method":"notifications/initialized"}
← {"jsonrpc":"2.0","id":2,"method":"tools/list"}
→ {"jsonrpc":"2.0","id":2,"result":{"tools":[...]}}
← {"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"poi_search","arguments":{...}}}
→ {"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"{...json...}"}]}}
```

Agent 端（`03-lh-server/src/mcp/client.js`）就是这套协议的 **MCP Client**。

---

## 二、单独运行与自测

```bash
# 直接跑（stdio，等待 JSON-RPC）
BAIDU_AK=<你的百度AK> node baidu-map/index.js

# 一行自测（不用装任何东西）
printf '%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
 '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"diagnose","arguments":{"lng":112.938814,"lat":28.228209}}}' \
 | node life-circle/index.js
```

---

## 三、挂载到任意 MCP 客户端

```jsonc
{
  "mcpServers": {
    "lihui-baidu-map": {
      "command": "node",
      "args": ["D:/鲤慧-LiHui/04-lh-mcp-servers/baidu-map/index.js"],
      "env": { "BAIDU_AK": "<你的百度AK>" }
    },
    "lihui-life-circle": {
      "command": "node",
      "args": ["D:/鲤慧-LiHui/04-lh-mcp-servers/life-circle/index.js"],
      "env": { "BAIDU_AK": "<你的百度AK>" }
    },
    "lihui-cost-optimizer": { "command": "node", "args": ["D:/鲤慧-LiHui/04-lh-mcp-servers/cost-optimizer/index.js"] },
    "lihui-desktop-action": { "command": "node", "args": ["D:/鲤慧-LiHui/04-lh-mcp-servers/desktop-action/index.js"] },
    "lihui-emotion":        { "command": "node", "args": ["D:/鲤慧-LiHui/04-lh-mcp-servers/emotion/index.js"] },
    "lihui-voice":          { "command": "node", "args": ["D:/鲤慧-LiHui/04-lh-mcp-servers/voice/index.js"] },
    "lihui-feedback":       { "command": "node", "args": ["D:/鲤慧-LiHui/04-lh-mcp-servers/feedback/index.js"] }
  }
}
```

---

## 四、发布到 ModelScope

每个子目录都带 `package.json`（含 `bin` 字段），可以直接发布为 npm 包再登记到 ModelScope MCP 广场：

```bash
cd baidu-map
npm publish --access public          # 发布为 lh-mcp-server-baidu-map
```

发布后在 ModelScope（https://modelscope.cn/mcp）登记 `npx -y lh-mcp-server-baidu-map` 即可被他人一键安装。

反过来，**从 ModelScope 拉取别人的 MCP** 由服务端完成：

```bash
curl "http://127.0.0.1:8809/api/v1/mcp/registry/search?keyword=地图"
curl -X POST http://127.0.0.1:8809/api/v1/mcp/install \
  -H "Content-Type: application/json" \
  -d '{"id":"modelscope/mcp-server-fetch","installType":"uvx","installRef":"mcp-server-fetch","autoStart":true}'
```

---

## 五、安全约束

- `desktop-action` **不代用户付款**，所有涉及支付的步骤都返回 `needConfirm: true`；
- `emotion` 检测到高风险表述时，直接返回心理援助热线（12356 / 010-82951332），不做任何"打发式"回复；
- `feedback` 的写操作只落本地 JSON，不触达外部服务；
- 全部 Server 都不读取、不传输用户隐私文件。
