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

/* ==================== 国际标准知识库 RAG（2026-10-08 新增） ==================== */
/* 用户需求：「在对话引入 RRF 算法提高回答准确度，将国际标准做成知识库，利用 RAG 给大模型」。
 *
 * ▍为什么用 RRF：单一检索通道各有盲区——
 *   1) BM25 字面通道：命中字面，不懂「步行圈 ≈ 生活圈 ≈ walkability」
 *   2) 标签/标题通道：按主题召回，对冷门措辞不敏感
 *   3) 类目先验通道：懂「问的是哪类事」，不看字面
 *   三路各自排名后用 Reciprocal Rank Fusion（k=60，与 baiduMap 复合词融合同参数，
 *   Cormack et al. 2009 SIGIR 实证的通用做法）融合，比加权分数拼接更稳健。
 *
 * ▍RAG 注入约定：命中 chunk 以「编号 + 标准号 + 出处 + 原文摘要」注入模型上下文，
 *   并在提示词里强制「只引用注入的标准，禁止凭记忆编造编号/指标」——
 *   大模型对 ISO/GB 编号极易幻觉，必须由知识库提供原文。
 */
const fs = require('fs');
const path = require('path');
const { rrfFuse } = require('../utils/rrf');

const KB_FILE = path.resolve(__dirname, '..', '..', 'data', 'standards-kb.json');
let KB = { docs: [] };
try {
  KB = JSON.parse(fs.readFileSync(KB_FILE, 'utf8'));
  if (!Array.isArray(KB.docs)) KB.docs = [];
  logger.info('standards', `国际标准知识库装载 ${KB.docs.length} 部（版本 ${KB.version || 'na'}）`);
} catch (e) {
  logger.warn('standards', `国际标准知识库缺失（RAG 静默降级）：${e.message}`);
}

/* 索引单元：一个 section = 一个 chunk */
const CHUNKS = [];
KB.docs.forEach((d) => {
  (d.sections || []).forEach((s, i) => {
    CHUNKS.push({
      docId: d.id, code: d.code, title: d.title, org: d.org, year: d.year, region: d.region,
      summary: d.summary || '', tags: d.tags || [], h: s.h || '', text: s.text || '',
      keys: s.keys || [], chunkId: `${d.id}#${i}`,
    });
  });
});

/* 中文分词：字符 bigram（零分词器近似）+ 英文/数字编号整词（ISO/GB/37120 必须整体命中） */
function bigrams(s) {
  const t = String(s).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');
  const out = [];
  for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2));
  const words = String(s).toLowerCase().match(/[a-z][a-z0-9.]+|\d{2,}/g) || [];
  return [...out, ...words];
}

/* BM25-lite（IDF 进程内预计算） */
const DF = new Map();
CHUNKS.forEach((c) => {
  new Set(bigrams([c.code, c.title, c.h, c.text, c.summary].join(' '))).forEach((g) => {
    DF.set(g, (DF.get(g) || 0) + 1);
  });
});
const NC = CHUNKS.length || 1;
const idf = (g) => Math.log(1 + (NC - (DF.get(g) || 0) + 0.5) / ((DF.get(g) || 0) + 0.5));
const BM25_K1 = 1.2, BM25_B = 0.75;
const AVG_LEN = CHUNKS.reduce((s, c) => s + c.text.length, 0) / NC || 1;

function bm25Rank(query) {
  const qs = [...new Set(bigrams(query))];
  if (!qs.length) return [];
  return CHUNKS.map((c) => {
    const body = bigrams([c.code, c.title, c.h, c.text, c.summary].join(' '));
    const tf = new Map();
    body.forEach((g) => tf.set(g, (tf.get(g) || 0) + 1));
    let score = 0;
    qs.forEach((g) => {
      const f = tf.get(g) || 0;
      if (!f) return;
      score += idf(g) * ((f * (BM25_K1 + 1)) / (f + BM25_K1 * (0.25 + BM25_B * (c.text.length / AVG_LEN))));
    });
    return { item: c, score };
  })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);
}

/* 通道 2：标签/标题/要点词 覆盖匹配 */
function tagRank(query) {
  const qs = [...new Set(bigrams(query))];
  if (!qs.length) return [];
  return CHUNKS.map((c) => {
    const set = new Set(bigrams([c.code, c.title, c.h, c.tags.join(' '), c.keys.join(' '), c.summary].join(' ')));
    const hit = qs.filter((g) => set.has(g)).length;
    return hit ? { item: c, score: hit / qs.length } : null;
  })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);
}

/* 通道 3：类目先验（问题主题 → 相关 docId 集合） */
const TOPIC_DOCS = [
  { re: /生活圈|一刻钟|15分钟|15 分钟|五分钟|十分钟/, docs: ['gb50180-2018', 'td1062-2021', 'shanghai-guide-2016', 'mofss-commerce-2021', '15min-city-moreno'] },
  { re: /步行|walking|walkab|慢行|骑行/, docs: ['who-walkability', '15min-city-moreno', 'gb50180-2018', 'leed-nd'] },
  { re: /国际|iso\d|ISO|联合国|UN\b|SDG|全球|国外/, docs: ['iso37120-2018', 'sdg11', 'iso37101-2016', 'iso37122-2019', 'iso37170-2022'] },
  { re: /指标|评价|评估|考核|评分/, docs: ['iso37120-2018', 'iso37122-2019', 'td1062-2021', 'gb50180-2018'] },
  { re: /配套|设施|学校|幼儿园|养老|医院|商业|菜场|菜市场|便利店/, docs: ['gb50180-2018', 'mohurd-complete-community-2022', 'mofss-commerce-2021', 'td1062-2021'] },
  { re: /智慧|数字|数字化|MaaS|一网通办/, docs: ['iso37122-2019'] },
  { re: /应急|避难|韧性|resilien/, docs: ['iso37170-2022', 'iso37101-2016'] },
  { re: /绿色|认证|LEED|BREEAM|生态|海绵/, docs: ['leed-nd', 'breeam-communities'] },
  { re: /健康|WHO|老人|适老|无障碍|儿童|全龄/, docs: ['who-walkability', 'td1062-2021', 'mohurd-complete-community-2022', 'sdg11'] },
  { re: /治理|管理体系|参与式|PDCA/, docs: ['iso37101-2016', 'breeam-communities'] },
];
function topicRank(query) {
  const docIds = new Set();
  TOPIC_DOCS.forEach((t) => {
    if (t.re.test(query)) t.docs.forEach((d) => docIds.add(d));
  });
  if (!docIds.size) return [];
  return CHUNKS.filter((c) => docIds.has(c.docId)).map((item) => ({ item, score: 1 }));
}

