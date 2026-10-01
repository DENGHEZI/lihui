<template>
	<view class="lh-page">
		<view class="lh-card">
			<text class="lh-h2">路线规划</text>
			<view class="from-to">
				<view class="dot start"></view>
				<view class="ft-mid">
					<text class="ft-label">起点</text>
					<text class="ft-val">{{ originName }}</text>
				</view>
			</view>
			<view class="from-to">
				<view class="dot end"></view>
				<view class="ft-mid">
					<text class="ft-label">终点</text>
					<input v-model="destName" class="ft-inp" placeholder="输入目的地" placeholder-class="ph" />
				</view>
				<text class="swap" @click="swap">⇅</text>
			</view>

			<view class="modes">
				<text
					v-for="m in modes"
					:key="m.key"
					class="lh-pill mode-pill"
					:class="{ 'lh-pill--on': mode === m.key }"
					@click="mode = m.key; plan()"
				>{{ m.icon }} {{ m.name }}</text>
			</view>

			<view class="realtime" v-if="mode === 'driving'">
				<text class="lh-body">实时避堵</text>
				<switch :checked="realtime" color="#1677FF" @change="onRealtimeChange" />
			</view>

			<button class="lh-btn" @click="plan" :disabled="loading">规划路线</button>
		</view>

		<view class="lh-card" v-if="result">
			<view class="sum">
				<view class="sum-item">
					<text class="sum-num">{{ (result.distance / 1000).toFixed(1) }}</text>
					<text class="sum-unit">km</text>
				</view>
				<view class="sum-item">
					<text class="sum-num">{{ Math.round((result.duration || 0) / 60) }}</text>
					<text class="sum-unit">分钟</text>
				</view>
				<view class="sum-item">
					<text class="sum-num">{{ result.trafficLight || 0 }}</text>
					<text class="sum-unit">红绿灯</text>
				</view>
			</view>

			<view v-if="result.congestion" class="congestion">
				<text class="cong-text">当前路况：{{ result.congestion }}</text>
			</view>

			<view class="steps">
				<view v-for="(s, i) in result.steps" :key="i" class="step-row">
					<view class="step-idx">{{ i + 1 }}</view>
					<view class="step-mid">
						<text class="step-txt">{{ s.instruction }}</text>
						<text class="lh-mini">{{ s.distance }} 米 · 约 {{ Math.round((s.duration || 0) / 60) }} 分钟</text>
					</view>
				</view>
			</view>

			<view class="alts" v-if="result.alternatives && result.alternatives.length">
				<text class="lh-h2">备选方案</text>
				<view v-for="(a, i) in result.alternatives" :key="i" class="alt-row">
					<text class="lh-body">方案 {{ i + 2 }}</text>
					<text class="lh-cap">{{ (a.distance / 1000).toFixed(1) }} km · {{ Math.round((a.duration || 0) / 60) }} 分钟</text>
				</view>
			</view>

			<button class="lh-btn ghost" @click="openNav">用百度地图开始导航</button>
		</view>

		<view class="lh-card" v-if="costPlan">
			<text class="lh-h2">省钱对比</text>
			<text class="lh-body">{{ costPlan.verdict }}</text>
			<view class="cost-list">
				<view v-for="(c, i) in costPlan.ranking" :key="i" class="cost-row">
					<text class="c-name">{{ c.name }}</text>
					<text class="c-cost">¥{{ c.cost }}</text>
					<text class="c-time">{{ c.minutes }} 分钟</text>
				</view>
			</view>
		</view>
	</view>
</template>

<script>
import { planRoute } from '@/api/map.js'
import { getLocation } from '@/api/user.js'
import { chat } from '@/api/agent.js'
import { jumpToApp } from '@/utils/action.js'

