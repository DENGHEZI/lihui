/**
 * 鲤慧 LiHui · MCP 管理路由
 */
const { ok, fail } = require('../utils/http');
const hub = require('../mcp/hub');

module.exports = {
  /** GET /api/v1/mcp/list */
  'GET /mcp/list': async (req, res) => ok(res, { servers: hub.list() }),

  /** POST /api/v1/mcp/toggle  { id, enabled } */
  'POST /mcp/toggle': async (req, res, q, body) => {
    if (!body || !body.id) return fail(res, 1001, 'id 必填');
    try {
      return ok(res, await hub.toggle(body.id, body.enabled !== false));
    } catch (e) {
      return fail(res, e.code || 4002, e.message);
    }
  },

  /** POST /api/v1/mcp/restart  { id } */
  'POST /mcp/restart': async (req, res, q, body) => {
    if (!body || !body.id) return fail(res, 1001, 'id 必填');
    try {
      await hub.restartOne(body.id);
      return ok(res, hub.list().find((x) => x.id === body.id));
    } catch (e) {
      return fail(res, e.code || 4001, e.message);
    }
  },

  /** GET /api/v1/mcp/tools?plan=pro */
  'GET /mcp/tools': async (req, res, q) => {
    const plan = q.plan === 'free' ? 'free' : 'pro';
    return ok(res, { plan, tools: hub.listTools(plan) });
  },

  /** POST /api/v1/mcp/call  { server, tool, args } */
  'POST /mcp/call': async (req, res, q, body) => {
    const b = body || {};
    if (!b.server || !b.tool) return fail(res, 1001, 'server / tool 必填');
    try {
      const r = await hub.callTool(b.server, b.tool, b.args || {});
      return ok(res, { isError: r.isError, ms: r.ms, result: r.data });
    } catch (e) {
      return fail(res, e.code || 4002, e.message);
    }
  },

  /** GET /api/v1/mcp/registry/search?keyword= */
  'GET /mcp/registry/search': async (req, res, q) => {
    try {
      const data = await hub.searchRegistry(q.keyword || '', { page: Number(q.page) || 1, pageSize: Number(q.pageSize) || 20 });
      return ok(res, data);
    } catch (e) {
      return ok(res, { source: 'error', keyword: q.keyword || '', items: hub.CURATED, hint: e.message });
    }
  },

  /** GET /api/v1/mcp/registry/curated —— 内置精选目录 */
  'GET /mcp/registry/curated': async (req, res) => ok(res, { items: hub.CURATED }),

  /** POST /api/v1/mcp/install */
  'POST /mcp/install': async (req, res, q, body) => {
    try {
      const r = await hub.install(body || {});
      return ok(res, r);
    } catch (e) {
      return fail(res, e.code || 1001, e.message);
    }
  },

  /** POST /api/v1/mcp/remove  { id } */
  'POST /mcp/remove': async (req, res, q, body) => {
    if (!body || !body.id) return fail(res, 1001, 'id 必填');
    if ((hub.list().find((x) => x.id === body.id) || {}).source === 'builtin') {
      return fail(res, 1001, '内置 MCP Server 不可删除，请改用 /mcp/toggle 禁用');
    }
    return ok(res, { removed: hub.remove(body.id) });
  },
};
