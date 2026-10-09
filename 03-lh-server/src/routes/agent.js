/**
 * 鲤慧 LiHui · Agent 对话路由
 */
const { ok, fail, clientIp } = require('../utils/http');
const agent = require('../services/agent');
const hub = require('../mcp/hub');
const vision = require('../services/vision');
const standards = require('../services/standards');

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

  /** GET /api/v1/agent/standards?q= —— 标准知识库 RRF 检索（调试/演示：直接看三通道融合命中） */
  'GET /agent/standards': async (req, res, q) => {
    const query = String(q.q || '').trim();
    if (!query) return fail(res, 1001, 'q 必填');
    const hits = standards.rag ? standards.rag.search(query) : [];
    return ok(res, {
      query,
      total: hits.length,
      items: hits.map((h) => ({
        code: h.chunk.code,
        title: h.chunk.title,
        org: h.chunk.org,
        year: h.chunk.year,
        region: h.chunk.region,
        section: h.chunk.h,
        excerpt: h.chunk.text.slice(0, 160) + (h.chunk.text.length > 160 ? '…' : ''),
        rrfScore: h.rrfScore,
      })),
      // LLMWiki 图扩展：命中词条沿 related 互链带出的「参见」相关标准（TL;DR）
      wikiSeeAlso: standards.rag ? standards.rag.wikiSeeAlso(hits) : [],
    });
  },
};
