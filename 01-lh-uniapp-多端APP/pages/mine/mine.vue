<template>
	<view class="lh-page">
		<view class="profile">
			<view class="avatar">鲤</view>
			<view class="p-mid">
				<text class="p-name">鲤慧用户</text>
				<text class="lh-cap">{{ deviceShort }} · {{ planName }}</text>
			</view>
			<text class="p-loc">{{ locText }}</text>
		</view>

		<!-- Token 消耗 -->
		<view class="lh-card">
			<view class="head">
				<text class="lh-h2">Token 消耗</text>
				<text class="link" @click="loadStats">刷新</text>
			</view>
			<view class="tk-grid">
				<view class="tk-item">
					<text class="tk-num">{{ stats ? stats.total.total : 0 }}</text>
					<text class="tk-lb">近 7 日总量</text>
				</view>
				<view class="tk-item">
					<text class="tk-num">{{ stats ? stats.total.calls : 0 }}</text>
					<text class="tk-lb">调用次数</text>
				</view>
				<view class="tk-item">
					<text class="tk-num">¥{{ stats ? stats.total.costCny.toFixed(4) : '0.0000' }}</text>
					<text class="tk-lb">预估花费</text>
				</view>
			</view>
			<view class="quota" v-if="stats">
				<view class="q-bar">
					<view class="q-fill" :style="{ width: quotaPercent + '%' }"></view>
				</view>
				<text class="lh-mini">今日已用 {{ stats.quota.usedToday }} / {{ stats.quota.daily }} Token</text>
			</view>
			<view class="by-model" v-if="stats && stats.byModel.length">
				<view v-for="(m, i) in stats.byModel" :key="i" class="bm-row">
					<text class="bm-name">{{ m.model }}</text>
					<text class="bm-val">{{ m.total }} Token · ¥{{ m.costCny.toFixed(4) }}</text>
				</view>
			</view>
		</view>

		<!-- 功能入口 -->
		<view class="lh-card menu">
			<view class="menu-row" @click="go('/pages/settings/settings')">
				<text class="m-ico">⚙️</text>
				<text class="m-txt">模型与语音设置</text>
				<text class="m-arrow">›</text>
			</view>
			<view class="menu-row" @click="go('/pages/life/life')">
				<text class="m-ico">◔</text>
				<text class="m-txt">30 分钟生活圈体检</text>
				<text class="m-arrow">›</text>
			</view>
			<view class="menu-row" @click="go('/pages/feedback/feedback')">
				<text class="m-ico">✉️</text>
				<text class="m-txt">反馈与建议</text>
				<text class="m-arrow">›</text>
			</view>
			<view class="menu-row" @click="showAbout">
				<text class="m-ico">ℹ️</text>
				<text class="m-txt">关于鲤慧</text>
				<text class="m-arrow">›</text>
			</view>
		</view>

		<!-- 关怀模式 -->
		<view class="lh-card">
			<view class="row">
				<view>
					<text class="lh-body">关怀模式</text>
					<text class="lh-mini">大字、高对比、语音放慢，适合老年人</text>
				</view>
				<switch :checked="careMode" color="#1677FF" @change="onCare" />
			</view>
		</view>

		<!-- 平台与版本 -->
		<view class="lh-card">
			<view class="kv"><text class="lh-cap">当前平台</text><text class="kv-v">{{ platformName }}</text></view>
			<view class="kv"><text class="lh-cap">应用版本</text><text class="kv-v">{{ version }}</text></view>
			<view class="kv"><text class="lh-cap">服务端</text><text class="kv-v">{{ serverText }}</text></view>
			<view class="kv"><text class="lh-cap">MCP 工具</text><text class="kv-v">{{ mcpText }}</text></view>
		</view>

		<view style="height: 32px"></view>
	</view>
</template>

<script>
import config from '@/utils/config.js'
import { tokenStats } from '@/api/life.js'
import { getDeviceId, getPlan } from '@/utils/token.js'
import { getCareMode, setCareMode } from '@/utils/care.js'
import { publicConfig, getLocation } from '@/api/user.js'

