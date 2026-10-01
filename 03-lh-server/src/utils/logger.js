/**
 * 鲤慧 LiHui · 日志（零依赖，结构化 JSON 行）
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const THRESHOLD = LEVELS[config.server.logLevel] || 20;

const logDir = path.join(config.dataDir, 'logs');
let logFile = null;
try {
  fs.mkdirSync(logDir, { recursive: true });
} catch (_) {}

function dayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function write(level, tag, msg, extra) {
  if (LEVELS[level] < THRESHOLD) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    tag,
    msg,
    ...(extra || {}),
  });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);

  // 落盘
  try {
    const f = path.join(logDir, `${dayKey()}.log`);
    if (f !== logFile) logFile = f;
    fs.appendFileSync(f, line + '\n');
  } catch (_) {}
}

module.exports = {
  debug: (tag, msg, extra) => write('debug', tag, msg, extra),
  info: (tag, msg, extra) => write('info', tag, msg, extra),
  warn: (tag, msg, extra) => write('warn', tag, msg, extra),
  error: (tag, msg, extra) => write('error', tag, msg, extra),
};
