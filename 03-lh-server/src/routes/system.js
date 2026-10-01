/**
 * 鲤慧 LiHui · 系统路由
 */
const config = require('../config');
const { ok } = require('../utils/http');
const hub = require('../mcp/hub');
const store = require('../services/store');

module.exports = {
  'GET /health': async (req, res) => {
    return ok(res, {
      service: 'lihui-server',
      version: '1.0.0',
      uptimeSec: Math.round(process.uptime()),
      node: process.version,
      baiduAkConfigured: !!config.baidu.ak,
      dataDir: config.dataDir,
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
};
