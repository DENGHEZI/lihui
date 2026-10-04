/**
 * 鲤慧 LiHui · 微信小程序配置
 *
 * 端上 AK 说明：
 *  - BAIDU_AK 是【微信小程序端】百度地图 AK，由微信小程序公开使用，写在这里是正常的
 *    （与 03-lh-server/.env 里的服务端 AK 不是同一个，服务端 AK 绝不进小程序包）
 *  - 使用前请在百度地图开放平台把该 AK 的 Referer 白名单设为「微信小程序」并绑定 AppID
 *  - 需在小程序后台把 https://api.map.baidu.com 加入 request 合法域名
 */
const ENV = {
  // 正式域名：lihui-tech.online
  // 前置条件（缺一不可）：① ICP 备案通过 ② 云托管「服务设置 → 域名管理」绑定该自定义域名
  // ③ 小程序后台「开发管理 → 服务器域名 → request 合法域名」加入 https://lihui-tech.online
  prod: 'https://lihui-tech.online',
  // 备案期临时通道：云托管默认域名（需在小程序后台 request 合法域名里加它，
  // 否则真机会报 url not in domain list）
  staging: 'https://springboot-o4hr-322354-12-1498892848.sh.run.tcloudbase.com',
  // 本地调试（手机与电脑须连同一 WiFi，地址为电脑的局域网 IP）
  dev: 'http://192.168.0.106:8809',
}
const CURRENT = 'staging'

/* ---------------- 微信云托管内网通道（可彻底免掉域名白名单） ----------------
 * wx.cloud.callContainer 是微信给自家云托管留的内部通道，**不受「request 合法域名」限制**，
 * 也不需要已备案域名，真机/体验版/正式版都能用。开启步骤：
 *   1. 微信云托管控制台首页复制「环境 ID」（形如 prod-xxxxxxxx）
 *   2. 填进下面的 CLOUD_ENV_ID
 *   3. 把 USE_CLOUD_CONTAINER 改成 true，重新编译
 * 前提：小程序已开通云开发（既然已部署微信云托管，环境通常已存在）。
 */
const CLOUD_ENV_ID = 'prod-d4gufxdb3ebb426d2'
const CLOUD_SERVICE = 'springboot-o4hr'
const USE_CLOUD_CONTAINER = true

module.exports = {
  APP_NAME: '鲤慧',
  VERSION: '1.0.0',

  // 服务端（能力中转）
  BASE_URL: ENV[CURRENT] + '/api/v1',

  // 微信云托管内网通道（走 callContainer，免 request 合法域名）
  CLOUD_ENV_ID,
  CLOUD_SERVICE,
  USE_CLOUD_CONTAINER,

  // 百度地图 · 微信小程序端 AK
  BAIDU_AK: 'FbLtBDL1RuIxCR7iIrjHwkcJSZyrqQ9R',
  BAIDU_BASE: 'https://api.map.baidu.com',

  // 微信 AppID（与 project.config.json 一致）
  WX_APPID: 'wxfc45acb99d454f8a',

  DEFAULT_PLAN: 'pro',
  // 生活圈检索半径：默认 15 分钟档（赛题口径）≈1200m；等时圈可切 30/45/60 档
  DEFAULT_RADIUS: 1200,

  // 周边便民服务快捷入口（bg 为图标底色，高德式柔和分类色）
  QUICK_SERVICES: [
    { key: 'medical', name: '看病买药', query: '医院|药店', icon: '🏥', bg: '#FFECEC' },
    { key: 'market', name: '买菜购物', query: '菜市场|超市', icon: '🛒', bg: '#FFF4E6' },
    { key: 'food', name: '吃饭', query: '餐厅|早餐店', icon: '🍜', bg: '#FFF7E0' },
    { key: 'transit', name: '公交地铁', query: '公交站|地铁站', icon: '🚌', bg: '#E6F4FF' },
    { key: 'leisure', name: '公园广场', query: '公园|广场', icon: '🌳', bg: '#E6F8F0' },
    { key: 'edu', name: '学习教育', query: '学校|中学|小学', icon: '📚', bg: '#F0EFFF' },
    { key: 'bank', name: '银行网点', query: '银行|ATM', icon: '🏦', bg: '#EAF2FF' },
    { key: 'gov', name: '政务服务', query: '社区服务中心|政务大厅', icon: '🏛️', bg: '#F0EFFF' },
    { key: 'hotel', name: '酒店住宿', query: '酒店|宾馆', icon: '🏨', bg: '#EFF6FF' },
    { key: 'pharmacy', name: '24h 药店', query: '24小时药店', icon: '💊', bg: '#E6FBF7' }
  ]
}
