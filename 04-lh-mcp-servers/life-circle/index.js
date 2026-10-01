#!/usr/bin/env node
/**
 * 鲤慧 LiHui · MCP Server: life-circle
 * 15 分钟生活圈体检 —— 6 类设施覆盖度打分、短板识别、补齐建议、个性化方案定制、服务质量评价
 * 依赖百度地图能力：通过 MCP 组合调用 baidu-map Server，或直接内联调用百度 Web API。
 * 本实现内联调用百度 Web API（BAIDU_AK 环境变量），保证单文件可用。
 */
const readline = require('readline');
const http = require('http');
const https = require('https');

const AK = process.env.BAIDU_AK || '<你的百度AK>';
const BASE = process.env.BAIDU_MAP_BASE || 'https://api.map.baidu.com';

function fetchJSON(url, timeout = 9000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    lib.get(url, { timeout }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(new Error('响应解析失败')); }
      });
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('请求超时')); });
  });
}

async function poiSearch(query, lng, lat, radius, pageSize = 20) {
  // 复合关键词（「医院|药店」）：百度 place 检索不认 |，拆词逐路检索后 RRF(k=60) 融合
  const words = String(query || '').split('|').map((s) => s.trim()).filter(Boolean);
  if (words.length > 1) {
    const parts = await Promise.all(
      words.slice(0, 3).map((w) => poiSearch(w, lng, lat, radius, 10).catch(() => ({ items: [] })))
    );
    const K = 60;
    const map = new Map();
    parts.forEach((p) => {
      (p.items || []).forEach((it, idx) => {
        const key = it.uid || `${it.name}@${it.address}`;
        if (!key) return;
        const cur = map.get(key) || { item: it, rrf: 0 };
        cur.rrf += 1 / (K + idx + 1);
        map.set(key, cur);
      });
    });
    const merged = [...map.values()]
      .sort((a, b) => b.rrf - a.rrf || ((a.item.distance === null ? 9e9 : a.item.distance) - (b.item.distance === null ? 9e9 : b.item.distance)))
      .slice(0, pageSize)
      .map((x) => x.item);
    return { total: merged.length, items: merged };
  }
  const qs = new URLSearchParams({ query, location: `${lat},${lng}`, radius, page_size: pageSize, page_num: 0, scope: 2, ak: AK, output: 'json' }).toString();
  const raw = await fetchJSON(`${BASE}/place/v2/search?${qs}`);
  const items = (raw.results || []).map((x) => {
    const l = x.location || {};
    const d = x.detail_info || {};
    return { uid: x.uid || '', name: x.name || '', address: x.address || '', lng: Number(l.lng), lat: Number(l.lat), distance: d.distance !== undefined ? Number(d.distance) : null, tag: d.tag || '', type: d.type || '', rating: d.overall_rating || null };
  });
  return { total: raw.total || items.length, items };
}

/* 6 类设施权重模型 */
const CATEGORIES = [
  { key: 'medical', name: '医疗', weight: 0.25, keywords: ['医院', '社区卫生服务中心', '药店'], need: 2, desc: '看病、买药是否方便' },
  { key: 'education', name: '教育', weight: 0.15, keywords: ['幼儿园', '小学', '中学'], need: 1, desc: '孩子上学是否方便' },
  { key: 'market', name: '商业', weight: 0.20, keywords: ['超市', '菜市场', '便利店'], need: 2, desc: '买菜、日用是否方便' },
  { key: 'food', name: '餐饮', weight: 0.10, keywords: ['餐厅', '早餐店'], need: 3, desc: '吃饭、早餐是否方便' },
  { key: 'transit', name: '交通', weight: 0.20, keywords: ['公交站', '地铁站', '停车场'], need: 1, desc: '出行是否方便' },
  { key: 'leisure', name: '休闲', weight: 0.10, keywords: ['公园', '健身', '体育'], need: 1, desc: '遛弯、锻炼是否方便' },
];

