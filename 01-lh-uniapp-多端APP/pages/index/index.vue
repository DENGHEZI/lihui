<template>
	<view class="page">
		<!-- 地图底图（App 端由 manifest 里配置的百度地图 SDK 渲染） -->
		<map
			id="lhmap"
			class="map"
			:longitude="center.lng"
			:latitude="center.lat"
			:scale="scale"
			:markers="markers"
			:circles="circles"
			show-location
			enable-rotate
			@markertap="onMarkerTap"
		></map>

		<!-- 顶部：搜索框 + 位置 -->
		<view class="top" :style="{ paddingTop: safeTop + 'px' }">
			<view class="loc-row">
				<text class="loc-ico">📍</text>
				<text class="loc-text">{{ cityText }}</text>
				<text class="loc-src">{{ locSourceText }}</text>
				<view class="care-chip" :class="{ on: careMode }" @click="toggleCare">
					<text>{{ careMode ? '关怀模式 开' : '关怀模式' }}</text>
				</view>
			</view>

			<lh-search-bar
				v-model="keyword"
				:suggests="suggests"
				:show-suggest="suggests.length > 0"
				@change="onKeywordChange"
				@confirm="onSearch"
				@voice="onVoice"
				@pick="onPickSuggest"
			/>
		</view>

		<!-- 悬浮按钮 -->
		<view class="fabs">
			<view class="lh-fab" @click="locateMe">
				<text class="fab-ico">◎</text>
			</view>
			<view class="lh-fab" @click="goLife">
				<text class="fab-ico">◔</text>
			</view>
		</view>

		<!-- 底部抽屉 -->
		<view class="sheet" :style="{ height: sheetHeight + 'px' }" @touchstart="onTouchStart" @touchmove="onTouchMove" @touchend="onTouchEnd">
			<view class="lh-handle"></view>

			<!-- 折叠态：快捷服务 -->
			<scroll-view scroll-y class="sheet-body">
				<view v-if="!poiList.length" class="quick">
					<text class="lh-h2">周边便民服务</text>
					<text class="lh-cap quick-sub">15 分钟步行范围内，一键查看</text>
					<view class="quick-grid">
						<view v-for="s in quickServices" :key="s.key" class="quick-item" @click="quickSearch(s)">
							<text class="q-ico">{{ s.icon }}</text>
							<text class="q-name">{{ s.name }}</text>
						</view>
					</view>

					<view class="rec-head">
						<text class="lh-h2">出行休闲推荐</text>
						<text class="more" @click="loadScenic">换一批 ›</text>
					</view>
					<view v-if="scenic.length" class="scenic">
						<view v-for="(s, i) in scenic" :key="i" class="scenic-item" @click="navigate(s)">
							<text class="s-name">{{ s.name }}</text>
							<text class="s-meta">{{ s.tag }} · {{ fmtDist(s.distance) }}</text>
						</view>
					</view>

					<view class="weather" v-if="weather">
						<text class="lh-h2">今日天气</text>
						<view class="w-row">
							<text class="w-temp">{{ weather.temperature }}°</text>
							<view class="w-mid">
								<text class="lh-body">{{ weather.text }}</text>
								<text class="lh-mini">{{ weather.city }} · 湿度 {{ weather.humidity }}% · AQI {{ weather.aqi }}</text>
							</view>
						</view>
						<text v-if="weather.tips" class="w-tip">{{ weather.tips }}</text>
					</view>
				</view>

				<!-- 展开态：POI 列表 -->
				<view v-else>
					<view class="list-head">
						<text class="lh-h2">{{ lastQuery }} · {{ poiList.length }} 条</text>
						<text class="clear" @click="clearPoi">清除</text>
					</view>
					<lh-poi-item
						v-for="(p, i) in poiList"
						:key="i"
						:item="p"
						:icon="curIcon"
						@tap="navigate"
					/>
					<view v-if="loadingPoi" class="loading">正在搜索…</view>
				</view>
			</scroll-view>
		</view>

		<!-- 语音浮层 -->
		<view v-if="voicePanel" class="voice-mask" @click="voicePanel = false">
			<view class="voice-card" @click.stop>
				<text class="lh-h2">{{ voiceState === 'recording' ? '正在聆听…' : '语音输入' }}</text>
				<text class="lh-cap">{{ voiceHint }}</text>
				<view class="voice-mic" :class="voiceState" @click="toggleRecord">
					<view class="wave" v-if="voiceState === 'recording'">
						<view v-for="n in 5" :key="n" class="bar" :style="{ animationDelay: n * 0.12 + 's' }"></view>
					</view>
					<text v-else>🎙</text>
				</view>
				<text class="lh-mini">我的声音：{{ voiceName }}</text>
			</view>
		</view>
	</view>
