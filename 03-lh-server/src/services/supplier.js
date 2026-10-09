/**
 * 鲤慧 LiHui · 供应商价格适配层（可插拔）
 *
 * 为什么要有这一层：
 *  百度地图 place 检索只能拿到【真实店铺】的店名 / 地址 / 坐标 / 电话，
 *  它【不给成交价、不给库存】——房价、菜单价、服务价全在携程 / 美团 / 大众点评手里。
 *  这些第三方开放平台 Either 要商家资质、要么要商务签约，鲤慧（一家小程序产品）拿不到，
 *  所以不能让「真实价格」这件事卡死整个链路。
 *
 * 本层的设计取舍：
 *  · 鲤慧侧永远能给出「参考价」（按类目 + 店型规则估算，前端明确标注为参考价）。
 *  · 一旦你把对应平台的 key 填进环境变量，这一层会【优先】去拉真实价，
 *    拉到就用真实价（前端不再显示"参考"角标），拉不到自动回落参考价 —— 链路不断。
 *  · 请求模板完全由环境变量驱动（URL / 方法 / Header / Body / 返回路径），
 *    所以换成携程、美团、飞猪、自建中台、甚至你自己搭的代理都行，
 *    【不用改代码】，见 00-设计文档/真实价格接口接入指南.md。
 *
 * 环境变量（以 ctrip 为例，meituan / eleme / douyin 把前缀换成对应平台前缀即可）：
 *    CTROP_APP_ID      应用 ID
 *    CTROP_APP_KEY     应用密钥
 *    CTROP_URL         真实价格查询接口地址（必填，填了才算启用）
 *    CTROP_METHOD      GET / POST，默认 POST
 *    CTROP_BODY        Body 模板，支持 {{keyword}} {{name}} {{city}} {{lng}} {{lat}} {{appId}} {{appKey}} {{sign}}
 *    CTROP_HEADERS     JSON 格式的额外 Header
 *    CTROP_AUTH        鉴权值，支持 {{appKey}} / {{appId}}，如 "Bearer {{appKey}}"
 *    CTROP_PRICE_PATH  返回里价格的 JSON 路径，默认 data.price
 *    CTROP_TITLE_PATH  返回里标题的 JSON 路径（可选）
 *    CTROP_URL_PATH    返回里商品链接的 JSON 路径（可选，拿到就能直接跳真实商品页）
 *    CTROP_RATING_PATH 返回里评分的 JSON 路径（可选，外卖平台识别用）
 *    CTROP_TTL         结果缓存毫秒，默认 5 分钟（防止刷爆第三方配额）
 *    CTROP_SEARCH_URL  平台「搜这家店」的公开网页深链模板（无商户号时也能用，仅做跳转，非 API）
 *
 * ── 外卖平台「联网识别」能力（2026-10）──
 * 美团 / 饿了么 / 抖音【没有】公开的店铺检索 API（要商户/渠道资质；爬取违反 robots + 小程序审核过不了）。
 * 因此本层对「门店在不在外卖平台、什么价、什么评分」采用两层设计：
 *  ① 静态层（零网络，catalog 构建期落库）：给每个门店挂 platforms 字段 = 各外卖平台的【搜这家店】公开深链，
 *     verified:false / onShelf:null —— 前端显示「去美团/饿了么/抖音看看」，用户点开即看到平台实时在架/价格/评分。
 *  ② 实时层（按需 /shop/identify，配了 *_URL 才联网）：拉到真实 onShelf/price/rating → verified:true；
 *     没配 key 时则只回深链（verified:false），绝不编造在架状态或价格。
 */
const crypto = require('crypto');
const config = require('../config');
const logger = require('../utils/logger');
const { cache } = require('../utils/cache');
const { fetchJSON } = require('../utils/http');

