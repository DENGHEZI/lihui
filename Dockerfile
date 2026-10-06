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

# 时区：容器默认 UTC，日志会比北京时间早 8 小时（官方 FAQ 明确条目），改为上海时间
RUN apk add --no-cache tzdata \
  && cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime \
  && echo "Asia/Shanghai" > /etc/timezone \
  && apk del tzdata
ENV TZ=Asia/Shanghai

# 运行时数据目录（Token 账本 / 会话 / 反馈 / 模型配置）。
RUN mkdir -p /app/data && chmod 700 /app/data

# 服务端代码（零依赖，无需 npm install）
COPY 03-lh-server/package.json ./
COPY 03-lh-server/src ./src
COPY 03-lh-server/.env.example ./.env.example

# ★ 运行密钥随镜像构建时注入，云端部署后开箱即用，免去在云控制台逐个填环境变量。
#   ⚠️ models.json（模型 Key）【不入库】——含明文密钥，进公开仓库即泄露
#      （2026-10-05 曾因它在 git 历史泄露过一把 key，被迫 git-filter-repo 重写历史）。
#      云端首次启动由 seed() 自动生成：预置链来自代码，
#      免费渠道 Key 通过云托管控制台「环境变量」注入：
#        MODELSCOPE_TOKEN=<ms token>       → 自动启用「通义千问（免费推理）」为默认
#        SILICONFLOW_API_KEY=<sf key>      → 备选免费档
#      （本地开发的 models.json 被 03-lh-server/.gitignore 挡住，不入库）
COPY 03-lh-server/.env.cloud ./.env

# ★ 静态数据目录必须逐个显式 COPY —— 云托管是「从 Gitee 拉仓库 build」的，
#   仓库里有的文件才会进镜像；漏一条 → 容器内 /app/data/xxx.json 不存在，
#   store.read() 直接返回 null，接口静默返回空数组（表现为「商品打不开 / 列表空白」）。
#   ⚠️ 以后新增这类静态数据文件（如 data/xxx.json）时，必须在这里同步加一行 COPY，
#      否则本地跑得好好的，一上云就空。
# 运行时才生成的文件 feedback/sessions/tokens/quota/voice/mcp/models 反而【不能】COPY，
#   否则会把某个人的历史数据/密钥烤进镜像，所有新用户一进去就看到别人的记录。
COPY 03-lh-server/data/shop.json ./data/shop.json
# 各地生活圈管理规范（体检评分依据）：静态数据，必须 COPY，漏了 → /life/standards 降级内置兜底
COPY 03-lh-server/data/standards.json ./data/standards.json

# ★ 必须随镜像一起拷贝：MCP Server 是 stdio 子进程，由 config.mcp.dir 解析路径。
#   MCP_BASE = path.resolve('/app', '..', '..') + '/04-lh-mcp-servers' = /04-lh-mcp-servers
#   这些 MCP 全部零依赖（只用 node 内置模块），无需 npm install。
#   漏掉这一步 → 镜像能起来、健康检查 200，但所有检索/生活圈/导航全部无数据。
COPY 04-lh-mcp-servers /04-lh-mcp-servers

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=80
# 分布式部署（详见 docs/DEPLOY.md）：
#   单实例（默认）         → LH_STORE=json，零配置
#   单机多进程             → LH_WORKERS=N + LH_STORE=sqlite
#   多实例横向扩（共享卷）  → LH_STORE=sqlite + LH_DB_PATH=<共享卷路径>
# 环境变量在运行时注入（docker run -e / 云托管控制台「环境变量」），不烤进镜像。
# ★ 镜像默认端口必须与云托管（CloudBase Run / 微信云托管）的容器端口约定一致。
#   平台按「服务设置 → 容器端口」探活；容器监听端口 = 运行时 PORT > 镜像默认。
#   早期版本这里写死 8809，而控制台填 80 → 服务监听 8809、平台探 80，
#   报 Readiness probe failed: dial tcp ...:80: connect: connection refused，
#   即便 MCP 已经 8/8 全部跑起来，平台仍然判「部署失败」。
#   现在镜像默认 80：
#     · 云托管控制台端口填 80   → 直接一致，不用配环境变量
#     · 云托管控制台端口填 8080/3000/x → 在「环境变量」里显式加 PORT=8080 覆盖即可
#     · docker compose 本地      → compose 显式 PORT=${PORT:-8809}，本地仍是 8809

EXPOSE 8809

# 健康检查（利用 node 内置 http，无需镜像内额外安装 curl/wget）
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||80)+'/api/v1/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# exec 形式保证 node 成为 PID 1，收到 SIGTERM 能优雅关掉 MCP 子进程
CMD ["sh", "-c", "exec node src/app.js"]
