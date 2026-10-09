#!/usr/bin/env node
/**
 * 鲤慧 LiHui · MCP Server: desktop-action
 * 桌面应用操作 —— 唤起外部应用（地图导航/电商/通讯）与生成桌面自动化操作脚本
 * 安全约束：不静默执行支付；所有写操作均返回 needConfirm=true
 * 工具：open_app / desktop_operate
 */
const readline = require('readline');

const SCHEMES = {
  百度地图: {
    scheme: 'baidumap://',
    direction: ({ origin = '我的位置', destination = '', mode = 'walking' }) =>
      `baidumap://map/direction?origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}&mode=${mode}&coord_type=bd09ll&src=lihui`,
    search: ({ keyword = '', city = '' }) => `baidumap://map/place/search?query=${encodeURIComponent(keyword)}&region=${encodeURIComponent(city)}&src=lihui`,
  },
  高德地图: {
    scheme: 'amapuri://',
    direction: ({ destination = '', mode = 'walking' }) => `amapuri://route/plan/?dname=${encodeURIComponent(destination)}&m=${mode === 'driving' ? '0' : '4'}&src=lihui`,
    search: ({ keyword = '' }) => `amapuri://poi?keyword=${encodeURIComponent(keyword)}&src=lihui`,
  },
  淘宝: { scheme: 'taobao://', search: ({ keyword = '' }) => `taobao://s.taobao.com/search?q=${encodeURIComponent(keyword)}` },
  京东: { scheme: 'openapp.jdmobile://', search: ({ keyword = '' }) => `openapp.jdmobile://virtual?params=${encodeURIComponent(JSON.stringify({ category: 'jump', des: 'productList', keyWord: keyword }))}` },
  美团: { scheme: 'imeituan://', search: ({ keyword = '' }) => `imeituan://www.meituan.com/search?q=${encodeURIComponent(keyword)}` },
  微信: { scheme: 'weixin://' },
  支付宝: { scheme: 'alipays://' },
  电话: { scheme: 'tel://', call: ({ number = '' }) => `tel:${number}` },
};

const TOOLS = [
  {
    name: 'open_app',
    description: '生成唤起外部应用的 URI Scheme（地图导航、电商搜索、拨号等），端上执行可自动跳转到对应界面。',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string', description: '应用名，如 百度地图 / 高德地图 / 淘宝 / 京东 / 美团 / 电话' },
        type: { type: 'string', enum: ['direction', 'search', 'call'], description: '操作类型' },
        origin: { type: 'string', description: '起点（direction 用）' },
        destination: { type: 'string', description: '终点（direction 用）' },
        keyword: { type: 'string', description: '搜索关键词（search 用）' },
        number: { type: 'string', description: '电话号码（call 用）' },
        mode: { type: 'string', description: 'walking/riding/driving/transit' },
        city: { type: 'string' },
      },
      required: ['app'],
    },
  },
  {
    name: 'desktop_operate',
    description: '为「帮我在桌面应用里买某样东西」这类需求生成安全操作脚本（搜索→筛选→加购→停下等确认）。不自动填写支付信息。',
    inputSchema: {
      type: 'object',
      properties: {
        os: { type: 'string', enum: ['windows', 'macos', 'linux'], description: '默认 windows' },
        target: { type: 'string', description: '目标应用，如 淘宝 / 京东 / 美团' },
        intent: { type: 'string', description: '用户意图原话，如「买洗衣液，39 元以内」' },
        constraints: { type: 'object', description: '{ maxPrice, preferFreeShipping, brand, spec }' },
      },
      required: ['target', 'intent'],
    },
  },
];

function openApp(args) {
  const conf = SCHEMES[args.app];
  if (!conf) throw new Error(`暂不支持唤起「${args.app}」，可用：${Object.keys(SCHEMES).join('、')}`);
  let uri = conf.scheme;
  if (args.type === 'direction' || args.destination) {
    if (!conf.direction) throw new Error(`${args.app} 不支持路线跳转`);
    uri = conf.direction(args);
  } else if (args.type === 'search' || args.keyword) {
    if (!conf.search) throw new Error(`${args.app} 不支持关键词搜索跳转`);
    uri = conf.search(args);
  } else if (args.type === 'call' || args.number) {
    if (!conf.call) throw new Error(`${args.app} 不支持拨号`);
    uri = conf.call(args);
  }
  return {
    app: args.app,
    uri,
    miniProgram: args.app === '百度地图' ? { appId: 'wxde8ac0a21135c07d', note: '微信内可改用小程序跳转' } : null,
    execHint: { uniapp: 'plus.runtime.openURL(uri)', miniprogram: 'wx.navigateToMiniProgram({ appId, path })' },
  };
}

function desktopOperate({ os = 'windows', target, intent, constraints = {} }) {
  const price = constraints.maxPrice ? `¥${constraints.maxPrice}` : '预算内';
  const steps = [
    `打开「${target}」客户端（${os === 'windows' ? 'Windows' : os === 'macos' ? 'macOS' : 'Linux'}）`,
    `在搜索框输入：${intent}`,
    `筛选条件：价格 ≤ ${price}${constraints.preferFreeShipping ? '，优先包邮' : ''}${constraints.brand ? '，品牌限定 ' + constraints.brand : ''}`,
    '按「销量 + 评分」综合排序，取前 3 个候选',
    '逐一核对：规格、净含量、是否包邮、店铺评分',
    '把最优 1 个加入购物车',
    '【暂停】把候选清单交给用户确认',
    '用户确认后，才可进入结算页（支付密码/指纹由用户本人完成）',
  ];
  return {
    os,
    target,
    intent,
    constraints,
    steps: steps.map((s, i) => ({ step: i + 1, action: s, auto: i < 6 })),
    needConfirm: true,
    safety: [
      '不读取、不填写任何支付密码或验证码',
      '不跳过用户确认直接下单',
      '单笔金额上限由用户在设置里指定（默认 ¥100）',
      '每步操作可撤销，操作日志本地留存 7 天',
    ],
    estimate: { draftMinutes: 3, autoSteps: 6, manualSteps: 2 },
    notice: '真正的桌面自动化执行由配套桌面端执行器完成；服务端只产出白名单步骤，不代用户付款。',
  };
}

const IMPL = { open_app: openApp, desktop_operate: desktopOperate };
const SERVER_INFO = { name: 'lh-desktop-action', version: '1.0.0' };
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');

readline.createInterface({ input: process.stdin, terminal: false }).on('line', (line) => {
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
    try {
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(fn((params && params.arguments) || {})) }] } });
    } catch (e) {
      return send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: e.message }) }] } });
    }
  }
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `未实现的方法: ${method}` } });
});