/* ---------------- 平台元信息（名字、配色、申请入口，只做展示用） ----------------
 * kind: 'delivery' = 外卖 / 本地生活平台（门店维度「联网识别在架/价格/评分」的对象）
 *       'travel'   = 酒旅 / 门票（按类目给参考价，不参与外卖识别）
 * searchUrl: 平台「搜这家店」的【公开网页】深链模板（非 API，仅做跳转；
 *            无商户号时也能用，env 可覆盖为 *_SEARCH_URL）。关键词变量 {{keyword}}/{{name}}/{{city}}/{{lng}}/{{lat}}。
 */
const PLATFORMS = {
  ctrip: {
    name: '携程',
    color: '#3ab0ff',
    kind: 'travel',
    envPrefix: 'CTROP',
    envKeys: ['CTROP_APP_ID', 'CTROP_APP_KEY', 'CTROP_URL'],
    docs: 'https://open.ctrip.com/',
    note: '酒店房价 / 门票库存，需商家或渠道商资质；个人开发者通常只能拿到「搜索页链接」。',
  },
  meituan: {
    name: '美团',
    color: '#ffc300',
    kind: 'delivery',
    envPrefix: 'MEITUAN',
    envKeys: ['MEITUAN_APP_ID', 'MEITUAN_APP_KEY', 'MEITUAN_URL'],
    docs: 'https://open.meituan.com/',
    note: '到店餐饮 / 团购 / 外卖，需商户号；没有商户号时走「搜这家店」公开深链。',
    searchUrl: 'https://www.meituan.com/search/?query={{keyword}}',
  },
  eleme: {
    name: '饿了么',
    color: '#0085ff',
    kind: 'delivery',
    envPrefix: 'ELEME',
    envKeys: ['ELEME_APP_ID', 'ELEME_APP_KEY', 'ELEME_URL'],
    docs: 'https://open-api.ele.me/',
    note: '外卖到店 / 到家，需商户号；没有商户号时走「搜这家店」公开深链。',
    searchUrl: 'https://www.ele.me/search/?keyword={{keyword}}',
  },
  douyin: {
    name: '抖音',
    color: '#161823',
    kind: 'delivery',
    envPrefix: 'DOUYIN',
    envKeys: ['DOUYIN_APP_ID', 'DOUIN_APP_KEY', 'DOUYIN_URL'],
    docs: 'https://open.douyin.com/',
    note: '本地生活到店团购，需商家 / 机构资质；没有资质时走「搜这家店」公开深链。',
    searchUrl: 'https://www.douyin.com/search/{{keyword}}?type=poi',
  },
};

/** 仅外卖 / 本地生活类平台（参与门店维度「联网识别」的集合） */
const DELIVERY_PLATFORMS = Object.keys(PLATFORMS).filter((k) => PLATFORMS[k].kind === 'delivery');

/* ---------------- 小工具 ---------------- */
function cfg(platform, key, d = '') {
  const p = PLATFORMS[platform];
  if (!p) return d;
  return process.env[p.envPrefix + '_' + key] === undefined ? d : process.env[p.envPrefix + '_' + key];
}
function cfgNum(platform, key, d) {
  const n = Number(cfg(platform, key, ''));
  return Number.isFinite(n) && n > 0 ? n : d;
}

/** 支持 a.b[0].c 的极简 JSON 取值 */
function jsonPath(obj, expr) {
  if (!expr) return undefined;
  const steps = String(expr)
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean);
  let cur = obj;
  for (const s of steps) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[s];
  }
  return cur;
}

/** 模板渲染：{{keyword}} → 真实值；{{sign}} → body 的 HMAC-SHA1 大写 hex */
function render(tpl, vars) {
  if (tpl === undefined || tpl === null) return tpl;
  return String(tpl).replace(/\{\{(\w+)(?::([^}]+))?\}\}/g, (m, k, arg) => {
    if (k === 'sign' || k === 'hmacsha1') {
      return crypto.createHmac('sha1', vars.appKey || '').update(vars.__body || '').digest('hex').toUpperCase();
    }
    if (k === 'md5') {
      return crypto.createHash('md5').update(vars.__body || '').digest('hex');
    }
    return vars[k] === undefined || vars[k] === null ? '' : String(vars[k]);
  });
}

