#!/usr/bin/env bash
# ============================================================
# 鲤慧 LiHui · 服务端 Docker 一键部署 + 部署自检
#
# 用法（在项目根目录执行）：
#   bash scripts/docker-deploy.sh
#
# 做的事：校验环境与环境变量 → 构建 → 启动 → 逐个探活自检 → 失败时自动 dumps 日志
# Windows 用户可在 Git Bash 里执行本脚本。
# ============================================================
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

PORT="${PORT:-8809}"
BASE="http://127.0.0.1:${PORT}"

say() { printf '\033[36m[lihui]\033[0m %s\n' "$*"; }
ok() { printf '\033[32m[ ok ]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[warn]\033[0m %s\n' "$*"; }
err() { printf '\033[31m[fail]\033[0m %s\n' "$*"; }
hr() { printf -- '----------------------------------------\n'; }

# ---------- 0. 环境校验 ----------
if [ ! -f Dockerfile ] || [ ! -f docker-compose.yml ]; then
  err "当前目录不是项目根目录（缺少 Dockerfile / docker-compose.yml）。"
  err "请在项目根执行，而不是 03-lh-server/ 子目录 —— build context 路径不对会导致 COPY 失败。"
  exit 1
fi
ok "项目根目录正确：$ROOT"

if ! command -v docker >/dev/null 2>&1; then
  err "未检测到 docker 命令。请先安装 Docker Desktop 并启动，或确认 docker 在 PATH 中。"
  exit 1
fi
ok "docker 版本：$(docker --version 2>&1)"

# ---------- 1. 环境变量 ----------
if [ ! -f .env ]; then
  warn "未找到 .env，正在从 .env.example 生成（需你手动填 BAIDU_AK）…"
  cp .env.example .env
fi
if ! grep -qE '^\s*BAIDU_AK=.+' .env 2>/dev/null; then
  warn ".env 里 BAIDU_AK 为空 —— 启动后地图检索/公交/天气会全部无数据。"
  warn "执行：  cp .env.example .env  然后编辑其中的 BAIDU_AK=你的密钥"
fi
if grep -qE '^\s*LLM_API_KEY=.+' .env 2>/dev/null; then
  ok "已检测到 LLM_API_KEY（云端模型 + 联网检索可用）"
else
  warn "未配置 LLM_API_KEY —— 容器内无云端模型，回答将退化为本地规则，实时信息（新闻/公交）查不到。"
fi

# ---------- 2. 构建并启动 ----------
hr
say "构建镜像（首次较慢，约 30~60s）…"
docker compose build "$@" || {
  err "docker compose build 失败。"
  err "常见原因：① 在子目录执行导致 COPY 03-lh-server/src 找不到；② 磁盘空间不足；③ 网络拉不到 node:22-alpine。"
  exit 1
}

say "启动容器…"
docker compose up -d || {
  err "docker compose up 失败。"
  docker compose logs --no-color --tail 60 lihui-server 2>/dev/null
  exit 1
}

# ---------- 3. 探活自检 ----------
hr
say "等待服务就绪（最多 40s）…"
READY=0
for i in $(seq 1 20); do
  if curl -fsS --max-time 3 "$BASE/api/v1/health" >/dev/null 2>&1; then
    READY=1; ok "服务已就绪（第 ${i} 次探测）"; break
  fi
  sleep 2
done
if [ "$READY" -ne 1 ]; then
  err "服务未能在 40s 内就绪，$BASE/api/v1/health 无响应。"
  docker ps -a --filter name=lihui-server
  docker compose logs --no-color --tail 80 lihui-server 2>/dev/null
  exit 1
fi

# ---------- 4. 功能自检 ----------
hr
printf '%-26s %s\n' "容器状态:"  "$(docker inspect -f '{{.State.Status}}' lihui-server 2>/dev/null)"
printf '%-26s %s\n' "健康状态:"  "$(docker inspect -f '{{.State.Health.Status}}' lihui-server 2>/dev/null)"
printf '%-26s %s\n' "端口映射:"  "$(docker inspect -f '{{(index .NetworkSettings.Ports "8809/tcp")}}' lihui-server 2>/dev/null | tr -d '[:space:]')"

printf '\n%s\n' "接口自检："
for path in "/api/v1/health" "/api/v1/model/active" "/api/v1/mcp/list"; do
  code=$(curl -s -o /tmp/lihui_probe.txt -w '%{http_code}' --max-time 5 "$BASE$path" 2>/dev/null)
  if [ "$code" = "200" ]; then
    ok "$path  (200) $(head -c 220 /tmp/lihui_probe.txt | tr -d '\n')"
  else
    warn "$path  (HTTP $code)"
  fi
done

# MCP 关键能力检查
say "MCP 子进程检查（应看到 baidu-map / life-circle 等 running）："
curl -s --max-time 5 "$BASE/api/v1/mcp/list" 2>/dev/null | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  try{
    const list=JSON.parse(s).data.servers||[];
    for(const x of list){
      const bad = x.status!=='running';
      console.log((bad?'  [warn] ':'  [ ok ] ')+x.id.padEnd(18)+x.status+(x.error?'  '+String(x.error).slice(0,90):''));
    }
    const badN=list.filter(x=>x.status!=='running').length;
    if(badN) { console.log('\n  ⚠ '+badN+' 个 MCP 未运行 —— 多为镜像内缺少 04-lh-mcp-servers（新版镜像已修复，执行 docker compose up -d --build 重建）。'); process.exit(2); }
  }catch(e){ console.log('  解析失败：'+s.slice(0,160)); }
});" || true

hr
say "部署完成。常用命令："
echo "  查看日志     docker compose logs -f lihui-server"
echo "  停止         docker compose down"
echo "  改完代码重建  docker compose up -d --build"
echo "  健康检查     curl $BASE/api/v1/health"
echo "  容器内自检   docker exec lihui-server ls /04-lh-mcp-servers"
