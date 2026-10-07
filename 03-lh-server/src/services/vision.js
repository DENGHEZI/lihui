/**
 * 鲤慧 LiHui · 多模态识图服务
 *
 * 通道优先级：
 *  1) 智谱 GLM-4.6V（主）：ZHIPU_API_KEY 环境变量 → 本机 zhipu-vision skill 配置
 *     （本地开发开箱即用；云端部署需在云托管控制台配 ZHIPU_API_KEY 环境变量）
 *  2) ModelScope 免费推理 Qwen2.5-VL（备）：MODELSCOPE_TOKEN / preset-qwen-free 库内令牌
 *
 * 协议均为 OpenAI 兼容：messages content 用
 *   [{type:'image_url', image_url:{url:'data:image/png;base64,…'}}, {type:'text',…}]
 */
const fs = require('fs');
const path = require('path');
const modelRegistry = require('./modelRegistry');
const { fetchJSON } = require('../utils/http');
const logger = require('../utils/logger');

/** base64 字符上限（约对应 3MB 原图；readBody 全局 20MB 兜底） */
const MAX_B64_CHARS = 4 * 1024 * 1024;

/** 本机 zhipu-vision skill 配置（本地开发免配置通道） */
const ZHIPU_SKILL_CONFIG = path.join(process.env.USERPROFILE || process.env.HOME || '', '.workbuddy', 'skills', 'zhipu-vision', 'config.json');

/* ---------------- 密钥解析 ---------------- */

function resolveZhipu() {
  if (process.env.ZHIPU_API_KEY) {
    return { key: process.env.ZHIPU_API_KEY, src: 'env' };
  }
  try {
    const c = JSON.parse(fs.readFileSync(ZHIPU_SKILL_CONFIG, 'utf8'));
    if (c.api_key) return { key: c.api_key, url: c.api_url || '', model: c.default_model || 'glm-4.6v', src: 'skill-config' };
  } catch (e) { /* 文件不存在属正常（云端无此文件） */ }
  return null;
}

function resolveModelScope() {
  const m = modelRegistry.get('preset-qwen-free');
  const key = (m && m.apiKey) || process.env.MODELSCOPE_TOKEN || '';
  return key ? { key } : null;
}

/* ---------------- 入参规整 ---------------- */

/** 入参兼容裸 base64 / dataURL 两种形态，统一转 dataURL */
function normalizeDataUrl(image) {
  const s = String(image || '').trim();
  if (!s) { const e = new Error('图片内容为空'); e.code = 1001; throw e; }
  if (s.length > MAX_B64_CHARS) { const e = new Error('图片过大，请压缩后再试（≤3MB）'); e.code = 1001; throw e; }
  if (/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(s)) return s;
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(s.slice(0, 200))) { const e = new Error('image 不是合法的 base64 图片'); e.code = 1001; throw e; }
  return 'data:image/jpeg;base64,' + s.replace(/\s+/g, '');
}

/** 识图提示词：结合鲤慧「15 分钟生活圈」场景，回答普通人能直接用 */
function buildPrompt(question, loc) {
  let p = '你是「鲤慧」，面向普通市民的 15 分钟生活圈智能助手。用户发来一张照片。'
    + '请用简洁友好的中文回答（不超过 120 字）：先一句话说明照片里是什么，'
    + '再从生活圈视角给 1~2 条实用建议（例如：这是什么店铺/设施、大致价位或营业猜测、'
    + '适不适合老人小孩、周边还能怎么利用；看不清的地方要坦白说看不清，不要编造）。';
  const q = String(question || '').trim();
  if (q) p += `\n用户想问：${q}`;
  if (loc) p += `\n用户当前在北纬${loc.lat}、东经${loc.lng}附近，可结合位置合理推测，但不确定时要说明是推测。`;
  return p;
}

/* ---------------- 各通道实现 ---------------- */

