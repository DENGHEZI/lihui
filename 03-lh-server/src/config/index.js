/**
 * 鲤慧 LiHui · 配置加载
 * 零依赖 .env 解析（不引入 dotenv）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..'); // 03-lh-server/

// 是否在容器里（Docker / 云托管 / Kubernetes 等）。
// 云托管（CloudBase Run / 微信云托管）按控制台填写的「容器端口」做健康探测，
// 并把该端口通过环境变量 PORT 注入；若平台未注入，这里默认对齐平台约定端口 80，
// 否则会出现「服务已启动、MCP 也 8/8 正常，但平台按 80 探活 connection refused → 判部署失败」。
// 物理机 / 本地裸跑不受影响，仍沿用 8809（与小程序端 dev 配置一致）。
const IN_CONTAINER = fs.existsSync('/.dockerenv');

function loadEnvFile(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const s = line.trim();
      if (!s || s.startsWith('#')) continue;
      const i = s.indexOf('=');
      if (i < 0) continue;
      const k = s.slice(0, i).trim();
      let v = s.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (process.env[k] === undefined) process.env[k] = v;
    }
  } catch (_) {
    /* .env 不存在时静默跳过 */
  }
}

loadEnvFile(path.join(ROOT, '.env'));

const env = (k, d = '') => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);
const num = (k, d) => {
  const n = Number(env(k, ''));
  return Number.isFinite(n) && env(k, '') !== '' ? n : d;
};
const bool = (k, d = false) => {
  const v = env(k, '');
  if (v === '') return d;
  return /^(1|true|yes|on)$/i.test(v);
};

const config = {
  root: ROOT,
  // 数据目录:默认 03-lh-server/data;可用 LH_DATA_DIR 指向他处(容器挂载卷/测试隔离)
  dataDir: path.resolve(env('LH_DATA_DIR', '') || path.join(ROOT, 'data')),

  server: {
    // PORT 优先级：运行时注入 > 容器内默认 80 > 物理机默认 8809
    port: num('PORT', IN_CONTAINER ? 80 : 8809),
    host: env('HOST', '0.0.0.0'),
    corsOrigin: env('CORS_ORIGIN', '*'),
    logLevel: env('LOG_LEVEL', 'info'),
  },

  baidu: {
    ak: env('BAIDU_AK', ''), // 服务端 AK:只从 .env / 环境变量读取,不落源码默认值;只用于服务端↔百度出站,永不下发端上
    sk: env('BAIDU_SK', ''),
    base: env('BAIDU_MAP_BASE', 'https://api.map.baidu.com'),
    // 浏览器端 AK:百度控制台单独创建的「浏览器端」类型 AK,Referer 白名单锁定自己的域名。
    // H5 底图页面(/map-home)专用 —— 即使被扒走,白名单外调不通,且可与主 AK 独立重置。
    // 未配置时页面注入蜜罐 AK(见 utils/security.js),扒到的是废钥匙。
    akBrowser: env('BAIDU_AK_BROWSER', ''),
  },

  llm: {
    baseUrl: env('LLM_BASE_URL', ''),
    apiKey: env('LLM_API_KEY', ''),
    model: env('LLM_MODEL', 'Qwen-1.8B-instruct'),
  },

  token: {
    dailyQuota: num('TOKEN_DAILY_QUOTA', 200000),
  },

  mcp: {
    dir: path.resolve(ROOT, env('MCP_DIR', '../04-lh-mcp-servers')),
    builtinDir: path.resolve(ROOT, 'src', 'mcp', 'servers'),
    autostart: bool('MCP_AUTOSTART', true),
    maxRestart: num('MCP_MAX_RESTART', 3),
  },

  voice: {
    baiduApiKey: env('VOICE_BAIDU_API_KEY', ''),
    baiduSecretKey: env('VOICE_BAIDU_SECRET_KEY', ''),
    azureKey: env('VOICE_AZURE_KEY', ''),
    azureRegion: env('VOICE_AZURE_REGION', 'eastasia'),
  },

  // 存储层(2026-10-06 分布式升级)
  // driver: json=沿用 data/*.json 单文件(单实例默认,零改动兼容)
  //         sqlite=Node 22.13+ 内置 node:sqlite(零 npm 依赖),单库 WAL,
  //                支持单机多进程(LH_WORKERS)与多实例共享卷 —— 分布式部署基础
  store: {
    driver: env('LH_STORE', 'json').toLowerCase() === 'sqlite' ? 'sqlite' : 'json',
    dbPath: env('LH_DB_PATH', path.join(ROOT, 'data', 'lihui.db')),
  },

  // Memory · 人机协同安全运维(2026-10-06)
  // adminToken:写操作(analyze/verify/decide)需要 X-Admin-Token;未配置时仅本机回环可写
  // llm:分析引擎,DeepSeek OpenAI 兼容协议;不配 key 自动降级本地规则引擎(功能不空转)
  memory: {
    adminToken: env('MEMORY_ADMIN_TOKEN', ''),
    dir: env('MEMORY_DIR', ''),
    llm: {
      baseUrl: env('MEMORY_LLM_BASE_URL', ''),
      apiKey: env('MEMORY_LLM_API_KEY', ''),
      model: env('MEMORY_LLM_MODEL', 'deepseek-chat'),
      timeout: num('MEMORY_LLM_TIMEOUT', 30000),
    },
  },

  // RBAC 鉴权（2026-10-09 补齐）
  // secret: 令牌签名密钥（env LH_AUTH_SECRET，≥16 位；缺失则进程内退化密钥，重启失效，仅本地/dev）
  // adminUser/adminPass: 首次启动播种的默认管理员账号（env LH_ADMIN_USER / LH_ADMIN_PASS）
  // allowRegister: 是否开放公开自注册（默认 true；生产建议 false，仅由管理员创建账号）
  // allowLoopbackAdmin: 本机回环是否视为 admin（默认 false=安全；仅本地单进程调试且无令牌时设 true）
  //   默认关闭，否则 127.0.0.1 上任意匿名请求=admin（含平台健康检查），RBAC 形同虚设。
  //   memory.js 另有 X-Admin-Token 兜底，关闭回环豁免不影响本地运维。
  // tokenTtlMs: 令牌有效期（默认 7 天）
  auth: {
    secret: env('LH_AUTH_SECRET', ''),
    adminUser: env('LH_ADMIN_USER', 'admin'),
    adminPass: env('LH_ADMIN_PASS', 'lihui-admin-2026'),
    allowRegister: bool('LH_AUTH_ALLOW_REGISTER', true),
    allowLoopbackAdmin: bool('LH_AUTH_ALLOW_LOOPBACK_ADMIN', false),
    tokenTtlMs: num('LH_AUTH_TOKEN_TTL_MS', 7 * 24 * 3600 * 1000),
  },

  // 缓存 TTL（毫秒）
  cache: {
    ip: 30 * 60 * 1000,
    reverseGeocode: 24 * 60 * 60 * 1000,
    poi: 5 * 60 * 1000,
    route: 60 * 1000,
    weather: 30 * 60 * 1000,
    geocode: 24 * 60 * 60 * 1000,
  },

  // 安全与高并发防护(详见 utils/security.js)
  security: {
    // 百度出站 QPS 上限(令牌桶):高并发时排队而非瞬间打爆配额
    baiduQps: num('BAIDU_QPS', 30),
    // 蜜罐命中后的 IP 封禁时长(毫秒)
    banMs: num('HONEYPOT_BAN_MS', 10 * 60 * 1000),
  },
};

module.exports = config;
