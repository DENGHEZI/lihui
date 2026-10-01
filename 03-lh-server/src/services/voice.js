/**
 * 鲤慧 LiHui · 自定义语音
 *  - 语音配置（音色 / 语速 / 音调 / 音量 / 唤醒词 / 方言 / 关怀模式）
 *  - TTS：baidu / azure / custom(HTTP) / local(端上系统 TTS 兜底)
 *  - ASR：baidu 短语音识别
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');
const store = require('./store');
const { fetchJSON } = require('../utils/http');
const logger = require('../utils/logger');

const DEFAULT_VOICE = {
  engine: 'baidu',            // baidu | azure | custom | local
  speaker: 'per_4',           // 度小美，音色温和，适合播报
  speed: 1.0,                 // 0.5 ~ 2.0
  pitch: 1.0,                 // 0.5 ~ 2.0
  volume: 1.0,                // 0 ~ 1.5
  wakeWord: '小鲤小鲤',
  dialect: 'putonghua',       // putonghua | yue | sichuan | dongbei
  autoSpeak: true,
  careMode: false,            // 关怀模式：自动降速到 0.85、音量 1.2
  customTtsUrl: '',           // engine=custom 时的 HTTP 接口
  customTtsToken: '',
  updatedAt: 0,
};

function getConfig() {
  const c = store.read('voice', null);
  return { ...DEFAULT_VOICE, ...(c || {}) };
}

function setConfig(patch) {
  const next = { ...getConfig(), ...(patch || {}), updatedAt: Date.now() };
  // 归一化
  next.speed = clamp(next.speed, 0.5, 2);
  next.pitch = clamp(next.pitch, 0.5, 2);
  next.volume = clamp(next.volume, 0, 1.5);
  if (next.careMode) {
    next.speed = Math.min(next.speed, 0.85);
    next.volume = Math.max(next.volume, 1.2);
  }
  store.write('voice', next);
  return next;
}

function clamp(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/* --------------------------- TTS --------------------------- */
let baiduToken = { value: '', expire: 0 };

async function getBaiduToken() {
  if (baiduToken.value && baiduToken.expire > Date.now()) return baiduToken.value;
  const { baiduApiKey, baiduSecretKey } = config.voice;
  if (!baiduApiKey || !baiduSecretKey) return '';
  const url = `https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials&client_id=${encodeURIComponent(baiduApiKey)}&client_secret=${encodeURIComponent(baiduSecretKey)}`;
  const raw = await fetchJSON(url, { method: 'POST', timeout: 8000 });
  if (raw && raw.access_token) {
    baiduToken = { value: raw.access_token, expire: Date.now() + (raw.expires_in || 2592000) * 1000 - 60000 };
    return baiduToken.value;
  }
  return '';
}

/**
 * 语音合成
 * @returns {{ mode:'server-audio'|'client-tts', audioUrl?, format?, base64?, text, options }}
 */
async function tts(text, opts = {}) {
  const cfg = getConfig();
  const options = {
    speed: opts.speed || cfg.speed,
    pitch: opts.pitch || cfg.pitch,
    volume: opts.volume || cfg.volume,
    speaker: opts.speaker || cfg.speaker,
    dialect: opts.dialect || cfg.dialect,
  };
  const engine = opts.engine || cfg.engine;

  // 1) 自定义 HTTP 接口
  if (engine === 'custom' && cfg.customTtsUrl) {
    try {
      const raw = await fetchJSON(cfg.customTtsUrl, {
        method: 'POST',
        headers: cfg.customTtsToken ? { Authorization: `Bearer ${cfg.customTtsToken}` } : {},
        body: { text, ...options },
        timeout: 15000,
      });
      if (raw && (raw.audioUrl || raw.url)) {
        return { mode: 'server-audio', audioUrl: raw.audioUrl || raw.url, text, options };
      }
      if (raw && raw.base64) {
        const url = saveAudio(Buffer.from(raw.base64, 'base64'), 'mp3');
        return { mode: 'server-audio', audioUrl: url, text, options };
      }
    } catch (e) {
      logger.warn('voice', `custom tts failed: ${e.message}`);
    }
  }

  // 2) 百度 TTS
  if (engine === 'baidu') {
    try {
      const token = await getBaiduToken();
      if (token) {
        const url = `https://tsn.baidu.com/text2audio?tex=${encodeURIComponent(text)}&tok=${token}&cuid=lihui&ctp=1&lan=zh&spd=${Math.round(options.speed * 5)}&pit=${Math.round(options.pitch * 5)}&vol=${Math.round(options.volume * 5)}&per=${speakerId(options.speaker)}&aue=3`;
        const buf = await fetchBinary(url);
        if (buf && buf.length > 100) {
          const audioUrl = saveAudio(buf, 'mp3');
          return { mode: 'server-audio', audioUrl, text, options };
        }
      }
    } catch (e) {
      logger.warn('voice', `baidu tts failed: ${e.message}`);
    }
  }

  // 3) 兜底：端上系统 TTS
  return { mode: 'client-tts', text, options };
}

function speakerId(name) {
  const map = { per_0: 0, per_1: 1, per_3: 3, per_4: 4, per_5: 5, per_6: 6, per_7: 7, per_8: 8, per_9: 9, per_10: 10, per_11: 11, per_12: 12, per_13: 13, per_14: 14 };
  return map[name] !== undefined ? map[name] : 4;
}

function saveAudio(buf, ext) {
  const dir = path.join(config.dataDir, 'tts');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_) {}
  const name = `tts_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.${ext}`;
  fs.writeFileSync(path.join(dir, name), buf);
  return `/static/tts/${name}`;
}

function fetchBinary(url) {
  const http = require('http');
  const https = require('https');
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    lib
      .get(url, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          const ct = String(res.headers['content-type'] || '');
          if (ct.includes('json')) return resolve(null); // 出错返回 JSON
          resolve(buf);
        });
      })
      .on('error', reject);
  });
}

/* --------------------------- ASR --------------------------- */
async function asr(audioBuffer, format = 'wav') {
  const cfg = getConfig();
  if (cfg.engine === 'baidu') {
    try {
      const token = await getBaiduToken();
      if (token) {
        const url = `https://vop.baidu.com/server_api?dev_pid=1537&cuid=lihui&token=${token}`;
        const raw = await fetchJSON(url, {
          method: 'POST',
          headers: { 'Content-Type': `audio/${format};rate=16000` },
          body: audioBuffer,
          timeout: 20000,
        });
        if (raw && raw.err_no === 0 && raw.result && raw.result[0]) {
          return { text: raw.result[0], engine: 'baidu' };
        }
      }
    } catch (e) {
      logger.warn('voice', `baidu asr failed: ${e.message}`);
    }
  }
  return {
    text: '',
    engine: 'none',
    hint: '服务端未配置语音识别密钥，请在「我的→语音设置」改用端上语音识别（uni.startRecognize / wx.getRecorderManager + 微信同声传译）。',
  };
}

module.exports = { getConfig, setConfig, tts, asr, DEFAULT_VOICE };