/* ---------------- 参考价（第三方没接时的兜底，前端会标"参考"） ---------------- */
/**
 * 参考价规则：类目基准区间 + 店型关键词微调。
 * ⚠️ 这不是真实成交价，只是让商城能跑起来的量级估计，前端必须带「参考」角标。
 */
function estimate(item = {}) {
  const name = String(item.name || '');
  const lowHook = /招待所|旅馆|民宿|公寓|客栈|青旅|青年旅舍/i.test(name) ? 0.6 : 1;
  const highHook = /国际|五星|四星|豪生|喜来登|假日|铂尔曼|丽呈/i.test(name) ? 2.4 : 1;
  const base = {
    hotel: [158, 420],
    ticket: [58, 168],
    food: [28, 88],
    service: [78, 268],
  }[item.category] || [48, 158];

  const lo = Math.round((base[0] * lowHook * highHook) / 10) * 10;
  const hi = Math.round((base[1] * lowHook * highHook) / 10) * 10;
  return {
    price: lo,
    originPrice: hi,
    unit: item.unit || (item.category === 'hotel' ? '晚' : item.category === 'ticket' ? '张' : item.category === 'food' ? '份' : '次'),
    estimated: true,
  };
}

/* ---------------- 各渠道接入状态（给前端 / 文档用） ---------------- */
function status(platformKey) {
  const keys = platformKey ? [platformKey] : Object.keys(PLATFORMS);
  return keys.map((k) => {
    const p = PLATFORMS[k];
    const enabled = Boolean(cfg(k, 'URL'));
    const missing = p.envKeys.filter((x) => !process.env[x]);
    return {
      platform: k,
      name: p.name,
      color: p.color,
      kind: p.kind || 'travel',
      enabled,
      missing,
      endpoint: cfg(k, 'URL', ''),
      searchUrl: searchUrlOf(k, { supplier: {}, name: '', city: '' }),
      note: p.note,
      docs: p.docs,
    };
  });
}

/** 该渠道是否接了真实价格 */
const isEnabled = (platform) => Boolean(cfg(platform, 'URL'));

/* ---------------- 拉真实价 ---------------- */
async function lookup(item, platformKey) {
  const platform = platformKey || (item && item.supplier && item.supplier.platform) || 'ctrip';
  if (!PLATFORMS[platform]) return { available: false, reason: 'unknown_platform' };

  if (!isEnabled(platform)) {
    return { available: false, reason: 'no_key', message: `${PLATFORMS[platform].name}真实价格接口未配置（缺 ${PLATFORMS[platform].envPrefix}_URL）` };
  }

  const url = cfg(platform, 'URL');
  const method = (cfg(platform, 'METHOD', 'POST') || 'POST').toUpperCase();
  const bodyRaw = cfg(platform, 'BODY', '{"keyword":"{{keyword}}","city":"{{city}}"}');
  const pricePath = cfg(platform, 'PRICE_PATH', 'data.price') || 'data.price';
  const titlePath = cfg(platform, 'TITLE_PATH', '');
  const urlPath = cfg(platform, 'URL_PATH', '');
  const ttl = cfgNum(platform, 'TTL', 5 * 60 * 1000);

  const city = (item && item.city) || (item && item.district) || '';
  const vars = {
    appId: cfg(platform, 'APP_ID', ''),
    appKey: cfg(platform, 'APP_KEY', ''),
    keyword: (item && item.supplier && item.supplier.keyword) || (item && item.name) || '',
    name: (item && item.name) || '',
    city,
    lng: (item && item.lng) !== undefined ? String(item.lng) : '',
    lat: (item && item.lat) !== undefined ? String(item.lat) : '',
    uid: (item && item.poiUid) || (item && item.id) || '',
  };

  // 真实 body 要先定下来，因为 {{sign}} 依赖它
  const finalBody = render(bodyRaw, { ...vars, __body: '' });
  const bodyVars = { ...vars, __body: finalBody };
  const finalURL = render(url, bodyVars);
  const auth = cfg(platform, 'AUTH', '');

  const headers = { 'Content-Type': 'application/json' };
  if (auth) headers.Authorization = render(auth, bodyVars);
  try {
    const extra = cfg(platform, 'HEADERS', '');
    if (extra) Object.assign(headers, JSON.parse(render(extra, bodyVars)));
  } catch (e) {
    logger.warn('supplier', `${platform} CTROP_HEADERS 不是合法 JSON，已忽略：${e.message}`);
  }

  const ck = `sup:${platform}:${item && (item.poiUid || item.id || item.name)}:${finalBody.length}`;
  const hit = cache.get(ck);
  if (hit) return { ...hit, cached: true };

  try {
    const res = await fetchJSON(finalURL, {
      method,
      body: bodyRaw.trim() ? finalBody : null,
      headers,
      timeout: 8000,
      retry: 0,
    });

    const price = Number(jsonPath(res, pricePath));
    if (!Number.isFinite(price) || price <= 0) {
      return { available: false, reason: 'bad_price', message: `${PLATFORMS[platform].name}未在该模板下返回结果价格（检查 ${platform.toUpperCase()}_PRICE_PATH）` };
    }
    const out = {
      available: true,
      platform,
      platformName: PLATFORMS[platform].name,
      price,
      currency: 'CNY',
      unit: (item && item.unit) || '',
      title: titlePath ? jsonPath(res, titlePath) : (item && item.name) || '',
      url: urlPath ? jsonPath(res, urlPath) : '',
      raw: res,
    };
    cache.set(ck, out, ttl);
    return out;
  } catch (e) {
    logger.warn('supplier', `${platform} 拉真实价失败：${e.message}`);
    return { available: false, reason: 'request_failed', message: e.message };
  }
}

