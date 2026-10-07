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

  // 3) 微软 Edge 免费合成（内置引擎，无需任何密钥——插件下线后的默认播报通道）
  if (engine !== 'custom') {
    try {
      const buf = await edgeTts(text, options);
      if (buf && buf.length > 1000) {
        const audioUrl = saveAudio(buf, 'mp3');
        return { mode: 'server-audio', audioUrl, text, options, engine: 'edge' };
      }
    } catch (e) {
      logger.warn('voice', `edge tts failed: ${e.message}`);
    }
  }

  // 4) 兜底：端上系统 TTS
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
    hint: '服务端未配置语音识别密钥：请在百度智能云免费领取「语音技术」应用，把 API Key/Secret Key 填入 VOICE_BAIDU_API_KEY / VOICE_BAIDU_SECRET_KEY 环境变量（或本地 .env）后重启即可。',
  };
}

module.exports = { getConfig, setConfig, tts, asr, DEFAULT_VOICE };

/* --------------------------- Edge 免费合成（内置，零密钥零依赖） --------------------------- */
/**
 * 微软 Edge「大声朗读」免费 TTS。协议：WSS + SSML。
 * Node 22 自带全局 WebSocket（undici）但不支持自定义请求头，
 * 而 Edge 端点强制校验 Sec-MS-GEC/Origin，故用 tls 裸套接字手写 WebSocket 握手与帧协议。
 * 参考开源 edge-tts 协议：TrustedClientToken 固定值 + GEC 时钟令牌（每 5 分钟一档）。
 */
const EDGE_TRUSTED_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const EDGE_WSS_HOST = 'speech.platform.bing.com';
// ⚠️ 2026-10 实测：版本串要与官方 edge-tts 当前值同步（旧 130 版本串/旧扩展 ID → 403）。
//    来源 rany2/edge-tts constants.py：CHROMIUM_FULL_VERSION=143.0.3650.75，扩展 ID jdiccldimpdaibmpdkjnbmckianbfold
const EDGE_CHROMIUM_VERSION = '143.0.3650.75';
const EDGE_GEC_VERSION = '1-' + EDGE_CHROMIUM_VERSION;

/** 百度音色名 → Edge 神经音色（尽量对齐「设置页音色」的听感） */
function edgeVoiceName(speaker) {
  const map = {
    per_0: 'zh-CN-XiaoyiNeural',   // 度小萌 → 晓伊（女·轻快）
    per_4: 'zh-CN-XiaoxiaoNeural', // 度小美 → 晓晓（女·温暖，默认）
    per_3: 'zh-CN-YunxiNeural',    // 度逍遥 → 云希（男·阳光）
    per_1: 'zh-CN-YunyangNeural',  // 播音男 → 云扬（男·新闻）
    per_5: 'zh-CN-XiaoyouNeural',  // 度丫丫 → 小友（童声）
  };
  return map[speaker] || 'zh-CN-XiaoxiaoNeural';
}

/** GEC 时钟令牌：Windows FILETIME 刻度向下取 5 分钟档，sha256(刻度+令牌) 大写 */
function edgeGecToken() {
  const crypto = require('crypto');
  const ticks = BigInt(Math.floor(Date.now() / 1000) + 11644473600) * 10000000n;
  const rounded = ticks - (ticks % 3000000000n); // 5 分钟 = 3e9 刻度
  return crypto.createHash('sha256').update(rounded.toString() + EDGE_TRUSTED_TOKEN).digest('hex').toUpperCase();
}

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 帧编码：客户端帧必须带 4 字节掩码 */
function wsEncodeFrame(payload, opcode) {
  const mask = require('crypto').randomBytes(4);
  const len = payload.length;
  let head;
  if (len < 126) {
    head = Buffer.alloc(2);
    head[1] = 0x80 | len;
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[1] = 0x80 | 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[1] = 0x80 | 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  head[0] = 0x80 | opcode;
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([head, mask, masked]);
}

/** 从字节流里解析一条 WS 帧（返回 {opcode, payload, rest, fin}） */
function wsParseFrame(buf) {
  if (buf.length < 2) return null;
  const fin = (buf[0] & 0x80) !== 0;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let off = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    off = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2));
    off = 10;
  }
  if (buf.length < off + (masked ? 4 : 0) + len) return null;
  let payload;
  if (masked) {
    const mask = buf.subarray(off, off + 4);
    const data = buf.subarray(off + 4, off + 4 + len);
    payload = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) payload[i] = data[i] ^ mask[i % 4];
  } else {
    payload = Buffer.from(buf.subarray(off, off + len));
  }
  return { fin, opcode, payload, rest: buf.subarray(off + (masked ? 4 : 0) + len) };
}

