/**
 * 鲤慧 LiHui · 配置加载
 * 零依赖 .env 解析（不引入 dotenv）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..'); // 03-lh-server/

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
  dataDir: path.join(ROOT, 'data'),

  server: {
    port: num('PORT', 8809),
    host: env('HOST', '0.0.0.0'),
    corsOrigin: env('CORS_ORIGIN', '*'),
    logLevel: env('LOG_LEVEL', 'info'),
  },

  baidu: {
    ak: env('BAIDU_AK', ''), // AK 只从 .env / 环境变量读取，不落源码默认值
    sk: env('BAIDU_SK', ''),
    base: env('BAIDU_MAP_BASE', 'https://api.map.baidu.com'),
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

  // 缓存 TTL（毫秒）
  cache: {
    ip: 30 * 60 * 1000,
    reverseGeocode: 24 * 60 * 60 * 1000,
    poi: 5 * 60 * 1000,
    route: 60 * 1000,
    weather: 30 * 60 * 1000,
    geocode: 24 * 60 * 60 * 1000,
  },
};

module.exports = config;
