/**
 * 鲤慧 LiHui · 多端 APP 配置
 *
 * ⚠️ 注意：本文件【不包含】任何服务端百度地图 AK。
 *    APP 端（Android / HarmonyOS / iOS）的全部百度地图能力
 *    统一由服务端中转，见 03-lh-server。
 *    底图 SDK 初始化用的端上 AK 请在 HBuilderX 的 manifest.json →
 *    App 模块配置 → Maps/Geolocation 中填写，不写在代码里。
 */

const ENV = {
	// 开发：真机调试请改成你电脑的局域网 IP，例如 http://192.168.1.34:8809
	dev: 'http://127.0.0.1:8809',
	// 测试 / 生产：改成你自己的 HTTPS 域名
	prod: 'https://your-domain.com'
}

// 当前使用环境：'dev' | 'prod'
const CURRENT = 'dev'

export default {
	APP_NAME: '鲤慧',
	APP_EN_NAME: 'LiHui',
	VERSION: '1.0.0',

	BASE_URL: ENV[CURRENT] + '/api/v1',
	ENV: CURRENT,

	// 默认套餐：'free' 免费基础版 | 'pro' 增强版（接入 API）
	DEFAULT_PLAN: 'pro',

	// 默认搜索半径（米）≈ 15 分钟步行
	DEFAULT_RADIUS: 1200,

	// 生活圈 6 类设施
	CATEGORIES: [
		{ key: 'medical', name: '医疗', query: '医院|社区卫生服务中心|药店' },
		{ key: 'education', name: '教育', query: '幼儿园|小学|中学' },
		{ key: 'market', name: '商业', query: '超市|菜市场|便利店' },
		{ key: 'food', name: '餐饮', query: '餐厅|早餐店' },
		{ key: 'transit', name: '交通', query: '公交站|地铁站|停车场' },
		{ key: 'leisure', name: '休闲', query: '公园|健身|体育' }
	],

	// 周边便民服务快捷入口
	QUICK_SERVICES: [
		{ key: 'medical', name: '看病买药', query: '医院|药店', icon: '🏥' },
		{ key: 'market', name: '买菜购物', query: '菜市场|超市', icon: '🛒' },
		{ key: 'food', name: '吃饭', query: '餐厅|早餐店', icon: '🍜' },
		{ key: 'transit', name: '公交地铁', query: '公交站|地铁站', icon: '🚌' },
		{ key: 'leisure', name: '公园广场', query: '公园|广场', icon: '🌳' },
		{ key: 'bank', name: '银行网点', query: '银行|ATM', icon: '🏦' },
		{ key: 'gov', name: '政务服务', query: '社区服务中心|政务大厅', icon: '🏛️' },
		{ key: 'pharmacy', name: '24h 药店', query: '24小时药店', icon: '💊' }
	]
}