async function diagnose({ lng, lat, radius = 1200 }) {
  const cats = await Promise.all(
    CATEGORIES.map(async (c) => {
      // 每类独立检索 + 失败重试 1 次；复合词查空时用单关键词二次确认，仍空才标记 failed（不计分）
      let items = [];
      let failed = false;
      for (let attempt = 0; attempt < 2 && !items.length; attempt++) {
        try {
          const r = await poiSearch(c.keywords.join('|'), lng, lat, radius, 20);
          items = r.items || [];
        } catch (_) {}
      }
      if (!items.length) {
        try {
          const r2 = await poiSearch(c.keywords[0], lng, lat, radius, 20);
          items = r2.items || [];
        } catch (_) {}
        failed = !items.length;
      }
      const hitTypes = c.keywords.filter((k) => items.some((i) => (i.name + i.tag + i.type).includes(k)));
      const ratio = failed ? null : Math.min(1, items.length / Math.max(c.need, 1));
      const typeRatio = failed ? null : hitTypes.length / c.keywords.length;
      return {
        key: c.key,
        name: c.name,
        desc: c.desc,
        weight: c.weight,
        need: c.need,
        score: failed ? null : Math.round((ratio * 0.6 + typeRatio * 0.4) * 100),
        count: items.length,
        failed,
        types: hitTypes,
        nearest: items[0] ? { name: items[0].name, distance: items[0].distance } : null,
        samples: items.slice(0, 5).map((i) => ({ name: i.name, distance: i.distance, address: i.address, rating: i.rating })),
      };
    })
  );

  // 只用检索成功的类加权（权重归一化），失败类显示「—」不计分
  const valid = cats.filter((c) => c.score !== null);
  const weightSum = valid.reduce((a, b) => a + b.weight, 0) || 1;
  const score = Math.round(valid.reduce((a, b) => a + b.score * (b.weight / weightSum), 0));
  const level = score >= 85 ? '优秀' : score >= 60 ? '良好' : score >= 40 ? '一般' : '较差';
  const shortboards = valid.filter((c) => c.score < 60).map((c) => `${c.name}：15 分钟步行可达 ${c.count} 处（达标线 ${c.need} 类），${c.nearest ? '最近为 ' + c.nearest.name + ' 约 ' + c.nearest.distance + ' 米' : '范围内未查到'}`);
  const suggestions = cats
    .filter((c) => c.score !== null && c.score < 60)
    .map((c) => ({
      医疗: '医疗是短板：建议确认最近的社区卫生服务中心门诊时间，并备好常用药；紧急情况优先拨打 120。',
      教育: '教育是短板：建议查询最近学校的招生范围，或使用共享单车将半径扩展到 3 公里。',
      商业: '商业是短板：建议沿主干道方向步行寻找菜市场，或使用线上买菜次日达作为补充。',
      餐饮: '餐饮是短板：建议自备早餐，或留意园区食堂与写字楼底商。',
      交通: '交通是短板：最近公交站较远，建议考虑共享单车接驳，或选择靠近地铁的出行方向。',
      休闲: '休闲是短板：附近缺少公园，建议沿水系或绿道方向寻找步行空间。',
    }[c.name] || `${c.name}是短板，建议扩大搜索半径。`));

  return {
    score,
    level,
    center: { lng: Number(lng), lat: Number(lat) },
    radius,
    walkMinutes: Math.round((radius / 75) * 1.25),
    categories: cats,
    shortboards,
    suggestions,
    degraded: cats.some((c) => c.failed),
    engine: 'life-circle-mcp',
  };
}

/* ------------------------------ Tools ------------------------------ */
const TOOLS = [
  {
    name: 'diagnose',
    description: '15 分钟生活圈体检：以坐标为中心，按医疗/教育/商业/餐饮/交通/休闲 6 类设施打分（0-100），输出短板与补齐建议。',
    inputSchema: { type: 'object', properties: { lng: { type: 'number' }, lat: { type: 'number' }, radius: { type: 'number', description: '步行半径（米），默认 1200 ≈ 15 分钟' } }, required: ['lng', 'lat'] },
  },
  {
    name: 'customize_plan',
    description: '个性化生活圈方案定制：按预算、是否带老人、是否需要公园等偏好生成每日动线建议。',
    inputSchema: { type: 'object', properties: { lng: { type: 'number' }, lat: { type: 'number' }, preference: { type: 'object', description: '{ budget:"low|mid|high", withElderly:bool, needPark:bool, maxWalkMinutes:number }' } }, required: ['lng', 'lat'] },
  },
  {
    name: 'service_rating',
    description: '服务质量评价参考：对指定 POI 名称给出评分、评价维度与选择建议。',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, lng: { type: 'number' }, lat: { type: 'number' } }, required: ['name'] },
  },
];

