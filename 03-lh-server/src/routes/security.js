/**
 * 鲤慧 LiHui · 安全事件面板路由(管理端)
 * GET /api/v1/security/events —— 蜜罐命中 / 封禁名单 / 渠道泄露判定 / 蜜罐轮换状态。
 * 全部密钥掩码显示,不泄真值;全量审计日志在 data/logs/security.log。
 */
const { ok } = require('../utils/http');
const security = require('../utils/security');

module.exports = {
  'GET /security/events': async (req, res) => {
    return ok(res, security.eventsSnapshot());
  },
};
