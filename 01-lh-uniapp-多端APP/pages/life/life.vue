<template>
	<view class="lh-page">
		<view class="hero">
			<view class="hero-top">
				<view>
					<text class="lh-h1">15 分钟生活圈体检</text>
					<text class="lh-cap hero-sub">{{ centerText }} · 步行半径 {{ radius }} 米</text>
				</view>
				<view class="care" :class="{ on: careMode }" @click="toggleCare">
					<text>{{ careMode ? '关怀模式' : '标准模式' }}</text>
				</view>
			</view>

			<view class="score-box" v-if="report">
				<lh-score-ring :score="report.score" :level="report.level" :size="128" />
				<view class="score-right">
					<text class="lh-cap">短板 {{ shortboards.length }} 项</text>
					<text class="lh-mini">预计步行 {{ report.walkMinutes || 15 }} 分钟可达</text>
					<button class="lh-btn mini-btn" @click="customize">生成我的生活圈方案</button>
				</view>
			</view>
			<view v-else class="score-box loading-box">
				<text class="lh-cap">正在体检…</text>
			</view>
		</view>

		<!-- 分类明细 -->
		<view class="lh-card cat-card" v-if="report">
			<text class="lh-h2">六类设施覆盖</text>
			<view v-for="c in report.categories" :key="c.key" class="cat-row">
				<view class="cat-head">
					<text class="cat-name">{{ c.name }}</text>
					<text class="cat-score" :style="{ color: scoreColor(c.score) }">{{ c.score }}</text>
				</view>
				<view class="bar-bg">
					<view class="bar-fg" :style="{ width: c.score + '%', background: scoreColor(c.score) }"></view>
				</view>
				<text class="cat-desc">
					{{ c.desc }} · 可达 {{ c.count }} 处
					{{ c.nearest ? '，最近 ' + c.nearest.name + ' ' + fmtDist(c.nearest.distance) : '，范围内未查到' }}
				</text>
			</view>
		</view>

		<!-- 短板与建议 -->
		<view class="lh-card" v-if="report && shortboards.length">
			<text class="lh-h2">短板提醒</text>
			<view v-for="(s, i) in shortboards" :key="i" class="warn-row">
				<text class="warn-dot">●</text>
				<text class="lh-body warn-text">{{ s }}</text>
			</view>
			<view class="lh-divider mt12"></view>
			<text class="lh-h2 mt12">补齐建议</text>
			<view v-for="(s, i) in suggestions" :key="i" class="tip-row">
				<text class="tip-idx">{{ i + 1 }}</text>
				<text class="lh-body tip-text">{{ s }}</text>
			</view>
		</view>

		<!-- 个性化方案 -->
		<view class="lh-card" v-if="plan">
			<text class="lh-h2">个性化生活圈方案</text>
			<view v-for="(p, i) in plan.plan" :key="i" class="tip-row">
				<text class="tip-idx">{{ i + 1 }}</text>
				<text class="lh-body tip-text">{{ p }}</text>
			</view>
			<button class="lh-btn ghost-btn" @click="jumpMap">在地图上查看</button>
		</view>

		<!-- 服务评价参考 -->
		<view class="lh-card">
			<text class="lh-h2">服务质量评价参考</text>
			<text class="lh-cap">输入常去的商家或机构名称，看看值不值得去</text>
			<view class="rate-input">
				<input v-model="rateName" class="rate-inp" placeholder="如：岳麓区社区卫生服务中心" placeholder-class="ph" />
				<button class="lh-btn rate-btn" @click="doRate">评估</button>
			</view>
			<view v-if="rateResult" class="rate-result">
				<view v-for="(d, i) in rateResult.dimensions" :key="i" class="rate-dim">
					<text class="dim-name">{{ d.name }}</text>
					<text class="dim-hint">{{ d.hint }}</text>
				</view>
				<text class="lh-body rate-advice">{{ rateResult.advice }}</text>
			</view>
		</view>

		<!-- 偏好设置 -->
		<view class="lh-card">
			<text class="lh-h2">生活圈偏好</text>
			<view class="pref-row">
				<text class="lh-body">预算水平</text>
				<view class="pref-tags">
					<text v-for="b in budgets" :key="b.key" class="lh-pill" :class="{ 'lh-pill--on': pref.budget === b.key }" @click="pref.budget = b.key">{{ b.name }}</text>
				</view>
			</view>
			<view class="pref-row">
				<text class="lh-body">家里有老人</text>
				<switch :checked="pref.withElderly" color="#1677FF" @change="pref.withElderly = $event.detail.value" />
			</view>
			<view class="pref-row">
				<text class="lh-body">需要公园</text>
				<switch :checked="pref.needPark" color="#1677FF" @change="pref.needPark = $event.detail.value" />
			</view>
			<view class="pref-row">
				<text class="lh-body">最长步行时间</text>
				<text class="lh-cap">{{ pref.maxWalkMinutes }} 分钟</text>
			</view>
			<slider :value="pref.maxWalkMinutes" min="5" max="30" step="5" activeColor="#1677FF" @change="pref.maxWalkMinutes = $event.detail.value" />
		</view>

		<view style="height: 32px"></view>
	</view>
