/**
 * 鲤慧 LiHui · 外部应用唤起 / 桌面应用操作路由
 */
const { ok, fail } = require('../utils/http');
const hub = require('../mcp/hub');

/** 常见应用 URI Scheme 表 */
const APP_SCHEME = {
  百度地图: {
    scheme: 'baidumap://',
    // ⚠️ coord_type 用 gcj02：origin/destination 是端上 wx.getLocation(type:'gcj02') 的坐标，
    // 写 bd09ll 会让百度按百度坐标系解释，起终点直接错位几百米。
    direction: (o, d, m) => `baidumap://map/direction?origin=${o}&destination=${d}&mode=${m || 'walking'}&coord_type=gcj02&src=lihui`,
    search: (kw, c) => `baidumap://map/place/search?query=${encodeURIComponent(kw)}&region=${encodeURIComponent(c || '')}&src=lihui`,
    wx: { appId: 'wxde8ac0a21135c07d', pathPrefix: 'pages/index/index' },
  },
  高德地图: {
    scheme: 'amapuri://',
    direction: (o, d, m) => `amapuri://route/plan/?dlat=&dlon=&dname=${encodeURIComponent(d)}&m=${m === 'driving' ? 0 : 4}&src=lihui`,
    search: (kw) => `amapuri://poi?keyword=${encodeURIComponent(kw)}&src=lihui`,
    wx: { appId: 'wxde8ac0a21135c07d', pathPrefix: '' },
  },
  微信: { scheme: 'weixin://', wx: { appId: 'wxde8ac0a21135c07d', pathPrefix: '' } },
  支付宝: { scheme: 'alipays://' },
  电话: { scheme: 'tel://' },
};

module.exports = {
  /** GET /api/v1/action/schemes —— 端上可用的跳转能力表 */
  'GET /action/schemes': async (req, res) => ok(res, { apps: Object.keys(APP_SCHEME), detail: APP_SCHEME }),

  /**
   * POST /api/v1/action/open-app
   * { app, type:'direction'|'search', origin, destination, mode, keyword, city }
   */
  'POST /action/open-app': async (req, res, q, body) => {
    const b = body || {};
    if (!b.app) return fail(res, 1001, 'app 必填（如 百度地图 / 高德地图）');
    const conf = APP_SCHEME[b.app];
    if (!conf) return fail(res, 1001, `暂不支持唤起「${b.app}」，可用：${Object.keys(APP_SCHEME).join('、')}`);

    let uri = conf.scheme;
    if (b.type === 'direction' || b.destination) {
      if (!conf.direction) return fail(res, 1001, `${b.app} 不支持路线跳转`);
      uri = conf.direction(b.origin || '我的位置', b.destination || '', b.mode);
    } else if (b.type === 'search' || b.keyword) {
      if (!conf.search) return fail(res, 1001, `${b.app} 不支持关键词搜索跳转`);
      uri = conf.search(b.keyword || '', b.city);
    }

    // 同时给出小程序跳转参数（微信内使用）
    return ok(res, {
      app: b.app,
      uri,
      miniProgram: conf.wx || null,
      hint: 'uni-app App 端用 plus.runtime.openURL(uri)；小程序端用 wx.navigateToMiniProgram(miniProgram)',
    });
  },

  /**
   * POST /api/v1/action/desktop-operate
   * 通过 desktop-action MCP 生成桌面应用操作步骤（安全白名单，不静默执行）
   */
  'POST /action/desktop-operate': async (req, res, q, body) => {
    const b = body || {};
    if (!b.target || !b.intent) return fail(res, 1001, 'target / intent 必填');
    try {
      const r = await hub.callByQualifiedName('desktop-action__desktop_operate', {
        os: b.os || 'windows',
        target: b.target,
        intent: b.intent,
        constraints: b.constraints || {},
      });
      const data = (r.data && (r.data.result || r.data)) || null;
      if (!data) throw new Error('empty mcp result');
      return ok(res, { ...data, needConfirm: true });
    } catch (e) {
      // 兜底：生成通用操作骨架
      return ok(res, {
        target: b.target,
        intent: b.intent,
        needConfirm: true,
        steps: [
          `打开「${b.target}」应用`,
          `在搜索框输入：${b.intent}`,
          '按「价格从低到高」排序筛选',
          '核对商品规格与运费',
          '加入购物车（此时暂停，等待用户确认）',
          '用户确认后才可提交订单并支付',
        ],
        safety: ['不自动填写支付密码', '不跳过用户确认', '单笔金额上限由用户设定'],
        fallback: e.message,
      });
    }
  },
};
