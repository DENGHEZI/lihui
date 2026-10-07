/**
 * 鲤慧 LiHui · 自定义语音路由
 */
const { ok, fail } = require('../utils/http');
const voice = require('../services/voice');

module.exports = {
  /** GET /api/v1/voice/config */
  'GET /voice/config': async (req, res) => ok(res, voice.getConfig()),

  /** POST /api/v1/voice/config */
  'POST /voice/config': async (req, res, q, body) => {
    return ok(res, voice.setConfig(body || {}));
  },

  /** POST /api/v1/voice/tts  { text, speaker?, speed? } */
  'POST /voice/tts': async (req, res, q, body) => {
    const text = String((body || {}).text || '').trim();
    if (!text) return fail(res, 1001, 'text 必填');
    if (text.length > 800) return fail(res, 1001, '单次合成文本过长（上限 800 字）');
    try {
      const r = await voice.tts(text, body || {});
      return ok(res, r);
    } catch (e) {
      return fail(res, 5000, `语音合成失败：${e.message}`);
    }
  },

  /**
   * POST /api/v1/voice/asr
   * 三种入参：① multipart/form-data 字段 audio ② raw body（audio/wav）
   * ③ JSON { audio: base64, format } —— 小程序真机走 callContainer 内网通道必须用 JSON
   *    （wx.uploadFile 直连域名会被「uploadFile 合法域名」校验拦掉）
   */
  'POST /voice/asr': async (req, res, q, body) => {
    const b = body || {};
    let raw = b.__raw;
    let format = (b.__contentType || req.headers['content-type'] || '').includes('pcm') ? 'pcm' : 'wav';
    if (!raw && b.audio) {
      const s = String(b.audio).replace(/^data:[^,]+,/, '');
      if (s.length > 2 * 1024 * 1024) return fail(res, 1001, '语音太长，请说短一点（≤60 秒）');
      raw = Buffer.from(s, 'base64');
      if (b.format === 'pcm' || b.format === 'wav') format = b.format;
    }
    if (!raw || !raw.length) return fail(res, 1001, '请上传音频文件（字段名 audio）或 JSON {audio: base64}');
    try {
      const r = await voice.asr(raw, format);
      return ok(res, r);
    } catch (e) {
      return fail(res, 5000, `语音识别失败：${e.message}`);
    }
  },
};