</template>

<script>
import { getLocation, publicConfig } from '@/api/user.js'
import { lifeReport, customizePlan } from '@/api/life.js'
import { chat } from '@/api/agent.js'
import { getCareMode, toggleCareMode } from '@/utils/care.js'
import { speak } from '@/utils/voice.js'
import lhScoreRing from '@/components/lh-score-ring.vue'

export default {
	components: { lhScoreRing },
	data() {
		return {
			center: { lng: 112.938814, lat: 28.228209 },
			centerText: '正在定位…',
			// 体检半径：默认 15 分钟档（赛题口径）
			radius: 1200,
			careMode: false,
			report: null,
			plan: null,
			rateName: '',
			rateResult: null,
			budgets: [
				{ key: 'low', name: '节省' },
				{ key: 'mid', name: '适中' },
				{ key: 'high', name: '宽松' }
			],
			pref: { budget: 'low', withElderly: true, needPark: true, maxWalkMinutes: 15 }
		}
	},
	computed: {
		shortboards() {
			return (this.report && this.report.shortboards) || []
		},
		suggestions() {
			if (!this.report) return []
			const s = this.report.suggestions || []
			return s.map((x) => (typeof x === 'string' ? x : JSON.stringify(x)))
		}
	},
	onLoad() {
		this.careMode = getCareMode()
		this.init()
	},
	onPullDownRefresh() {
		this.init().then(() => uni.stopPullDownRefresh())
	},
	methods: {
		async init() {
			const loc = await getLocation()
			this.center = { lng: Number(loc.lng), lat: Number(loc.lat) }
			this.centerText = [loc.city, loc.district].filter(Boolean).join(' ') || '当前位置'
			await this.loadReport()
			this.loadScenicPlan()
		},

		async loadReport() {
			try {
				this.report = await lifeReport(this.center.lng, this.center.lat, this.radius)
			} catch (e) {
				this.report = null
			}
		},

		async loadScenicPlan() {
			try {
				const r = await chat({
					text: '给我一份 15 分钟生活圈方案',
					lng: this.center.lng,
					lat: this.center.lat
				})
				const card = (r.cards || []).find((c) => c.type === 'life_score')
				if (card) this.report = Object.assign({}, this.report, card)
			} catch (e) {}
		},

		async customize() {
			uni.showLoading({ title: '生成方案中' })
			try {
				this.plan = await customizePlan({
					lng: this.center.lng,
					lat: this.center.lat,
					preference: this.pref
				})
				uni.hideLoading()
				if (this.plan && this.plan.plan) {
					speak(this.plan.plan.slice(0, 2).join('。'), { scene: 'chat', careMode: this.careMode })
				}
			} catch (e) {
				uni.hideLoading()
			}
		},

		async doRate() {
			if (!this.rateName.trim()) {
				uni.showToast({ title: '请输入名称', icon: 'none' })
				return
			}
			uni.showLoading({ title: '评估中' })
			try {
				const r = await chat({
					text: `评价参考：${this.rateName}`,
					lng: this.center.lng,
					lat: this.center.lat
				})
				uni.hideLoading()
				this.rateResult = {
					dimensions: [
						{ name: '便利度', hint: '基于 15 分钟步行可达性判断' },
						{ name: '价格透明度', hint: '优先选择明码标价的商家' },
						{ name: '服务态度', hint: '参考平台评价与口碑' },
						{ name: '适老友好', hint: '无障碍通道、座椅、放大镜等' }
					],
					advice: r.reply || '建议优先选择连锁品牌或社区卫生服务中心。'
				}
			} catch (e) {
				uni.hideLoading()
			}
		},

		jumpMap() {
			uni.switchTab({ url: '/pages/index/index' })
		},

		toggleCare() {
			this.careMode = toggleCareMode()
			this.loadReport()
		},

		scoreColor(s) {
			if (s >= 85) return '#00B96B'
			if (s >= 60) return '#1677FF'
			if (s >= 40) return '#FF8A00'
			return '#F5222D'
		},

		fmtDist(d) {
			if (d === null || d === undefined) return ''
			return Number(d) >= 1000 ? (Number(d) / 1000).toFixed(1) + 'km' : Math.round(Number(d)) + 'm'
		}
	}
}
</script>