</template>

<script>
import config from '@/utils/config.js'
import { getLocation } from '@/api/user.js'
import { poiSearch, weather as weatherApi, scenicRecommend, suggest as suggestApi, locateByIp } from '@/api/map.js'
import { chat } from '@/api/agent.js'
import { getCareMode, toggleCareMode, saveLastLocation, getLastLocation } from '@/utils/care.js'
import { speak, startRecord, stopRecord, recognize } from '@/utils/voice.js'
import lhSearchBar from '@/components/lh-search-bar.vue'
import lhPoiItem from '@/components/lh-poi-item.vue'

export default {
	components: { lhSearchBar, lhPoiItem },
	data() {
		return {
			safeTop: 20,
			center: { lng: 112.938814, lat: 28.228209 },
			scale: 15,
			cityText: '正在定位…',
			locSourceText: '',
			keyword: '',
			suggests: [],
			suggestTimer: null,
			poiList: [],
			lastQuery: '',
			curIcon: '📍',
			loadingPoi: false,
			quickServices: config.QUICK_SERVICES,
			scenic: [],
			weather: null,
			careMode: false,
			sheetHeight: 300,
			sheetMin: 300,
			sheetMax: 0,
			touchStartY: 0,
			touchStartH: 0,
			voicePanel: false,
			voiceState: 'idle',
			voiceHint: '点击麦克风开始说话',
			voiceName: '我的声音',
			markers: [],
			circles: []
		}
	},
	onLoad() {
		const info = uni.getSystemInfoSync()
		this.safeTop = (info.statusBarHeight || 20) + 8
		this.sheetMax = Math.round(info.windowHeight * 0.86)
		this.careMode = getCareMode()
		this.bootstrap()
	},
	methods: {
		async bootstrap() {
			// 1) 先用缓存位置快速出图
			const cached = getLastLocation()
			if (cached) {
				this.applyLocation(cached, true)
			}
			// 2) 精确定位（GPS 优先，失败回落 IP 锚定）
			const loc = await getLocation()
			this.applyLocation(loc)
			saveLastLocation(loc)

			// 3) 首屏内容
			this.loadScenic()
			this.loadWeather()
			if (!cached) this.quickSearch(this.quickServices[0])
		},

		applyLocation(loc, silent) {
			this.center = { lng: Number(loc.lng), lat: Number(loc.lat) }
			this.cityText = [loc.city, loc.district].filter(Boolean).join(' ') || '当前位置'
			this.locSourceText = loc.source === 'gps' ? 'GPS 定位' : loc.source === 'ip' ? 'IP 锚定' : '默认城市'
			this.updateMarkers()
			if (!silent) this.updateCircle()
		},

		updateMarkers() {
			this.markers = [
				{
					id: 1,
					longitude: this.center.lng,
					latitude: this.center.lat,
					width: 28,
					height: 28,
					callout: { content: '我的位置', color: '#1677FF', fontSize: 12, borderRadius: 6, padding: 4, display: 'BYCLICK' }
				}
			]
		},

		updateCircle() {
			this.circles = [
				{
					longitude: this.center.lng,
					latitude: this.center.lat,
					radius: config.DEFAULT_RADIUS,
					fillColor: '#1677FF1A',
					color: '#1677FFAA',
					strokeWidth: 1
				}
			]
		},

		onMarkerTap(e) {
			uni.showToast({ title: '这是我的位置', icon: 'none' })
		},

		onKeywordChange(v) {
			clearTimeout(this.suggestTimer)
			if (!v || v.length < 2) {
				this.suggests = []
				return
			}
			this.suggestTimer = setTimeout(async () => {
				try {
					const list = await suggestApi(v, this.cityText.split(' ')[0])
					this.suggests = (list || []).slice(0, 6)
				} catch (e) {
					this.suggests = []
				}
			}, 350)
		},

		onPickSuggest(s) {
			this.keyword = s.name
			this.suggests = []
			if (s.lng) {
				this.center = { lng: s.lng, lat: s.lat }
				this.poiList = [{ name: s.name, address: s.district, lng: s.lng, lat: s.lat, distance: null }]
				this.lastQuery = s.name
				this.expandSheet()
			}
		},

		async onSearch() {
			const kw = (this.keyword || '').trim()
			if (!kw) return
			this.suggests = []
			await this.doSearch(kw, '🔍', true)
		},

		quickSearch(s) {
			this.keyword = s.name
			this.doSearch(s.query, s.icon, true)
		},

		async doSearch(query, icon, useAgent) {
			this.loadingPoi = true
			this.curIcon = icon || '📍'
			this.expandSheet()
			try {
				const data = await poiSearch(query, this.center.lng, this.center.lat, config.DEFAULT_RADIUS)
				this.poiList = (data.items || []).filter((x) => x.name)
				this.lastQuery = this.keyword || query
				this.updatePoiMarkers()
				if (!this.poiList.length) {
					uni.showToast({ title: '附近 15 分钟范围内没找到，可试试 AI 助手', icon: 'none' })
				}
			} catch (e) {
				this.poiList = []
			} finally {
				this.loadingPoi = false
			}
		},

		updatePoiMarkers() {
			this.markers = [
				...this.markers.filter((m) => m.id === 1),
				...this.poiList.slice(0, 10).map((p, i) => ({
					id: i + 100,
					longitude: p.lng,
					latitude: p.lat,
					width: 22,
					height: 22,
					callout: { content: p.name, color: '#1A1A1A', fontSize: 12, borderRadius: 6, padding: 4, display: 'BYCLICK' }
				}))
			]
		},

		clearPoi() {
			this.poiList = []
			this.lastQuery = ''
			this.collapseSheet()
			this.updateMarkers()
		},

		async loadScenic() {
			try {
				const d = await scenicRecommend(this.center.lng, this.center.lat, 3000)
				this.scenic = (d.items || []).slice(0, 4)
			} catch (e) {}
		},

		async loadWeather() {
			try {
				this.weather = await weatherApi({ lng: this.center.lng, lat: this.center.lat })
			} catch (e) {}
		},

		async locateMe() {
			uni.showLoading({ title: '定位中' })
			const loc = await getLocation()
			uni.hideLoading()
			this.applyLocation(loc)
			this.updateCircle()
			saveLastLocation(loc)
			uni.showToast({ title: '已回到我的位置', icon: 'none' })
		},

		goLife() {
			uni.switchTab({ url: '/pages/life/life' })
		},

		toggleCare() {
			this.careMode = toggleCareMode()
			uni.showToast({ title: this.careMode ? '关怀模式已开启' : '关怀模式已关闭', icon: 'none' })
		},

		/* ---------- 抽屉拖拽 ---------- */
		onTouchStart(e) {
			this.touchStartY = e.touches[0].clientY
			this.touchStartH = this.sheetHeight
		},
		onTouchMove(e) {
			const dy = this.touchStartY - e.touches[0].clientY
			const h = Math.max(this.sheetMin, Math.min(this.sheetMax, this.touchStartH + dy))
			this.sheetHeight = h
		},
		onTouchEnd() {
			if (this.sheetHeight > this.sheetMin + 60) this.expandSheet()
			else this.collapseSheet()
		},
		expandSheet() {
			this.sheetHeight = Math.round(this.sheetMax * 0.62)
		},
		collapseSheet() {
			this.sheetHeight = this.sheetMin
		},

		/* ---------- 语音 ---------- */
		onVoice() {
			this.voicePanel = true
			this.voiceState = 'idle'
			this.voiceHint = '点击麦克风开始说话'
		},

		toggleRecord() {
			if (this.voiceState === 'recording') {
				stopRecord()
				this.voiceState = 'processing'
				this.voiceHint = '正在识别…'
				return
			}
			this.voiceState = 'recording'
			this.voiceHint = '再点一次结束'
			startRecord(async (res) => {
				try {
					const text = await recognize(res.tempFilePath)
					this.voicePanel = false
					this.keyword = text
					await this.askAgent(text)
				} catch (e) {
					this.voiceState = 'idle'
					this.voiceHint = (e && e.message) || '没听清，请再说一次'
				}
			})
		},

		async askAgent(text) {
			uni.showLoading({ title: '鲤慧思考中' })
			try {
				const r = await chat({ text, lng: this.center.lng, lat: this.center.lat })
				uni.hideLoading()
				uni.showModal({
					title: '鲤慧',
					content: r.reply,
					showCancel: false,
					confirmText: '知道了'
				})
				if (r.cards) {
					const poi = r.cards.find((c) => c.type === 'poi_list')
					if (poi) {
						this.poiList = poi.items
						this.lastQuery = poi.title || text
						this.updatePoiMarkers()
						this.expandSheet()
					}
				}
				speak(r.reply, { scene: 'chat', careMode: this.careMode })
			} catch (e) {
				uni.hideLoading()
			}
		},

		/* ---------- 导航 ---------- */
		navigate(p) {
			uni.navigateTo({
				url: `/pages/route/route?name=${encodeURIComponent(p.name)}&lng=${p.lng}&lat=${p.lat}`
			})
		},

		fmtDist(d) {
			if (d === null || d === undefined) return ''
			return Number(d) >= 1000 ? (Number(d) / 1000).toFixed(1) + ' km' : Math.round(Number(d)) + ' m'
		}
	}
}
</script>

