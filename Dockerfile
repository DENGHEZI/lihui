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

# 仅拷贝服务端所需内容（AK 一律不进镜像，运行时以环境变量注入）
COPY 03-lh-server/package.json ./
COPY 03-lh-server/src ./src
COPY 03-lh-server/.env.example ./.env.example

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8809

EXPOSE 8809

# 健康检查（利用 node 内置 http，无需镜像内额外安装 curl/wget）
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||8809)+'/api/v1/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "src/app.js"]