<style scoped>
.hero {
	background: linear-gradient(180deg, #EAF2FF 0%, #F4F5F7 100%);
	padding: 16px 16px 8px;
}
.hero-top {
	display: flex;
	align-items: flex-start;
	justify-content: space-between;
}
.hero-sub {
	display: block;
	margin-top: 4px;
}
.care {
	font-size: 12px;
	color: #646A73;
	background: #FFFFFF;
	border-radius: 999px;
	padding: 4px 10px;
}
.care.on {
	color: #1677FF;
	font-weight: 600;
	background: #EAF2FF;
}
.score-box {
	display: flex;
	align-items: center;
	margin-top: 16px;
}
.loading-box {
	min-height: 128px;
	justify-content: center;
}
.score-right {
	flex: 1;
	margin-left: 20px;
	display: flex;
	flex-direction: column;
}
.mini-btn {
	margin-top: 12px;
	height: 40px;
	font-size: 14px;
}
.cat-card {
	margin: 12px 16px 0;
}
.cat-row {
	margin-top: 14px;
}
.cat-head {
	display: flex;
	justify-content: space-between;
	align-items: center;
}
.cat-name {
	font-size: 15px;
	color: #1A1A1A;
	font-weight: 600;
}
.cat-score {
	font-size: 15px;
	font-weight: 600;
}
.bar-bg {
	height: 6px;
	background: #EDEFF2;
	border-radius: 3px;
	margin-top: 8px;
	overflow: hidden;
}
.bar-fg {
	height: 6px;
	border-radius: 3px;
}
.cat-desc {
	font-size: 12px;
	color: #646A73;
	margin-top: 6px;
	display: block;
}
.lh-card {
	margin: 12px 16px 0;
}
.warn-row {
	display: flex;
	margin-top: 10px;
}
.warn-dot {
	color: #F5222D;
	font-size: 10px;
	margin: 6px 8px 0 0;
}
.warn-text {
	flex: 1;
}
.tip-row {
	display: flex;
	margin-top: 10px;
}
.tip-idx {
	width: 20px;
	height: 20px;
	line-height: 20px;
	text-align: center;
	border-radius: 50%;
	background: #EAF2FF;
	color: #1677FF;
	font-size: 12px;
	font-weight: 600;
	margin: 2px 8px 0 0;
	flex-shrink: 0;
}
.tip-text {
	flex: 1;
}
.mt12 {
	margin-top: 12px;
}
.ghost-btn {
	margin-top: 16px;
	background: #FFFFFF;
	color: #1677FF;
	border: 1px solid #1677FF;
}
.rate-input {
	display: flex;
	margin-top: 12px;
}
.rate-inp {
	flex: 1;
	height: 44px;
	background: #F4F5F7;
	border-radius: 999px;
	padding: 0 16px;
	font-size: 15px;
}
.ph {
	color: #8F959E;
}
.rate-btn {
	width: 88px;
	height: 44px;
	margin-left: 8px;
	font-size: 15px;
}
.rate-result {
	margin-top: 14px;
}
.rate-dim {
	padding: 10px 0;
	border-bottom: 1px solid #EDEFF2;
}
.dim-name {
	font-size: 14px;
	color: #1A1A1A;
	font-weight: 600;
	display: block;
}
.dim-hint {
	font-size: 13px;
	color: #646A73;
	margin-top: 2px;
	display: block;
}
.rate-advice {
	margin-top: 12px;
	background: #F8F9FB;
	padding: 10px 12px;
	border-radius: 10px;
	display: block;
}
.pref-row {
	display: flex;
	align-items: center;
	justify-content: space-between;
	margin-top: 14px;
}
.pref-tags {
	display: flex;
}
.pref-tags .lh-pill {
	margin-left: 8px;
}
</style>