<style scoped>
.page {
	position: relative;
	width: 100%;
	height: 100vh;
	overflow: hidden;
}
.map {
	width: 100%;
	height: 100%;
}

.top {
	position: absolute;
	left: 0;
	right: 0;
	top: 0;
	padding: 0 16px 12px;
	z-index: 20;
}
.loc-row {
	display: flex;
	align-items: center;
	padding: 8px 4px 10px;
}
.loc-ico {
	font-size: 14px;
	margin-right: 4px;
}
.loc-text {
	font-size: 16px;
	font-weight: 600;
	color: #1A1A1A;
	margin-right: 6px;
}
.loc-src {
	font-size: 11px;
	color: #8F959E;
	background: #FFFFFFCC;
	padding: 2px 6px;
	border-radius: 6px;
}
.care-chip {
	margin-left: auto;
	font-size: 12px;
	color: #646A73;
	background: #FFFFFFCC;
	border-radius: 999px;
	padding: 4px 10px;
}
.care-chip.on {
	color: #1677FF;
	font-weight: 600;
	background: #EAF2FF;
}

.fabs {
	position: absolute;
	right: 16px;
	bottom: 340px;
	z-index: 18;
}
.fabs .lh-fab {
	margin-top: 12px;
}
.fab-ico {
	font-size: 22px;
	color: #1677FF;
}

