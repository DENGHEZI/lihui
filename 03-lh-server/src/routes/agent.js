/**
 * 鲤慧 LiHui · Agent 对话路由
 */
const { ok, fail, clientIp } = require('../utils/http');
const agent = require('../services/agent');
const hub = require('../mcp/hub');
const vision = require('../services/vision');

module.exports = {
  /**
   * POST /api/v1/agent/chat
   */
  'POST /agent/chat': async (req, res, q, body) => {
    const b = body || {};
    const text = String(b.text || '').trim();
    if (!text) return fail(res, 1001, 'text 必填');
    const deviceId = b.deviceId || req.headers['x-device-id'] || 'anonymous';
    try {
      const data = await agent.chat({
        text,
        sessionId: b.sessionId || '',
        deviceId,
        careMode: !!b.careMode,
        plan: b.plan === 'free' ? 'free' : 'pro',
        lng: b.lng,
        lat: b.lat,
        ip: clientIp(req).ip,
      });
      return ok(res, data, { 'X-Token-Cost': String(data.usage.costCny || 0) });
    } catch (e) {
      if (e.code === 1003) return fail(res, 1003, e.message);
      return fail(res, 3001, `对话失败：${e.message}`);
    }
  },

  /**
   * POST /api/v1/agent/vision —— 多模态识图
   * body: { image: base64|dataURL, question?: string, lng?, lat? }
   */
  'POST /agent/vision': async (req, res, q, body) => {
    const b = body || {};
    if (!b.image) return fail(res, 1001, 'image 必填（base64 图片）');
    const deviceId = b.deviceId || req.headers['x-device-id'] || 'anonymous';
    try {
      const data = await vision.recognize({
        image: b.image,
        question: b.question,
        lng: Number(b.lng),
        lat: Number(b.lat),
        deviceId,
      });
      return ok(res, data, { 'X-Token-Cost': '0' });
    } catch (e) {
      if (e.code) return fail(res, e.code, e.message);
      return fail(res, 3001, e.message);
    }
  },

  /** GET /api/v1/agent/sessions */
  'GET /agent/sessions': async (req, res) => ok(res, { items: agent.listSessions() }),

  /** POST /api/v1/agent/sessions/clear  { sessionId } */
  'POST /agent/sessions/clear': async (req, res, q, body) => {
    if (!body || !body.sessionId) return fail(res, 1001, 'sessionId 必填');
    return ok(res, { cleared: agent.clearSession(body.sessionId) });
  },

  /** GET /api/v1/agent/tools?plan=pro —— 供端上展示「鲤慧能做什么」 */
  'GET /agent/tools': async (req, res, q) => {
    const plan = q.plan === 'free' ? 'free' : 'pro';
    const tools = hub.listTools(plan);
    const grouped = {};
    for (const t of tools) {
      grouped[t.serverId] = grouped[t.serverId] || { serverName: t.serverName, tools: [] };
      grouped[t.serverId].tools.push({ name: t.name, description: t.description });
    }
    return ok(res, { plan, total: tools.length, groups: Object.keys(grouped).map((k) => ({ serverId: k, ...grouped[k] })) });
  },
};
