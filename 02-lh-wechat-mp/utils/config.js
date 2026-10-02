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
  // 云托管（腾讯云 CloudBase Run）—— 已部署验证通过，脱离电脑可用
  // 注意：需在微信公众平台「开发设置 → 服务器域名 → request 合法域名」加入此域名
  prod: 'https://springboot-o4hr-322354-12-1498892848.sh.run.tcloudbase.com',
  // 本地调试（手机与电脑须连同一 WiFi，地址为电脑的局域网 IP）
  dev: 'http://192.168.0.106:8809',
}
const CURRENT = 'prod'

module.exports = {
  APP_NAME: '鲤慧',
  VERSION: '1.0.0',

  // 服务端（能力中转）
  BASE_URL: ENV[CURRENT] + '/api/v1',

  // 百度地图 · 微信小程序端 AK
  BAIDU_AK: 'FbLtBDL1RuIxCR7iIrjHwkcJSZyrqQ9R',
  BAIDU_BASE: 'https://api.map.baidu.com',

  // 微信 AppID（与 project.config.json 一致）
  WX_APPID: 'wxfc45acb99d454f8a',

  DEFAULT_PLAN: 'pro',
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
