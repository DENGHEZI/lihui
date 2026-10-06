/**
 * 鲤慧 LiHui · 用户习惯画像(自动学习 · memory · 个性化)
 *
 * 设计目标:用户不手动设置任何东西,系统从行为里「自己学出偏好」,
 * 再反哺到两处:①AI 助手回复特性化(prompt 注入画像摘要);
 * ②周边检索排序个性化(常搜类目 + 点过的店加权上浮)。
 *
 * 数据结构(data/profiles.json,原子写,deviceId 匿名无手机号):
 *   profiles[deviceId] = {
 *     updatedAt,
 *     cats:     { 类目: 权重 },          // 搜索/对话主题命中(医疗/商业/休闲/交通...)
 *     keywords: { 关键词: 权重 },        // 搜索原词(短词,top10 生效)
 *     places:   [ { uid, name, lng, lat, w } ],  // 点过/去过的店(uid 去重,w 累积)
 *     prefs:    { careMode: 0|1, model: '名称' }, // 偏好快照
 *     events:   累计行为数
 *   }
 *
 * 自动学习策略:
 *   - 增量即时更新(track 调用即聚合,无批量任务)
 *   - 时间衰减:每日全体权重 ×0.98(30 天半衰期≈近 3 周行为主导),
 *     读取时按 updatedAt 折算,写入时无需定时器(零依赖、无 cron)
 *   - 隐私边界:只存离散 POI 与类目计数,不存轨迹、不存坐标历史、不存身份信息;
 *     端上「个性化推荐」开关关闭时不产生任何上报
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('../utils/logger');

const FILE = path.join(config.dataDir, 'profiles.json');
const DAILY_DECAY = 0.98;
const MAX_KEYWORDS = 40;
const MAX_PLACES = 30;

let cache = null; // 内存为权威,写盘原子化

function load() {
  if (cache) return cache;
  try {
    cache = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : {};
  } catch (_) {
    cache = {};
  }
  return cache;
}
function save() {
  try {
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf8');
    fs.renameSync(tmp, FILE);
  } catch (e) {
    logger.warn('profile', `save failed: ${e.message}`);
  }
}
function of(deviceId) {
  const all = load();
  if (!all[deviceId]) all[deviceId] = { updatedAt: Date.now(), cats: {}, keywords: {}, places: [], prefs: {}, events: 0 };
  const p = all[deviceId];
  // 读取时按间隔天数整体衰减(自动遗忘冷行为)
  const days = Math.min(60, Math.max(0, (Date.now() - (p.updatedAt || Date.now())) / 86400000));
  if (days >= 1) {
    const f = Math.pow(DAILY_DECAY, days);
    for (const k of Object.keys(p.cats)) p.cats[k] = +(p.cats[k] * f).toFixed(3);
    for (const k of Object.keys(p.keywords)) p.keywords[k] = +(p.keywords[k] * f).toFixed(3);
    p.places = p.places.map((x) => ({ ...x, w: +(x.w * f).toFixed(3) })).filter((x) => x.w > 0.05);
    p.updatedAt = Date.now();
  }
  return p;
}

/** 类目关键词(与服务端 INTENTS/lifeShared 口径对齐的轻量版) */
const CAT_RULES = [
  { cat: '医疗', re: /医院|诊所|药店|药房|买药|挂号|看病/ },
  { cat: '商业', re: /菜市场|买菜|超市|便利店|商场|购物/ },
  { cat: '餐饮', re: /吃|饭|餐厅|美食|外卖|奶茶|小吃|早餐|宵夜/ },
  { cat: '休闲', re: /公园|遛弯|散步|广场|健身|景点|玩|遛娃|电影/ },
  { cat: '交通', re: /公交|地铁|车站|怎么去|导航|路线|打车/ },
  { cat: '教育', re: /学校|培训|图书馆|书店/ },
];
function catsOf(text) {
  const out = [];
  for (const r of CAT_RULES) if (r.re.test(text || '')) out.push(r.cat);
  return out.length ? out : null;
}

