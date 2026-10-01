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
   * multipart/form-data 字段 audio；也支持 raw body（Content-Type: audio/wav）
   */
  'POST /voice/asr': async (req, res, q, body) => {
    const raw = body && body.__raw;
    if (!raw || !raw.length) return fail(res, 1001, '请上传音频文件（字段名 audio）或 raw audio body');
    const ct = (body.__contentType || req.headers['content-type'] || '');
    const format = ct.includes('wav') ? 'wav' : ct.includes('pcm') ? 'pcm' : 'wav';
    try {
      const r = await voice.asr(raw, format);
      return ok(res, r);
    } catch (e) {
      return fail(res, 5000, `语音识别失败：${e.message}`);
    }
  },
};