/**
 * 取价：优先真实价，拿不到就回落参考价。
 * 返回 { price, originPrice, unit, estimated, source: 'supplier'|'estimate', supplier }
 */
async function priceOf(item) {
  const est = estimate(item);
  try {
    const real = await lookup(item);
    if (real && real.available) {
      return {
        price: real.price,
        originPrice: est.originPrice,
        unit: real.unit || est.unit,
        estimated: false,
        source: 'supplier',
        supplier: real,
      };
    }
    return { ...est, source: 'estimate', reason: real && real.reason, message: real && real.message };
  } catch (e) {
    return { ...est, source: 'estimate', reason: 'error', message: e.message };
  }
}

/** 下单要跳的平台（按类目挑一个主渠道） */
function pickPlatform(item = {}) {
  const byCategory = { hotel: 'ctrip', ticket: 'ctrip', food: 'meituan', service: 'meituan' };
  const want = (item.supplier && item.supplier.platform) || byCategory[item.category] || 'ctrip';
  // 选中的渠道没配真实接口也能用（只是跳它的搜索页），这里不做强拦截
  return { platform: want, platformName: (PLATFORMS[want] || { name: want }).name };
}

/* ---------------- 外卖平台「联网识别」 ----------------
 * 约束：美团/饿了么/抖音没有公开的店铺检索 API（无商户/渠道资质调用不了，爬取违规）。
 * 所以「门店在不在外卖平台、什么价、什么评分」不能靠逐店自动拉数，而是两层：
 *  ① platformsOf  —— 同步、零网络：给门店挂各外卖平台「搜这家店」公开深链（引导式识别）。
 *  ② identifyPlatforms —— 异步、按需：配了 *_URL 才真联网核实 onShelf/price/rating。
 */