async function callZhipu(z, dataUrl, prompt) {
  const base = z.url || 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
  const url = base.endsWith('/chat/completions') ? base : base + '/chat/completions';
  const raw = await fetchJSON(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${z.key}` },
    body: {
      model: z.model || 'glm-4.6v',
      messages: [{ role: 'user', content: [
        { type: 'image_url', image_url: { url: dataUrl } },
        { type: 'text', text: prompt },
      ] }],
      // ⚠️ GLM-4.6V 是思考模型：reasoning_content 先消耗 token，配小了 content 会空
      max_tokens: 1024,
    },
    timeout: 60000,
    retry: 0,
  });
  const msg = (raw.choices && raw.choices[0] && raw.choices[0].message) || {};
  let text = msg.content || '';
  if (Array.isArray(text)) text = text.map((c) => c.text || '').join('');
  // 思考把 max_tokens 吃光导致 content 为空时，退回思考链里的结论
  if (!text && msg.reasoning_content) {
    const rc = String(msg.reasoning_content).trim();
    const m = rc.match(/[“"']?([^“”"']{2,60})[”"']?[,。；;]?\s*$/);
    text = m ? m[1] : rc.slice(-60);
  }
  return { text: text.trim(), model: z.model || 'glm-4.6v', usage: raw.usage || null };
}

async function callModelScope(ms, dataUrl, prompt) {
  const models = [process.env.VISION_MODEL, 'Qwen/Qwen2.5-VL-7B-Instruct', 'Qwen/Qwen2-VL-7B-Instruct'].filter(Boolean);
  let lastErr = null;
  for (const model of models) {
    try {
      const raw = await fetchJSON('https://api-inference.modelscope.cn/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${ms.key}` },
        body: {
          model,
          messages: [{ role: 'user', content: [
            { type: 'image_url', image_url: { url: dataUrl } },
            { type: 'text', text: prompt },
          ] }],
          max_tokens: 300,
          stream: false,
        },
        timeout: 60000,
        retry: 0,
      });
      const msg = (raw.choices && raw.choices[0] && raw.choices[0].message) || {};
      let text = msg.content || '';
      if (Array.isArray(text)) text = text.map((c) => c.text || '').join('');
      if (!text) throw new Error('模型返回为空');
      return { text: text.trim(), model, usage: raw.usage || null };
    } catch (e) {
      lastErr = e;
      logger.warn('vision', `ModelScope ${model} 识别失败：${e.message}`);
    }
  }
  throw lastErr || new Error('ModelScope 无可用视觉模型');
}

/* ---------------- 主入口 ---------------- */

/**
 * 识图主入口
 * @param {{image:string, question?:string, lng?:number, lat?:number}} p
 * @returns {{reply:string, model:string, usage:object}}
 */
async function recognize({ image, question = '', lng, lat } = {}) {
  const dataUrl = normalizeDataUrl(image);
  const hasLoc = isFinite(Number(lng)) && isFinite(Number(lat));
  const prompt = buildPrompt(question, hasLoc ? { lng: Number(lng), lat: Number(lat) } : null);

  const channels = [];
  const zp = resolveZhipu();
  if (zp) channels.push({ name: 'zhipu', fn: () => callZhipu(zp, dataUrl, prompt) });
  const ms = resolveModelScope();
  if (ms) channels.push({ name: 'modelscope', fn: () => callModelScope(ms, dataUrl, prompt) });

  if (!channels.length) {
    const e = new Error('识图模型未配置：请在云托管环境变量设置 ZHIPU_API_KEY（或 MODELSCOPE_TOKEN）');
    e.code = 3002;
    throw e;
  }

  let lastErr = null;
  for (const ch of channels) {
    try {
      const r = await ch.fn();
      if (!r.text) throw new Error('模型返回为空');
      const usage = r.usage || {};
      logger.info('vision', `[${ch.name}] ${r.model} 识别成功 tokens=${usage.total_tokens || '?'}`);
      return {
        reply: r.text,
        model: r.model,
        usage: {
          prompt: usage.prompt_tokens || 0,
          completion: usage.completion_tokens || 0,
          total: usage.total_tokens || 0,
          costCny: 0,
        },
      };
    } catch (e) {
      lastErr = e;
      logger.warn('vision', `[${ch.name}] 识别失败：${e.message}`);
    }
  }
  throw new Error('识图没有成功：' + ((lastErr && lastErr.message) || '未知错误'));
}

module.exports = { recognize };