.sheet {
	position: absolute;
	left: 0;
	right: 0;
	bottom: 0;
	background: #FFFFFF;
	border-radius: 20px 20px 0 0;
	box-shadow: 0 -4px 20px rgba(0, 0, 0, .08);
	z-index: 25;
	transition: height .26s cubic-bezier(.16, 1, .3, 1);
	overflow: hidden;
}
.sheet-body {
	height: calc(100% - 20px);
	padding: 0 16px 24px;
	box-sizing: border-box;
}

.quick-sub {
	display: block;
	margin: 4px 0 12px;
}
.quick-grid {
	display: flex;
	flex-wrap: wrap;
}
.quick-item {
	width: 25%;
	display: flex;
	flex-direction: column;
	align-items: center;
	padding: 10px 0 14px;
}
.q-ico {
	font-size: 22px;
	width: 44px;
	height: 44px;
	line-height: 44px;
	text-align: center;
	background: #F4F5F7;
	border-radius: 14px;
	margin-bottom: 6px;
}
.q-name {
	font-size: 12px;
	color: #646A73;
}

.rec-head {
	display: flex;
	align-items: center;
	justify-content: space-between;
	margin: 8px 0 10px;
}
.more {
	font-size: 13px;
	color: #1677FF;
}
.scenic {
	display: flex;
	flex-wrap: wrap;
}
.scenic-item {
	width: 48%;
	background: #F8F9FB;
	border-radius: 12px;
	padding: 10px;
	margin: 0 2% 8px 0;
	box-sizing: border-box;
}
.s-name {
	font-size: 14px;
	color: #1A1A1A;
	font-weight: 600;
	display: block;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.s-meta {
	font-size: 12px;
	color: #8F959E;
	margin-top: 4px;
	display: block;
}

.weather {
	margin-top: 8px;
	padding-top: 12px;
	border-top: 1px solid #EDEFF2;
}
.w-row {
	display: flex;
	align-items: center;
	margin-top: 8px;
}
.w-temp {
	font-size: 32px;
	font-weight: 600;
	color: #1A1A1A;
	margin-right: 12px;
}
.w-mid {
	display: flex;
	flex-direction: column;
}
.w-tip {
	font-size: 12px;
	color: #646A73;
	margin-top: 8px;
	display: block;
	background: #F8F9FB;
	padding: 8px 10px;
	border-radius: 10px;
}

.list-head {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 4px 0 8px;
}
.clear {
	font-size: 13px;
	color: #8F959E;
}
.loading {
	text-align: center;
	font-size: 13px;
	color: #8F959E;
	padding: 16px 0;
}

.voice-mask {
	position: fixed;
	left: 0;
	right: 0;
	top: 0;
	bottom: 0;
	background: rgba(0, 0, 0, .45);
	z-index: 60;
	display: flex;
	align-items: center;
	justify-content: center;
}
.voice-card {
	width: 280px;
	background: #FFFFFF;
	border-radius: 20px;
	padding: 24px 20px;
	display: flex;
	flex-direction: column;
	align-items: center;
}
.voice-mic {
	width: 72px;
	height: 72px;
	border-radius: 50%;
	background: linear-gradient(135deg, #3A8BFF 0%, #1677FF 100%);
	display: flex;
	align-items: center;
	justify-content: center;
	color: #FFFFFF;
	font-size: 28px;
	margin: 16px 0 10px;
}
.voice-mic.recording {
	animation: pulse 1.6s infinite;
}
@keyframes pulse {
	0% { box-shadow: 0 0 0 0 rgba(22, 119, 255, .45); }
	70% { box-shadow: 0 0 0 22px rgba(22, 119, 255, 0); }
	100% { box-shadow: 0 0 0 0 rgba(22, 119, 255, 0); }
}
.wave {
	display: flex;
	align-items: center;
}
.bar {
	width: 4px;
	height: 16px;
	background: #FFFFFF;
	border-radius: 2px;
	margin: 0 2px;
	animation: wave 1s infinite ease-in-out;
}
@keyframes wave {
	0%, 100% { height: 10px; }
	50% { height: 26px; }
}
</style>
