/**
 * 鲤慧 LiHui · 多模态识图服务
 *
 * 通道优先级：
 *  1) 百度千帆 ERNIE-4.5-VL（主）：QIANFAN_API_KEY（完整 bce-v3/ALTAK-xx/xx 串）
 *     或 QIANFAN_AK + QIANFAN_SK（OAuth 换 access_token，缓存 25 天）
 *  2) 智谱 GLM-4.6V（备）：ZHIPU_API_KEY 环境变量 → 本机 zhipu-vision skill 配置
 *  3) ModelScope 免费推理 Qwen2.5-VL（兜底）：MODELSCOPE_TOKEN / preset-qwen-free 库内令牌
 *
 * OpenAI 兼容协议：messages content 用
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

/**
 * 百度千帆凭据解析，两种形态：
 *  · QIANFAN_API_KEY —— 控制台「安全认证」页复制的完整串（bce-v3/ALTAK-xx/xx，自带签名）直接当 Bearer
 *  · QIANFAN_AK + QIANFAN_SK —— 千帆应用 API Key/Secret Key，走 OAuth 换 access_token（30 天有效，缓存 25 天）
 */
function resolveBaidu() {
  const composite = String(process.env.QIANFAN_API_KEY || '').trim();
  if (composite) return { kind: 'bearer', key: composite, label: 'qianfan-composite' };
  const ak = String(process.env.QIANFAN_AK || '').trim();
  const sk = String(process.env.QIANFAN_SK || '').trim();
  if (ak && sk) return { kind: 'oauth', ak, sk, label: 'qianfan-oauth' };
  return null;
}

/* ---------------- 百度 OAuth 令牌（AK/SK → access_token，模块级缓存） ---------------- */

const baiduTokenCache = new Map(); // ak -> { token, expireAt }

async function getBaiduToken(auth) {
  const hit = baiduTokenCache.get(auth.ak);
  if (hit && Date.now() < hit.expireAt) return hit.token;
  const url = 'https://aip.baidubce.com/oauth/2.0/token'
    + '?grant_type=client_credentials'
    + `&client_id=${encodeURIComponent(auth.ak)}`
    + `&client_secret=${encodeURIComponent(auth.sk)}`;
  const raw = await fetchJSON(url, { method: 'POST', timeout: 15000, retry: 1 });
  if (!raw || !raw.access_token) {
    const desc = (raw && (raw.error_description || raw.error)) || '响应里没有 access_token';
    throw new Error('百度 OAuth 换取令牌失败：' + desc);
  }
  // expires_in 30 天；留 5 天安全余量
  const ttlMs = Math.max(3600, (Number(raw.expires_in) || 2592000) - 5 * 86400) * 1000;
  baiduTokenCache.set(auth.ak, { token: raw.access_token, expireAt: Date.now() + ttlMs });
  return raw.access_token;
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

/**
 * 百度图像识别（advanced_general 通用物体识别，OAuth AK/SK 鉴权）
 * 实测：千帆应用 AK/SK 换的 access_token 对「图像识别」有权限（千帆对话 VL 没权限）。
 * 返回标签后本地拼装生活圈口吻的回答，零 token 成本。
 */
async function callBaiduClassify(auth, imageB64, question) {
  const token = await getBaiduToken(auth);
  const raw = await fetchJSON(
    'https://aip.baidubce.com/rest/2.0/image-classify/v2/advanced_general?access_token=' + encodeURIComponent(token),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      // fetchJSON 的默认 Content-Type(json) 会被这里的覆盖（headers 展开在最后）
      body: 'image=' + encodeURIComponent(String(imageB64).replace(/^data:image\/[a-z]+;base64,/, '')),
      timeout: 30000,
      retry: 1,
    }
  );
  if (raw && raw.error_code) {
    throw new Error(`百度图像识别 ${raw.error_code}: ${raw.error_msg || '未知错误'}`);
  }
  const labels = ((raw && raw.result) || [])
    .filter((x) => x && x.keyword)
    .slice(0, 3)
    .map((x) => ({ name: String(x.keyword), score: Number(x.score) || 0 }));
  return { text: composeClassifyReply(labels, question), model: 'baidu-advanced_general', usage: null, labels };
}

