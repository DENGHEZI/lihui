/**
 * 鲤慧 LiHui · 零依赖轻量 Markdown 解析器（小程序聊天渲染用）
 *
 * 把助手回复的「**加粗标题** + - 列表 + 1. 编号 + 纯段落」解析成结构化区块，
 * 供 assistant 页面渲染成分段卡片（图标徽章 + 强调条 + 自定义列表符）。
 *
 * 设计约束：
 *  - 不用正则回溯炸弹；单遍扫描；块数与条目数封顶（防超长回复卡渲染）
 *  - 识别不到任何结构时退化为「无标题单区块」，文本按原样展示
 */

const MAX_BLOCKS = 24;
const MAX_ITEMS = 12;

/** 标题关键词 → 装饰图标（小图装饰：渐变徽章底 + emoji） */
const ICONS = [
  [/结论|总结/, '🎯'],
  [/工具|检索|数据|来源/, '🔧'],
  [/替代|建议|推荐/, '💡'],
  [/出行|路线|怎么走|导航/, '🚗'],
  [/省钱|花费|预算|费用|价格/, '💰'],
  [/提醒|注意|风险|安全/, '⚠️'],
  [/方案|计划|安排/, '📋'],
  [/生活圈|体检|评分|短板/, '🩺'],
  [/天气|温度|降雨/, '🌤'],
  [/租房|买房|房源/, '🏠'],
  [/看病|医疗|药店/, '🏥'],
  [/吃饭|美食|餐厅/, '🍜'],
];

function iconOf(title) {
  const t = String(title || '');
  for (const [re, ic] of ICONS) if (re.test(t)) return ic;
  return '📌';
}

/** 行内 **加粗** 解析 → [{b:false,v:'前'},{b:true,v:'粗'},…] */
function inlineSegs(s) {
  const segs = [];
  const re = /\*\*([^*]+)\*\*/g;
  let last = 0;
  let m;
  while ((m = re.exec(s))) {
    if (m.index > last) segs.push({ b: false, v: s.slice(last, m.index) });
    segs.push({ b: true, v: m[1] });
    last = m.index + m[0].length;
  }
  if (last < s.length) segs.push({ b: false, v: s.slice(last) });
  return segs.length ? segs : [{ b: false, v: s }];
}

/**
 * 解析主入口：text → blocks[]
 * block = { title, icon, lead, items:[{ n, segs }] }（title 为空 = 无标题组；lead = 标题行冒号后的正文）
 */
function parse(text) {
  const src = String(text || '').replace(/\r\n?/g, '\n');
  if (!src.trim()) return [];
  const lines = src.split('\n');
  const blocks = [];
  let cur = null;

  const push = () => {
    if (cur && (cur.title || cur.items.length)) blocks.push(cur);
    cur = null;
  };
  const ensure = () => {
    if (!cur) cur = { title: '', icon: '📌', lead: '', items: [] };
    return cur;
  };

  for (const raw of lines) {
    if (blocks.length >= MAX_BLOCKS) break;
    const line = raw.trim();

    if (!line) {
      // 空行：仅当当前组已有内容时收组（标题后跟空行不断开，兼容 **标题**\n\n- 列表）
      if (cur && cur.items.length) push();
      continue;
    }

    // 整行加粗 → 分节标题（「**结论：xxx**」冒号后半句作为本节导语）
    const bold = line.match(/^\*\*([^*]+)\*\*[:：]?\s*$/);
    if (bold) {
      push();
      const inner = bold[1].trim();
      const ci = inner.search(/[：:]/);
      cur = ci > 0 && ci <= 14
        ? { title: inner.slice(0, ci).trim(), icon: iconOf(inner.slice(0, ci)), lead: inner.slice(ci + 1).trim(), items: [] }
        : { title: inner, icon: iconOf(inner), lead: '', items: [] };
      continue;
    }

    // 列表项：- / • / － 开头
    const li = line.match(/^[-•－·]\s+(.*)$/) || line.match(/^[-•－·](.*)$/);
    if (li && li[1].trim()) {
      const c = ensure();
      if (c.items.length < MAX_ITEMS) c.items.push({ n: '', segs: inlineSegs(li[1].trim()) });
      continue;
    }

    // 编号项：1. / 1、/ （1）
    const num = line.match(/^(\d{1,2})[.、)）]\s*(.*)$/) || line.match(/^[（(](\d{1,2})[)）]\s*(.*)$/);
    if (num && num[2]) {
      const c = ensure();
      if (c.items.length < MAX_ITEMS) c.items.push({ n: num[1], segs: inlineSegs(num[2].trim()) });
      continue;
    }

    // 普通段落
    const c = ensure();
    if (c.items.length < MAX_ITEMS) c.items.push({ n: '', segs: inlineSegs(line) });
  }
  push();

  // 全部无标题且只有一块 → 保持原样能力（渲染层按无标题组展示）
  const out = blocks.slice(0, MAX_BLOCKS);
  out.forEach((b, i) => {
    b._k = i;
    b.items.forEach((it, j) => (it._k = j));
    (b.items || []).forEach((it) => it.segs.forEach((sg, k) => (sg._k = k)));
  });
  return out;
}

module.exports = { parse, inlineSegs, iconOf };