/** 平台「搜这家店」的公开网页深链（非 API，仅做跳转；合规可用） */
function searchUrlOf(platform, item = {}) {
  const p = PLATFORMS[platform];
  if (!p) return '';
  const tpl = cfg(platform, 'SEARCH_URL', '') || p.searchUrl || '';
  if (!tpl) return '';
  const keyword = (item.supplier && item.supplier.keyword) || item.name || '';
  const vars = {
    keyword: encodeURIComponent(keyword),
    name: encodeURIComponent(item.name || ''),
    city: encodeURIComponent(item.city || (item.district) || ''),
    lng: item.lng !== undefined ? String(item.lng) : '',
    lat: item.lat !== undefined ? String(item.lat) : '',
  };
  return String(tpl).replace(/\{\{(\w+)\}\}/g, (m, k) => (vars[k] === undefined ? '' : vars[k]));
}

/**
 * 同步、零网络：返回门店在各外卖平台的「引导式识别」描述（深链 + 未核实标记）。
 * 这是 catalog 构建期落库用的，绝不触发任何网络请求 / 第三方配额。
 */
function platformsOf(item = {}) {
  const out = {};
  for (const k of DELIVERY_PLATFORMS) {
    const p = PLATFORMS[k];
    const searchUrl = searchUrlOf(k, item);
    out[k] = {
      platform: k,
      name: p.name,
      color: p.color,
      searchUrl,
      url: searchUrl, // 未核实前，跳转目标 = 平台搜这家店
      verified: false, // 是否经真实接口核实过在架状态
      onShelf: null, // true/false/null（null=未核实，前端别显示「已上架/未上架」）
      price: null,
      rating: null,
      source: 'link', // 仅深链引导，非真实数据
      note: p.note,
    };
  }
  return out;
}

/**
 * 异步、按需：联网识别门店在各外卖平台的在架 / 价格 / 评分。
 *  · 配了 *_URL（真实接口）→ 真的去拉，拉到标 verified:true + onShelf:true + price/rating；
 *    接口通但查不到 → verified:true + onShelf:false（明确「没上架」，不造假）。
 *  · 没配 key → 回落深链（verified:false / onShelf:null），前端引导用户去平台自查。
 * 注意：本函数会触发第三方请求，只在用户主动「识别」时调用，绝不在 catalog.build / list 里批量跑。
 */
async function identifyPlatforms(item = {}) {
  const out = {};
  await Promise.all(
    DELIVERY_PLATFORMS.map(async (k) => {
      const p = PLATFORMS[k];
      const searchUrl = searchUrlOf(k, item);
      const rec = {
        platform: k,
        name: p.name,
        color: p.color,
        searchUrl,
        verified: false,
        onShelf: null,
        price: null,
        rating: null,
        url: searchUrl,
        source: 'link',
        note: p.note,
      };
      if (isEnabled(k)) {
        try {
          const real = await lookup(item, k);
          if (real && real.available) {
            rec.verified = true;
            rec.onShelf = true;
            rec.price = real.price || null;
            rec.url = (real.url && String(real.url).startsWith('http')) ? real.url : searchUrl;
            const rp = cfg(k, 'RATING_PATH', '');
            const rating = rp ? jsonPath(real.raw, rp) : null;
            rec.rating = Number(rating) > 0 ? Number(rating) : null;
            rec.source = 'api';
            rec.note = `${p.name}已联网核实（接口返回）`;
          } else if (real && real.reason === 'bad_price') {
            // 接口通了但没返回有效价格 = 查无此店 → 明确「未上架」
            rec.verified = true;
            rec.onShelf = false;
            rec.note = (real && real.message) || `${p.name}未返回此店（可能未上架）`;
          } else {
            // 接口配了但请求失败（网络/鉴权）→ 无法判定，回落深链
            rec.verified = false;
            rec.note = '联网核实失败（' + ((real && real.message) || '未知') + '），可点链接去平台自查';
          }
        } catch (e) {
          rec.verified = false;
          rec.note = '联网核实异常（' + e.message + '），可点链接去平台自查';
        }
      }
      out[k] = rec;
    })
  );
  return out;
}

module.exports = {
  PLATFORMS,
  DELIVERY_PLATFORMS,
  status,
  isEnabled,
  lookup,
  priceOf,
  estimate,
  pickPlatform,
  searchUrlOf,
  platformsOf,
  identifyPlatforms,
  jsonPath,
  render,
};
