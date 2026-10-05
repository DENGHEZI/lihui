/**
 * 鲤慧 LiHui · 各地生活圈管理规范库
 * 数据：data/standards.json（自然资源部《社区生活圈规划技术指南》+ 各城市导则/规定）
 * 体检报告与盲区分析的「评分依据」均引用本库；端上经 GET /life/standards 获取并缓存。
 */
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const FILE = path.join(__dirname, '..', '..', 'data', 'standards.json');

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

let cache = null; // { mtime, data }

function load() {
  try {
    const st = fs.statSync(FILE);
    if (cache && cache.mtime === st.mtimeMs) return cache.data;
    const data = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
    if (!data || !Array.isArray(data.items) || !data.items.length) throw new Error('standards.json 结构为空');
    cache = { mtime: st.mtimeMs, data };
    return cache.data;
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