const IMPL = {
  diagnose,

  async customize_plan({ lng, lat, preference = {} }) {
    const report = await diagnose({ lng, lat, radius: 1200 });
    const find = (k) => report.categories.find((c) => c.key === k);
    const market = find('market');
    const medical = find('medical');
    const park = find('leisure');
    const plan = [
      market && market.nearest ? `上午：先到 ${market.nearest.name}（约 ${market.nearest.distance} 米）买菜，顺路在便利店补齐日用品。` : '上午：优先确认最近的买菜点，或使用线上买菜次日达。',
      medical && medical.nearest ? `下午：如需取药，到 ${medical.nearest.name}（约 ${medical.nearest.distance} 米）。` : '下午：确认最近药店位置并备常用药。',
      park && park.nearest ? `傍晚：到 ${park.nearest.name}（约 ${park.nearest.distance} 米）散步 30 分钟。` : '傍晚：沿主干道或水系方向寻找步行空间。',
    ];
    if (preference.withElderly) plan.push('考虑到有老人：优先选择有电梯、有休息座椅的场所，单次步行不超过 15 分钟，随身带好医保卡与常用药。');
    if (preference.needPark) plan.push('需要公园：若步行不可达，建议使用共享单车将半径扩展到 3 公里。');
    plan.push(`预算建议：单日生活出行成本控制在 ¥${preference.budget === 'low' ? 10 : preference.budget === 'high' ? 40 : 25} 以内。`);
    return { ...report, preference, plan };
  },

  async service_rating({ name, lng, lat }) {
    let poi = null;
    if (lng !== undefined && lat !== undefined) {
      try { poi = (await poiSearch(name, lng, lat, 3000, 3)).items[0] || null; } catch (_) {}
    }
    const rating = poi && poi.rating ? Number(poi.rating) : null;
    return {
      name,
      matched: poi ? poi.name : name,
      address: poi ? poi.address : '',
      distance: poi ? poi.distance : null,
      rating,
      dimensions: [
        { key: 'convenience', name: '便利度', hint: poi && poi.distance !== null ? (poi.distance < 500 ? '步行 7 分钟内可达，便利度高' : '距离较远，建议骑行') : '暂无距离数据' },
        { key: 'price', name: '价格透明度', hint: '建议查看门店公示价目表，优先选择明码标价的商家' },
        { key: 'service', name: '服务态度', hint: '可参考平台评价中「服务」维度，优先选择评价量 > 50 的商家' },
        { key: 'adaption', name: '适老友好', hint: '是否有无障碍通道、座椅、放大镜等，建议电话先行确认' },
      ],
      advice: rating === null
        ? '未获取到平台评分。建议：优先选择连锁品牌或社区卫生服务中心，价格与质量更稳定。'
        : rating >= 4.5
        ? '评分较高，可优先选择；仍建议到店核对价格与排队情况。'
        : rating >= 4.0
        ? '评分中等偏上，可作为备选。'
        : '评分偏低，建议另找替代，或先电话确认服务内容。',
    };
  },
};

/* ------------------------------ Server ------------------------------ */
const SERVER_INFO = { name: 'lh-life-circle', version: '1.0.0' };
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const replyOK = (id, data) => send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data) }] } });
const replyErr = (id, e) => send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: e.message || String(e) }) }] } });

readline.createInterface({ input: process.stdin, terminal: false }).on('line', async (line) => {
  const s = line.trim();
  if (!s) return;
  let msg;
  try { msg = JSON.parse(s); } catch (_) { return; }
  const { id, method, params } = msg;
  if (method === 'initialize') return send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO } });
  if (method === 'notifications/initialized' || method === 'initialized') return;
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  if (method === 'tools/call') {
    const name = params && params.name;
    const fn = IMPL[name];
    if (!fn) return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `未知工具: ${name}` } });
    try { return replyOK(id, await fn((params && params.arguments) || {})); } catch (e) { return replyErr(id, e); }
  }
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `未实现的方法: ${method}` } });
});
