/**
 * 鲤慧 LiHui · 各地生活圈管理规范库
 * 数据：data/standards.json → 统一存储层（2026-10-06，sqlite 模式下首次读取自动导入 docs 表）
 * 体检报告与盲区分析的「评分依据」均引用本库；端上经 GET /life/standards 获取并缓存。
 */
const store = require('./store');
const logger = require('../utils/logger');

// 内置兜底：standards.json 缺失/损坏时仍能给出国家口径（warn 提示，绝不静默返回空）
const FALLBACK = {
  defaultId: 'national-2021',
  items: [
    {
      id: 'national-2021',
      match: ['全国', 'default'],
      name: '《社区生活圈规划技术指南》（TD/T 1062—2021）',
      issuer: '自然资源部',
      effective: '2021-07-01',
      quote: '以 15 分钟步行范围为空间尺度配置居民基本生活所需功能。',
      metrics: { walkMinutes: 15, radiusM: [800, 1000], walkCoverageTarget: 85, blindScoreThreshold: 40 },
      source: 'mnr.gov.cn',
    },
  ],
};

function load() {
  try {
    const data = store.read('standards', null);
    if (!data || !Array.isArray(data.items) || !data.items.length) throw new Error('standards 数据结构为空');
    return data;
  } catch (e) {
    logger.warn('standards', `load failed (${e.message}), fallback to builtin national standard`);
    return FALLBACK;
  }
}

/** 按城市名匹配适用规范：city 含 match 关键词即命中；否则回退 default / 国家标准 */
function resolve(city) {
  const data = load();
  const c = String(city || '').trim();
  let hit = null;
  if (c) {
    hit = data.items.find((s) => (s.match || []).some((k) => k !== 'default' && (c.includes(k) || k.includes(c))));
  }
  if (!hit) hit = data.items.find((s) => s.id === data.defaultId) || data.items[0];
  return {
    matched: Boolean(hit && c && (hit.match || []).some((k) => k !== 'default' && c.includes(k))),
    queriedCity: c || null,
    standard: hit,
    alternatives: data.items.map((s) => ({ id: s.id, name: s.name, issuer: s.issuer, match: s.match })),
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = { resolve, load };