export default {
	data() {
		return {
			origin: null,
			originName: '我的位置',
			destName: '',
			dest: null,
			mode: 'walking',
			realtime: false,
			loading: false,
			result: null,
			costPlan: null,
			modes: [
				{ key: 'walking', name: '步行', icon: '🚶' },
				{ key: 'riding', name: '骑行', icon: '🚲' },
				{ key: 'driving', name: '驾车', icon: '🚗' },
				{ key: 'transit', name: '公交', icon: '🚌' }
			]
		}
	},
	async onLoad(q) {
		const loc = await getLocation()
		this.origin = { lng: Number(loc.lng), lat: Number(loc.lat) }
		this.originName = [loc.city, loc.district].filter(Boolean).join(' ') || '我的位置'
		if (q && q.name) {
			this.destName = decodeURIComponent(q.name)
			this.dest = { lng: Number(q.lng), lat: Number(q.lat) }
			this.plan()
			this.loadCost()
		}
	},
	methods: {
		swap() {
			if (!this.dest) return
			const t = this.origin
			this.origin = this.dest
			this.dest = t
			const tn = this.originName
			this.originName = this.destName
			this.destName = tn
		},

		onRealtimeChange(e) {
			this.realtime = e.detail.value
		},

		async plan() {
			if (!this.dest && !this.destName) {
				uni.showToast({ title: '请输入目的地', icon: 'none' })
				return
			}
			if (!this.dest) {
				// 用服务端地理编码补目的地坐标
				const { geocode } = await import('@/api/map.js')
				try {
					const g = await geocode(this.destName, this.originName.slice(0, 2))
					this.dest = { lng: g.lng, lat: g.lat }
				} catch (e) {
					uni.showToast({ title: '没找到这个地址', icon: 'none' })
					return
				}
			}
			this.loading = true
			uni.showLoading({ title: '规划中' })
			try {
				this.result = await planRoute({
					mode: this.mode,
					origin: this.origin,
					destination: this.dest,
					realtime: this.realtime
				})
				if (this.mode === 'driving') this.loadCost()
			} catch (e) {
				uni.showToast({ title: '规划失败', icon: 'none' })
			} finally {
				uni.hideLoading()
				this.loading = false
			}
		},

		async loadCost() {
			try {
				const r = await chat({
					text: `帮我算下从${this.originName}到${this.destName}最省钱的方式`,
					lng: this.origin.lng,
					lat: this.origin.lat
				})
				const c = (r.cards || []).find((x) => x.type === 'cost')
				if (c) this.costPlan = c
			} catch (e) {}
		},

		async openNav() {
			uni.showModal({
				title: '确认导航',
				content: `将打开百度地图，从「${this.originName}」到「${this.destName}」，是否继续？`,
				success: async (r) => {
					if (!r.confirm) return
					try {
						await jumpToApp({
							app: '百度地图',
							type: 'direction',
							origin: `${this.origin.lat},${this.origin.lng}`,
							destination: this.destName,
							mode: this.mode
						})
					} catch (e) {
						uni.showToast({ title: '跳转失败，请手动打开地图', icon: 'none' })
					}
				}
			})
		}
	}
}
</script>

<style scoped>
.from-to {
	display: flex;
	align-items: center;
	padding: 12px 0;
	border-bottom: 1px solid #EDEFF2;
}
.dot {
	width: 10px;
	height: 10px;
	border-radius: 50%;
	margin-right: 12px;
	flex-shrink: 0;
}
.dot.start {
	background: #00B96B;
}
.dot.end {
	background: #F5222D;
}
.ft-mid {
	flex: 1;
	display: flex;
	flex-direction: column;
}
.ft-label {
	font-size: 12px;
	color: #8F959E;
}
.ft-val {
	font-size: 15px;
	color: #1A1A1A;
	margin-top: 2px;
}
.ft-inp {
	font-size: 15px;
	color: #1A1A1A;
	height: 28px;
	margin-top: 2px;
}
.ph {
	color: #8F959E;
}
.swap {
	font-size: 18px;
	color: #1677FF;
	padding: 0 8px;
}
.modes {
	display: flex;
	margin: 14px 0 6px;
}
.mode-pill {
	margin-right: 8px;
}
.realtime {
	display: flex;
	align-items: center;
	justify-content: space-between;
	margin: 10px 0;
}
.lh-card .lh-btn {
	margin-top: 14px;
}
.sum {
	display: flex;
	justify-content: space-around;
	padding: 8px 0 12px;
}
.sum-item {
	display: flex;
	flex-direction: column;
	align-items: center;
}
.sum-num {
	font-size: 26px;
	font-weight: 600;
	color: #1677FF;
	line-height: 1.2;
}
.sum-unit {
	font-size: 12px;
	color: #8F959E;
	margin-top: 2px;
}
.congestion {
	background: #FFF4E6;
	border-radius: 10px;
	padding: 8px 12px;
	margin-bottom: 12px;
}
.cong-text {
	font-size: 13px;
	color: #FF8A00;
}
.steps {
	border-top: 1px solid #EDEFF2;
	padding-top: 10px;
}
.step-row {
	display: flex;
	padding: 10px 0;
	border-bottom: 1px solid #EDEFF2;
}
.step-row:last-child {
	border-bottom: none;
}
.step-idx {
	width: 22px;
	height: 22px;
	line-height: 22px;
	text-align: center;
	border-radius: 50%;
	background: #EAF2FF;
	color: #1677FF;
	font-size: 12px;
	font-weight: 600;
	margin-right: 10px;
	flex-shrink: 0;
}
.step-mid {
	flex: 1;
}
.step-txt {
	font-size: 14px;
	color: #1A1A1A;
	display: block;
}
.alts {
	margin-top: 14px;
	padding-top: 12px;
	border-top: 1px solid #EDEFF2;
}
.alt-row {
	display: flex;
	justify-content: space-between;
	padding: 8px 0;
}
.ghost {
	background: #FFFFFF;
	color: #1677FF;
	border: 1px solid #1677FF;
}
.cost-list {
	margin-top: 10px;
}
.cost-row {
	display: flex;
	align-items: center;
	padding: 8px 0;
	border-bottom: 1px solid #EDEFF2;
}
.cost-row:last-child {
	border-bottom: none;
}
.c-name {
	flex: 1;
	font-size: 14px;
	color: #1A1A1A;
}
.c-cost {
	font-size: 14px;
	color: #00B96B;
	font-weight: 600;
	width: 60px;
	text-align: right;
}
.c-time {
	font-size: 13px;
	color: #8F959E;
	width: 70px;
	text-align: right;
}
</style>