/* 触发判定：问题提到标准/规范/指标/国际……才查库（其余闲聊不浪费上下文） */
const STANDARDS_RE = /(标准|规范|导则|指南|指标|体系|口径|对标|国际|国家|ISO|GB\s?\d|TD\/T|LEED|BREEAM|WHO|SDG|联合|世卫|权威|依据|出处|参考文献|评分|规定|要求)/i;

/* 主检索：三通道 → RRF 融合 → top K（每部标准最多 2 段防刷屏） */
const TOP_K = 4;
function search(query) {
  const fused = rrfFuse([bm25Rank(query), tagRank(query), topicRank(query)], { k: 60, keyOf: (c) => c.chunkId });
  const perDoc = new Map();
  const picked = [];
  for (const { item, score } of fused) {
    const n = perDoc.get(item.docId) || 0;
    if (n >= 2) continue;
    perDoc.set(item.docId, n + 1);
    picked.push({ chunk: item, rrfScore: Number(score.toFixed(4)) });
    if (picked.length >= TOP_K) break;
  }
  return picked;
}

/**
 * RAG 上下文构建（agent 对话注入用）
 * @returns {null|string} null=未触发/无命中；string=注入块
 */
function maybeRetrieve(text) {
  if (!STANDARDS_RE.test(String(text))) return null;
  const hits = search(text);
  if (!hits.length) return null;
  const lines = hits.map((h, i) => {
    const c = h.chunk;
    return `[${i + 1}] ${c.code}《${c.title}》（${c.org}，${c.year}，${c.region}）— ${c.h}\n${c.text}`;
  });
  // LLMWiki 图扩展：沿词条互链补「参见」块（跨标准关联口径）
  const seeAlso = wikiSeeAlso(hits);
  if (seeAlso.length) lines.push('【参见 · 相关标准词条（TL;DR）】\n' + seeAlso.map((s) => `→ ${s}`).join('\n'));
  return (
    '（系统注入的标准知识库检索结果，RRF 三通道融合 + LLMWiki 词条图扩展，非用户发言）\n' +
    lines.join('\n---\n') +
    '\n使用要求：1) 引用标准必须给出编号与名称（如 GB 50180-2018、ISO 37120:2018）；' +
    '2) 指标数值只能来自以上原文，禁止凭记忆编造；3) 与问题无关的条目不要提；' +
    '4) 「参见」条目仅在确有关联时简述，不确定就略去。'
  );
}

/* 命中清单（toolCallsLog / 前端展示用） */
function lastSources(hits) {
  return (hits || []).map((h) => ({ code: h.chunk.code, title: h.chunk.title, org: h.chunk.org, year: h.chunk.year }));
}

/* ------------------------------------------------------------------ */
/* LLMWiki：维基式知识图谱检索（2026-10-09 升级）                       */
/* ------------------------------------------------------------------
 * 从「扁平段落检索」升级为「wiki 词条图 + 图扩展检索」：
 *  1. 知识库每部标准是一个词条页（doc），页间 related 互链（data/standards-kb.json）；
 *  2. 命中词条后沿 related **一跳扩展**，把相关词条的 TL;DR（summary）作
 *     「参见」块注入 LLM 上下文——单次检索获得跨标准的关联口径，
 *     如问 ISO 37120 自动带出 SDG 11 / ISO 37122 的相关条目；
 *  3. TL;DR 取 doc.summary（LLM 时代人工精炼要点，零额外 token 成本）；
 *  4. 扩词条 = 在 kb json 加一条 docs + related 即自动入图，无需改代码。
 */
const WIKI_SEE_ALSO_MAX = 3;
function docById(id) {
  return (KB.docs || []).find((d) => d.id === id) || null;
}

/** 维基图扩展：从命中 docId 出发一跳 related，返回「参见」行数组 */
function wikiSeeAlso(picked) {
  const hitDocIds = new Set(picked.map((h) => h.chunk.docId));
  const seen = new Set();
  const rows = [];
  for (const h of picked) {
    const doc = docById(h.chunk.docId);
    for (const rid of (doc && doc.related) || []) {
      if (hitDocIds.has(rid) || seen.has(rid)) continue;
      seen.add(rid);
      const rd = docById(rid);
      if (rd) rows.push(`${rd.code}《${rd.title}》— ${rd.summary}`);
      if (rows.length >= WIKI_SEE_ALSO_MAX) return rows;
    }
  }
  return rows;
}

/** 词条图概览（调试 /agent/standards?wiki=1 用） */
function wiki() {
  return (KB.docs || []).map((d) => ({
    id: d.id,
    code: d.code,
    title: d.title,
    sections: Array.isArray(d.sections) ? d.sections.length : 0,
    related: d.related || [],
  }));
}

module.exports.rag = { search, maybeRetrieve, lastSources, STANDARDS_RE, wikiSeeAlso, wiki };