/** 标签 → 鲤慧口吻的回答（坦白能力边界：类别级识别，答不了开放问题） */
function composeClassifyReply(labels, question) {
  if (!labels.length) {
    return '这张照片我没能认出是什么，可能太模糊或太局部了，换张清晰一点的再试试？';
  }
  const top = labels[0];
  const alt = labels.slice(1).map((x) => x.name).join('、');
  let r = `这张照片看起来是「${top.name}」（可信度 ${Math.round(top.score * 100)}%）`;
  if (alt) r += `，也可能是${alt}`;
  r += '。';
  const q = String(question || '').trim();
  if (q) {
    r += `关于「${q}」：我目前能识别物体类别，细节建议结合结果实地确认；换更清晰的照片或补充文字描述，我能答得更准。`;
  } else {
    r += '想知道价位、营业猜测或适不适合老人小孩，补充一句想问什么，我再细说。';
  }
  return r;
}


/** 从 OpenAI 兼容响应里抠出正文（含思考模型的 content 空 → reasoning_content 尾部兜底） */
function pickText(msg) {
  let text = (msg && msg.content) || '';
  if (Array.isArray(text)) text = text.map((c) => c.text || '').join('');
  if (!text && msg && msg.reasoning_content) {
    const rc = String(msg.reasoning_content).trim();
    const m = rc.match(/[“"']?([^“”"']{2,60})[”"']?[,。；;]?\s*$/);
    text = m ? m[1] : rc.slice(-60);
  }
  return String(text).trim();
}

/**
 * 百度千帆 ERNIE-4.5-VL（v2 OpenAI 兼容端点）
 * 鉴权两形态：完整 bce-v3 串直接 Bearer；AK/SK 先 OAuth 换 access_token 再 Bearer
 */
async function callQianfan(auth, dataUrl, prompt) {
  const bearer = auth.kind === 'oauth' ? await getBaiduToken(auth) : auth.key;
  const raw = await fetchJSON('https://qianfan.baidubce.com/v2/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${bearer}` },
    body: {
      model: process.env.VISION_QIANFAN_MODEL || 'ernie-4.5-vl-28b-a3b',
      messages: [{ role: 'user', content: [
        { type: 'image_url', image_url: { url: dataUrl } },
        { type: 'text', text: prompt },
      ] }],
      enable_thinking: false, // 识图要快，跳过深度思考（content 直接出结论）
      max_tokens: 1024,
      stream: false,
    },
    timeout: 60000,
    retry: 0,
  });
  if (raw && raw.error) throw new Error(`千帆 ${raw.error.code || ''}: ${raw.error.message || '未知错误'}`);
  const msg = (raw.choices && raw.choices[0] && raw.choices[0].message) || {};
  const model = (raw.model) || 'ernie-4.5-vl-28b-a3b';
  return { text: pickText(msg), model, usage: raw.usage || null };
}

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
  return { text: pickText(msg), model: z.model || 'glm-4.6v', usage: raw.usage || null };
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
  const bd = resolveBaidu();
  if (bd && bd.kind === 'oauth') {
    // AK/SK：千帆对话 VL 无权限（实测），但「图像识别」REST 有权限 —— 走 classify
    channels.push({ name: 'baidu-classify', fn: () => callBaiduClassify(bd, dataUrl, question) });
  }
  if (bd && bd.kind === 'bearer') {
    // 完整 bce-v3/ALTAK 串：可直接调千帆 ERNIE-4.5-VL（生成式，回答质量更高）
    channels.push({ name: 'qianfan-vl', fn: () => callQianfan(bd, dataUrl, prompt) });
  }
  const zp = resolveZhipu();
  if (zp) channels.push({ name: 'zhipu', fn: () => callZhipu(zp, dataUrl, prompt) });
  const ms = resolveModelScope();
  if (ms) channels.push({ name: 'modelscope', fn: () => callModelScope(ms, dataUrl, prompt) });

  if (!channels.length) {
    // ⚠️ 不用 3002（会被端上全局逻辑当成「模型未配置」弹误导弹窗），3005 走通用 toast 显示真实原因
    const e = new Error('识图模型未配置：请在云托管环境变量设置 QIANFAN_API_KEY（或 QIANFAN_AK+QIANFAN_SK / ZHIPU_API_KEY）');
    e.code = 3005;
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
