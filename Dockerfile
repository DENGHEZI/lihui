# ============================================================
# 鲤慧 LiHui · 服务端镜像
# 服务端为 Node.js 零依赖实现（node:http），无需 npm install
#
# 构建：  docker build -t lihui-server .
# 运行：  docker run -d --name lihui -p 8809:8809 \
#           -e BAIDU_AK=<你的百度AK> lihui-server
# 验证：  curl http://127.0.0.1:8809/api/v1/health
# ============================================================
FROM node:22-alpine

LABEL org.opencontainers.image.title="鲤慧 LiHui Server"
LABEL org.opencontainers.image.description="基于百度地图开放能力的 15 分钟生活圈智能体检与规划助手 · 服务端（50+ 路由 / MCP Hub / Agent 编排 / Token 计量）"
LABEL org.opencontainers.image.licenses="MIT"

WORKDIR /app

# 运行时数据目录（Token 账本 / 会话 / 反馈 / 模型配置）。
# 注意：不要在这里 COPY 03-lh-server/data，其中可能含敏感配置；
# compose 以命名卷 lihui-data 持久化 /app/data，缺失时 store.js 会自动 mkdir。
RUN mkdir -p /app/data && chmod 700 /app/data

# 仅拷贝服务端所需内容（AK 一律不进镜像，运行时以环境变量注入）
COPY 03-lh-server/package.json ./
COPY 03-lh-server/src ./src
COPY 03-lh-server/.env.example ./.env.example

# ★ 必须随镜像一起拷贝：MCP Server 是 stdio 子进程，由 config.mcp.dir 解析路径。
#   MCP_BASE = path.resolve('/app', '..', '..') + '/04-lh-mcp-servers' = /04-lh-mcp-servers
#   这些 MCP 全部零依赖（只用 node 内置模块），无需 npm install。
#   漏掉这一步 → 镜像能起来、健康检查 200，但所有检索/生活圈/导航全部无数据。
COPY 04-lh-mcp-servers /04-lh-mcp-servers

ENV NODE_ENV=production \
    HOST=0.0.0.0
# ★ 这里故意【不写死】ENV PORT！
#   云托管 / 微信云托管 / CloudBase Run 会把你在「服务设置 → 容器端口」填写的端口
#   通过环境变量 PORT 注入容器（例如 80），并按同一个端口做健康检查。
#   若镜像层写死 ENV PORT=8809，容器就会监听 8809、平台却按 80 探测，
#   报 Readiness probe failed: dial tcp ...:80: connect: connection refused，
#   平台判定「服务启动正常但端口不符 → 部署失败」。
#   运行时端口优先级：平台注入 PORT > 本地/裸跑时 config.js 默认 8809。
#   （compose 里已显式声明 PORT: ${PORT:-8809}，本地行为不变）

EXPOSE 8809

# 健康检查（利用 node 内置 http，无需镜像内额外安装 curl/wget）
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||8809)+'/api/v1/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# exec 形式保证 node 成为 PID 1，收到 SIGTERM 能优雅关掉 MCP 子进程
CMD ["sh", "-c", "exec node src/app.js"]
