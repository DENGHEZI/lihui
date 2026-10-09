/**
 * 鲤慧 LiHui · 系统路由
 */
const config = require('../config');
const { ok, fail } = require('../utils/http');
const hub = require('../mcp/hub');
const store = require('../services/store');
const vision = require('../services/vision');
const monitor = require('../services/monitor');
const backup = require('../services/backup');

module.exports = {
  'GET /health': async (req, res) => {
    return ok(res, {
      service: 'lihui-server',
      version: '1.0.0',
      uptimeSec: Math.round(process.uptime()),
      node: process.version,
      pid: process.pid,
      baiduAkConfigured: !!config.baidu.ak,
      qianfan: Object.assign({ envNames: Object.keys(process.env).filter((k) => /qianfan/i.test(k)) }, vision.baiduStatus()),
      voiceAsr: { configured: !!(config.voice.baiduApiKey && config.voice.baiduSecretKey), envNames: Object.keys(process.env).filter((k) => /voice_baidu/i.test(k)) },
      dataDir: config.dataDir,
      store: store.stats(),
      mcp: { total: hub.list().length, running: hub.list().filter((x) => x.status === 'running').length },
      ts: new Date().toISOString(),
    });
  },

  'GET /config/public': async (req, res) => {
    // 只暴露可公开的配置，AK 一律不下发
    return ok(res, {
      appName: '鲤慧',
      appEnName: 'LiHui',
      plans: [
        { id: 'free', name: '免费基础版', features: ['定位', '周边搜索', '路线规划', '生活圈体检基础', '语音对话'] },
        { id: 'pro', name: '增强版（接入 API）', features: ['全部基础功能', 'MCP 工具', '成本优化', '情感疏通', '桌面应用操作', '优惠推送'] },
      ],
      mcpServers: hub.list().map((x) => ({ id: x.id, name: x.name, desc: x.desc, plan: x.plan, enabled: x.enabled, status: x.status })),
      dataFiles: ['models.json', 'voice.json', 'tokens.json', 'mcp.json', 'feedback.json', 'sessions.json'],
    });
  },

  'GET /stats': async (req, res) => {
    const models = store.collection('models').all();
    return ok(res, {
      models: models.length,
      enabledModels: models.filter((m) => m.enabled).length,
      feedback: store.collection('feedback').all().length,
      sessions: store.collection('sessions').all().length,
      mcp: hub.list().map((x) => ({ id: x.id, status: x.status, tools: x.tools.length })),
    });
  },

  /* ---------------- 监控告警（主动巡检闭环） ---------------- */
  'GET /system/metrics': async (req, res) => ok(res, monitor.latest() || (await monitor.snapshot())),

  'GET /system/alerts': async (req, res, q) =>
    ok(res, {
      thresholds: monitor.thresholds(),
      alerts: monitor.listAlerts({ includeResolved: q.all === '1' || q.all === 'true', limit: Number(q.limit) || 100 }),
    }),

  'POST /system/alerts/check': async (req, res) => ok(res, await monitor.check()),

  /* ---------------- 备份与恢复 ---------------- */
  'GET /system/backups': async (req, res) =>
    ok(res, { intervalHours: backup.intervalHours ? backup.intervalHours() : undefined, backups: backup.list() }),

  'POST /system/backups': async (req, res) => {
    try {
      return ok(res, backup.create());
    } catch (e) {
      return fail(res, 5000, `备份失败: ${e.message}`, 500);
    }
  },

  'POST /system/backups/restore': async (req, res, q, body) => {
    const name = (body && body.name) || '';
    if (!name) return fail(res, 4000, '缺少备份名 name', 400);
    if ((body && body.confirm) !== 'RESTORE') {
      return fail(res, 4000, '恢复会覆盖当前数据文件：请携带 confirm:"RESTORE" 确认', 400);
    }
    try {
      return ok(res, backup.restore(name));
    } catch (e) {
      return fail(res, 4040, e.message, 404);
    }
  },
};