export default {
	data() {
		return {
			stats: null,
			deviceId: '',
			plan: 'pro',
			careMode: false,
			locText: '',
			platformName: '',
			version: '1.0.0',
			serverText: config.BASE_URL,
			mcpText: '-'
		}
	},
	computed: {
		deviceShort() {
			return 'ID ' + this.deviceId.slice(-8)
		},
		planName() {
			return this.plan === 'pro' ? '增强版（已接入 API）' : '免费基础版'
		},
		quotaPercent() {
			if (!this.stats) return 0
			const q = this.stats.quota
			return Math.min(100, Math.round((q.usedToday / Math.max(1, q.daily)) * 100))
		}
	},
	onShow() {
		this.deviceId = getDeviceId()
		this.plan = getPlan()
		this.careMode = getCareMode()
		this.platformName = this.detectPlatform()
		try {
			this.version = uni.getSystemInfoSync().appVersion || '1.0.0'
		} catch (e) {}
		this.loadStats()
		this.loadConfig()
		getLocation().then((l) => {
			this.locText = [l.city, l.district].filter(Boolean).join(' ') || '未定位'
		})
	},
	methods: {
		detectPlatform() {
			let p = 'H5'
			// #ifdef APP-PLUS
			p = plus.os.name === 'iOS' ? 'iOS (App)' : 'Android (App)'
			// #endif
			// #ifdef APP-HARMONY
			p = 'HarmonyOS (App)'
			// #endif
			// #ifdef MP-WEIXIN
			p = '微信小程序'
			// #endif
			return p
		},

		async loadStats() {
			try {
				this.stats = await tokenStats('7d')
			} catch (e) {}
		},

		async loadConfig() {
			try {
				const c = await publicConfig()
				const running = (c.mcpServers || []).filter((s) => s.status === 'running').length
				this.mcpText = `${running}/${(c.mcpServers || []).length} 运行中`
			} catch (e) {
				this.mcpText = '服务端未连接'
			}
		},

		go(url) {
			if (url.indexOf('index') > -1 || url.indexOf('life') > -1) {
				uni.switchTab({ url })
			} else {
				uni.navigateTo({ url })
			}
		},

		onCare(e) {
			this.careMode = setCareMode(e.detail.value)
			uni.showToast({ title: this.careMode ? '关怀模式已开启' : '关怀模式已关闭', icon: 'none' })
		},

		showAbout() {
			uni.showModal({
				title: '关于鲤慧',
				content:
					'鲤慧 LiHui v1.0.0\n基于百度地图开放能力的「30 分钟生活圈」智能体检与规划助手。\n\n多端 APP：Android / HarmonyOS / iOS\n微信小程序：同一套服务端\n\n所有百度地图能力经服务端中转，AK 不下发到客户端。',
				showCancel: false
			})
		}
	}
}
</script>

<style scoped>
.profile {
	display: flex;
	align-items: center;
	padding: 20px 16px;
	background: linear-gradient(135deg, #EAF2FF, #F4F5F7);
}
.avatar {
	width: 56px;
	height: 56px;
	border-radius: 50%;
	background: linear-gradient(135deg, #3A8BFF, #1677FF);
	color: #FFFFFF;
	font-size: 22px;
	font-weight: 600;
	display: flex;
	align-items: center;
	justify-content: center;
	margin-right: 14px;
}
.p-mid {
	flex: 1;
	display: flex;
	flex-direction: column;
}
.p-name {
	font-size: 18px;
	font-weight: 600;
	color: #1A1A1A;
	margin-bottom: 4px;
}
.p-loc {
	font-size: 12px;
	color: #646A73;
	background: #FFFFFF;
	border-radius: 999px;
	padding: 4px 10px;
}
.lh-card {
	margin: 12px 16px 0;
}
.head {
	display: flex;
	align-items: center;
	justify-content: space-between;
}
.link {
	font-size: 13px;
	color: #1677FF;
}
.tk-grid {
	display: flex;
	margin-top: 14px;
}
.tk-item {
	flex: 1;
	display: flex;
	flex-direction: column;
	align-items: center;
}
.tk-num {
	font-size: 19px;
	font-weight: 600;
	color: #1677FF;
}
.tk-lb {
	font-size: 12px;
	color: #8F959E;
	margin-top: 4px;
}
.quota {
	margin-top: 16px;
}
.q-bar {
	height: 6px;
	background: #EDEFF2;
	border-radius: 3px;
	overflow: hidden;
}
.q-fill {
	height: 6px;
	background: #1677FF;
	border-radius: 3px;
}
.quota .lh-mini {
	display: block;
	margin-top: 6px;
}
.by-model {
	margin-top: 12px;
	border-top: 1px solid #EDEFF2;
	padding-top: 8px;
}
.bm-row {
	display: flex;
	justify-content: space-between;
	padding: 6px 0;
}
.bm-name {
	font-size: 13px;
	color: #1A1A1A;
}
.bm-val {
	font-size: 12px;
	color: #646A73;
}
.menu {
	padding: 4px 16px;
}
.menu-row {
	display: flex;
	align-items: center;
	padding: 15px 0;
	border-bottom: 1px solid #EDEFF2;
}
.menu-row:last-child {
	border-bottom: none;
}
.m-ico {
	font-size: 17px;
	margin-right: 12px;
}
.m-txt {
	flex: 1;
	font-size: 15px;
	color: #1A1A1A;
}
.m-arrow {
	font-size: 18px;
	color: #C8CDD4;
}
.row {
	display: flex;
	align-items: center;
	justify-content: space-between;
}
.row .lh-mini {
	display: block;
	margin-top: 4px;
}
.kv {
	display: flex;
	justify-content: space-between;
	padding: 9px 0;
}
.kv-v {
	font-size: 13px;
	color: #1A1A1A;
	max-width: 60%;
	text-align: right;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
</style>