/**
 * Edge TTS 主实现（含 3 次重试——国内直连 speech.platform.bing.com 有间歇性 RST）
 * @param {string} text
 * @param {{speed:number, pitch:number, volume:number, speaker:string}} o
 * @returns {Promise<Buffer>} mp3
 */
async function edgeTts(text, o) {
  let lastErr = null;
  for (let i = 0; i < 3; i++) {
    try {
      return await edgeTtsOnce(text, o);
    } catch (e) {
      lastErr = e;
      if (i < 2) await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw lastErr;
}

function edgeTtsOnce(text, o) {
  const tls = require('tls');
  return new Promise((resolve, reject) => {
    const gec = edgeGecToken();
    const connectionId = require('crypto').randomBytes(16).toString('hex');
    const path = `/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${EDGE_TRUSTED_TOKEN}&Sec-MS-GEC=${gec}&Sec-MS-GEC-Version=${EDGE_GEC_VERSION}&ConnectionId=${connectionId}`;
    const key = require('crypto').randomBytes(16).toString('base64');

    const voice = edgeVoiceName(o.speaker);
    const rate = `${o.speed >= 1 ? '+' : ''}${Math.round((o.speed - 1) * 100)}%`;
    const pitchHz = `${o.pitch >= 1 ? '+' : ''}${Math.round((o.pitch - 1) * 50)}Hz`;
    const vol = `${o.volume >= 1 ? '+' : ''}${Math.round((o.volume - 1) * 50)}%`;
    const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'><voice name='${voice}'>`
      + `<prosody rate='${rate}' pitch='${pitchHz}' volume='${vol}'>${xmlEscape(text)}</prosody></voice></speak>`;

    const ts = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const reqId = require('crypto').randomBytes(16).toString('hex');
    const configMsg = `X-Timestamp:${ts()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n`
      + JSON.stringify({ context: { synthesis: { audio: { metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' }, outputFormat: 'audio-24khz-48kbitrate-mono-mp3' } } } });
    const ssmlMsg = `X-RequestId:${reqId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${ts()}Z\r\nPath:ssml\r\n\r\n${ssml}`;

    const chunks = [];
    let buf = Buffer.alloc(0);
    let settled = false;
    const done = (err, val) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch (_) {}
      err ? reject(err) : resolve(val);
    };
    const timer = setTimeout(() => done(new Error('edge tts timeout')), 30000);

    const sock = tls.connect({ host: EDGE_WSS_HOST, port: 443, servername: EDGE_WSS_HOST }, () => {
      sock.write(
        `GET ${path} HTTP/1.1\r\n`
        + `Host: ${EDGE_WSS_HOST}\r\n`
        + `Pragma: no-cache\r\n`
        + `Cache-Control: no-cache\r\n`
        + `Origin: chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold\r\n`
        + `User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${EDGE_CHROMIUM_VERSION} Safari/537.36 Edg/${EDGE_CHROMIUM_VERSION}\r\n`
        + `Accept-Language: en-US,en;q=0.9\r\n`
        + `Sec-WebSocket-Key: ${key}\r\n`
        + `Sec-WebSocket-Version: 13\r\n`
        + `Sec-MS-GEC: ${gec}\r\n`
        + `Sec-MS-GEC-Version: ${EDGE_GEC_VERSION}\r\n`
        + `Connection: Upgrade\r\nUpgrade: websocket\r\n\r\n`
      );
    });

    let handshaken = false;
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!handshaken) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx < 0) return;
        const head = buf.subarray(0, idx).toString();
        if (!/^HTTP\/1\.1 101 /.test(head)) {
          done(new Error('edge ws handshake failed: ' + head.split('\r\n')[0]));
          return;
        }
        handshaken = true;
        buf = buf.subarray(idx + 4);
        // 握手成功 → 发 speech.config 与 SSML
        sock.write(wsEncodeFrame(Buffer.from(configMsg), 1));
        sock.write(wsEncodeFrame(Buffer.from(ssmlMsg), 1));
      }
      // 解析帧
      for (;;) {
        const f = wsParseFrame(buf);
        if (!f) break;
        buf = f.rest;
        if (f.opcode === 8) { done(new Error('edge ws closed early')); return; }
        if (f.opcode === 1) {
          const txt = f.payload.toString();
          if (/Path:turn\.end/.test(txt)) {
            clearTimeout(timer);
            const audio = Buffer.concat(chunks);
            if (audio.length > 1000) done(null, audio);
            else done(new Error('edge tts empty audio'));
          }
        } else if (f.opcode === 2 && f.payload.length > 2) {
          // 二进制音频：前 2 字节 BE = 头部长度
          const hLen = f.payload.readUInt16BE(0);
          if (f.payload.length > hLen + 2) chunks.push(f.payload.subarray(hLen + 2));
        }
      }
    });
    sock.on('error', (e) => done(e));
    sock.on('close', () => { if (!settled) done(new Error('edge ws closed before audio')); });
  });
}