/* ---------------- 行为埋点 ---------------- */
function track(deviceId, event, payload = {}) {
  if (!deviceId || deviceId === 'anonymous') return;
  const p = of(deviceId);
  p.events += 1;
  p.updatedAt = Date.now();

  const bumpCats = (cats, w) => cats.forEach((c) => (p.cats[c] = +(((p.cats[c] || 0) + w)).toFixed(3)));
  const bumpKeyword = (kw, w) => {
    const k = String(kw).slice(0, 24);
    if (k) p.keywords[k] = +(((p.keywords[k] || 0) + w)).toFixed(3);
  };

  switch (event) {
    case 'search': {
      // 搜索:类目 + 关键词双记忆
      const cats = payload.category ? [payload.category] : catsOf(payload.query);
      if (cats) bumpCats(cats, 1);
      bumpKeyword(payload.query, 1);
      break;
    }
    case 'chat_topic': {
      // 对话主题:轻权重(避免聊天灌水带偏画像)
      const cats = catsOf(payload.text);
      if (cats) bumpCats(cats, 0.5);
      break;
    }
    case 'poi_click': {
      // 点店:强信号(uid 去重,w 累积)
      if (payload.uid) {
        const hit = p.places.find((x) => x.uid === payload.uid);
        if (hit) hit.w = +(hit.w + 3).toFixed(3);
        else {
          p.places.push({
            uid: String(payload.uid).slice(0, 48),
            name: String(payload.name || '').slice(0, 40),
            lng: Number(payload.lng) || 0,
            lat: Number(payload.lat) || 0,
            w: 3,
          });
        }
      }
      const cats = catsOf(payload.name);
      if (cats) bumpCats(cats, 2);
      break;
    }
    case 'navigate': {
      // 发起导航:最强信号
      if (payload.uid) {
        const hit = p.places.find((x) => x.uid === payload.uid);
        if (hit) hit.w = +(hit.w + 5).toFixed(3);
        else {
          p.places.push({
            uid: String(payload.uid).slice(0, 48),
            name: String(payload.name || '').slice(0, 40),
            lng: Number(payload.lng) || 0,
            lat: Number(payload.lat) || 0,
            w: 5,
          });
        }
      }
      break;
    }
    case 'care_toggle':
      p.prefs.careMode = payload.on ? 1 : 0;
      break;
    case 'model_switch':
      p.prefs.model = String(payload.model || '').slice(0, 40);
      break;
    default:
      break;
  }

  // 收纳:关键词/地点上限(权重低的挤掉)
  const kwKeys = Object.keys(p.keywords);
  if (kwKeys.length > MAX_KEYWORDS) {
    kwKeys.sort((a, b) => p.keywords[b] - p.keywords[a]);
    for (const k of kwKeys.slice(MAX_KEYWORDS)) delete p.keywords[k];
  }
  if (p.places.length > MAX_PLACES) {
    p.places.sort((a, b) => b.w - a.w);
    p.places = p.places.slice(0, MAX_PLACES);
  }
  save();
}

/* ---------------- 画像摘要(注入助手 prompt) ---------------- */
function summary(deviceId) {
  const p = load()[deviceId];
  if (!p || !p.events) return '';
  const cats = Object.entries(p.cats)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k]) => k);
  const kws = Object.entries(p.keywords)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([k]) => k);
  const places = [...p.places].sort((a, b) => b.w - a.w).slice(0, 2).map((x) => x.name).filter(Boolean);
  const parts = [];
  if (cats.length) parts.push(`高频关注:${cats.join('/')}`);
  if (kws.length) parts.push(`常搜:${kws.join('、')}`);
  if (places.length) parts.push(`常去或收藏:${places.join('、')}`);
  if (p.prefs.careMode) parts.push('老年关怀用户(用词请更通俗、一次只推 1 条)');
  return parts.join(';');
}

/* ---------------- 检索结果个性化排序 ---------------- */
/**
 * items: POI 数组(含 uid/name/tag 等);deviceId 匿名
 * 原则:距离仍是第一权重,个性化只做「同距离带上浮」——
 *   点过/去过的店 +大分;名字命中常搜关键词 +中分;类目命中 top2 +小分。
 */
function personalizeRank(items, deviceId) {
  if (!Array.isArray(items) || items.length < 2 || !deviceId) return items;
  const p = load()[deviceId];
  if (!p || !p.events) return items;
  const topKw = Object.entries(p.keywords)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([k]) => k);
  const topCats = Object.entries(p.cats)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([k]) => k);
  const placeMap = new Map(p.places.map((x) => [x.uid, x.w]));
  const scored = items.map((it, i) => {
    let s = items.length - i; // 原序(通常是距离序)为基线
    if (placeMap.has(it.uid)) s += 25; // 去过/点过
    const text = (it.name || '') + (it.tag || '');
    if (topKw.some((k) => k && text.includes(k))) s += 8; // 常搜关键词命中
    if (topCats.some((c) => CAT_RULES.find((r) => r.cat === c && r.re.test(text)))) s += 4; // 常搜类目
    return { it, s };
  });
  scored.sort((a, b) => b.s - a.s);
  return scored.map((x) => x.it);
}

/* ---------------- 快照 / 清除 ---------------- */
function snapshot(deviceId) {
  const p = load()[deviceId];
  if (!p || !p.events) return { learned: false, hint: '暂无学习数据:使用搜索、点店、导航后自动积累(30 天衰减)' };
  const top = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
  return {
    learned: true,
    events: p.events,
    updatedAt: new Date(p.updatedAt).toISOString(),
    topCategories: top(p.cats, 4),
    topKeywords: top(p.keywords, 8),
    frequentPlaces: [...p.places].sort((a, b) => b.w - a.w).slice(0, 5).map((x) => ({ name: x.name, w: x.w })),
    prefs: p.prefs,
  };
}
function reset(deviceId) {
  const all = load();
  if (all[deviceId]) {
    delete all[deviceId];
    save();
    return true;
  }
  return false;
}

module.exports = { track, summary, personalizeRank, snapshot, reset };
