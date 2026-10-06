/**
 * 鲤慧 LiHui · Memory 人机协同安全运维路由
 *
 *  GET  /api/v1/memory/overview   面板聚合(事件/建议/处置记忆/引擎状态)——公开只读
 *  POST /api/v1/memory/analyze    收集→脱敏→DeepSeek 分析→建议入库   【管理令牌】
 *  POST /api/v1/memory/verify     沙箱验证某条建议(nginx 语法+样本回放) 【管理令牌】
 *  POST /api/v1/memory/decide     人工批准/拒绝(批准产出工件,绝不自动执行)【管理令牌】
 *
 *  管理令牌:env MEMORY_ADMIN_TOKEN;未配置时仅允许本机回环调用(本地开发方便,
 *  线上必须配置令牌,否则写操作一律 403)。
 */
const { ok, fail } = require('../utils/http');
const config = require('../config');
const memory = require('../services/memory');
const logger = require('../utils/logger');

function isLoopback(req) {
  const r = (req.socket && (req.socket.remoteAddress || '')) || '';
  return r === '127.0.0.1' || r === '::1' || r === '::ffff:127.0.0.1';
}
function isAdmin(req) {
  const t = config.memory.adminToken;
  if (!t) return isLoopback(req); // 未配置令牌:仅本机可写
  return (req.headers['x-admin-token'] || '') === t;
}
function guard(req, res, traceId) {
  if (isAdmin(req)) return true;
  fail(res, 4031, config.memory.adminToken ? '需要管理令牌（X-Admin-Token）' : '写操作仅限本机调用，或配置 MEMORY_ADMIN_TOKEN 后携带 X-Admin-Token', 403, { traceId });
  return false;
}

module.exports = {
  'GET /memory/overview': async (req, res) => {
    const o = memory.overview();
    o.admin = isAdmin(req);
    return ok(res, o);
  },

  'POST /memory/analyze': async (req, res, q, body) => {
    if (!guard(req, res, body.traceId)) return;
    try {
      const r = await memory.analyze();
      logger.info('memory', `AI 分析完成(${r.analysis.engine}),新建议 ${r.suggestions.length} 条,脱敏 ${JSON.stringify(r.sanitized.report)}`);
      return ok(res, {
        diagnosis: r.analysis.diagnosis,
        threatLevel: r.analysis.threatLevel || 'low',
        engine: r.analysis.engine,
        degraded: r.degraded,
        sanitizeReport: r.sanitized.report,
        sanitizedPreview: r.sanitized.text.slice(0, 2000), // 人类可复核「DeepSeek 到底看到了什么」
        suggestions: r.suggestions,
      });
    } catch (e) {
      return fail(res, 5000, `分析失败：${e.message}`, 500);
    }
  },

  'POST /memory/verify': async (req, res, q, body) => {
    if (!guard(req, res, body.traceId)) return;
    const r = memory.verifySuggestion(String(body.id || ''));
    if (!r) return fail(res, 4040, '建议不存在', 404);
    return ok(res, r);
  },

  'POST /memory/decide': async (req, res, q, body) => {
    if (!guard(req, res, body.traceId)) return;
    const r = memory.decide(String(body.id || ''), String(body.action || ''), body.note, body.by || 'admin');
    if (!r) return fail(res, 4040, '建议不存在', 404);
    if (r.error) return fail(res, 4001, r.error, 400);
    return ok(res, r);
  },
};
