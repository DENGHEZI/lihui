<template>
	<view class="lh-page">
		<view class="lh-card">
			<text class="lh-h1">反馈与建议</text>
			<text class="lh-cap">您的问题会被同步到管理端，我们会在 24 小时内处理并回复。</text>

			<view class="types">
				<text
					v-for="t in types"
					:key="t.key"
					class="lh-pill type-pill"
					:class="{ 'lh-pill--on': form.type === t.key }"
					@click="form.type = t.key"
				>{{ t.icon }} {{ t.name }}</text>
			</view>

			<textarea
				v-model="form.content"
				class="ta"
				placeholder="请描述遇到的问题或您的建议…"
				placeholder-class="ph"
				maxlength="1000"
				:auto-height="false"
			/>
			<text class="lh-mini count">{{ form.content.length }} / 1000</text>

			<view class="img-row">
				<view v-for="(img, i) in form.screenshots" :key="i" class="img-item">
					<image :src="img" mode="aspectFill" class="img"></image>
					<text class="del" @click="form.screenshots.splice(i, 1)">×</text>
				</view>
				<view v-if="form.screenshots.length < 3" class="img-add" @click="chooseImage">＋</view>
			</view>

			<view class="field">
				<text class="lh-cap">联系方式（选填）</text>
				<input v-model="form.contact" class="inp" placeholder="手机号或邮箱，便于我们回复您" placeholder-class="ph" />
			</view>

			<button class="lh-btn" :class="{ dis: !form.content.trim() }" @click="submit">提交反馈</button>
		</view>

		<!-- 我的反馈记录 -->
		<view class="lh-card" v-if="history.length">
			<text class="lh-h2">我的反馈记录</text>
			<view v-for="(h, i) in history" :key="i" class="hist-row">
				<view class="h-top">
					<text class="h-type">{{ typeName(h.type) }}</text>
					<text class="h-status" :style="{ color: statusColor(h.status) }">{{ statusName(h.status) }}</text>
				</view>
				<text class="h-text">{{ h.content }}</text>
				<text class="lh-mini">{{ h.createdAt }}</text>
				<text v-if="h.reply" class="h-reply">回复：{{ h.reply }}</text>
			</view>
		</view>

		<view class="lh-card">
			<text class="lh-h2">紧急联系方式</text>
			<text class="lh-cap">如果遇到紧急情况，请直接拨打：</text>
			<view class="hot">
				<view class="hot-row" @click="call('120')"><text class="hot-name">急救</text><text class="hot-tel">120</text></view>
				<view class="hot-row" @click="call('110')"><text class="hot-name">报警</text><text class="hot-tel">110</text></view>
				<view class="hot-row" @click="call('12356')"><text class="hot-name">心理援助热线</text><text class="hot-tel">12356</text></view>
			</view>
		</view>

		<view style="height: 32px"></view>
	</view>
</template>

<script>
import { submitFeedback, tokenStats } from '@/api/life.js'
import { getDeviceId } from '@/utils/token.js'

export default {
	data() {
		return {
			form: { type: 'bug', content: '', contact: '', screenshots: [] },
			types: [
				{ key: 'bug', name: '问题反馈', icon: '🐞' },
				{ key: 'feature', name: '功能建议', icon: '💡' },
				{ key: 'complaint', name: '投诉', icon: '⚠️' },
				{ key: 'praise', name: '表扬', icon: '👏' }
			],
			history: []
		}
	},
	methods: {
		typeName(t) {
			const m = this.types.find((x) => x.key === t)
			return m ? m.name : t
		},
		statusName(s) {
			return { pending: '待处理', processing: '处理中', resolved: '已解决', rejected: '已驳回' }[s] || s
		},
		statusColor(s) {
			return { pending: '#FF8A00', processing: '#1677FF', resolved: '#00B96B', rejected: '#8F959E' }[s] || '#646A73'
		},

		chooseImage() {
			uni.chooseImage({
				count: 3 - this.form.screenshots.length,
				sizeType: ['compressed'],
				success: (res) => {
					this.form.screenshots = this.form.screenshots.concat(res.tempFilePaths).slice(0, 3)
				}
			})
		},

		async submit() {
			const content = this.form.content.trim()
			if (!content) return
			uni.showLoading({ title: '提交中' })
			try {
				const r = await submitFeedback({
					type: this.form.type,
					content,
					contact: this.form.contact,
					deviceId: getDeviceId(),
					page: 'feedback',
					appVersion: '1.0.0',
					platform: this.platform(),
					screenshots: this.form.screenshots
				})
				uni.hideLoading()
				uni.showToast({ title: '已提交，感谢反馈', icon: 'success' })
				this.history.unshift({
					type: this.form.type,
					content,
					status: (r && r.status) || 'pending',
					createdAt: new Date().toLocaleString(),
					reply: ''
				})
				this.form.content = ''
				this.form.screenshots = []
			} catch (e) {
				uni.hideLoading()
			}
		},

		platform() {
			let p = 'h5'
			// #ifdef APP-PLUS
			p = plus.os.name === 'iOS' ? 'ios' : 'android'
			// #endif
			return p
		},

		call(n) {
			uni.makePhoneCall({ phoneNumber: n, fail: () => {} })
		}
	}
}
</script>

<style scoped>
.lh-card {
	margin: 12px 16px 0;
}
.types {
	display: flex;
	flex-wrap: wrap;
	margin: 12px 0;
}
.type-pill {
	margin: 0 8px 8px 0;
}
.ta {
	width: 100%;
	height: 130px;
	background: #F4F5F7;
	border-radius: 12px;
	padding: 12px;
	font-size: 15px;
	box-sizing: border-box;
	margin-top: 6px;
}
.ph {
	color: #8F959E;
}
.count {
	text-align: right;
	display: block;
	margin-top: 4px;
}
.img-row {
	display: flex;
	flex-wrap: wrap;
	margin-top: 10px;
}
.img-item {
	position: relative;
	width: 76px;
	height: 76px;
	margin: 0 8px 8px 0;
}
.img {
	width: 76px;
	height: 76px;
	border-radius: 10px;
}
.del {
	position: absolute;
	right: -6px;
	top: -6px;
	width: 20px;
	height: 20px;
	line-height: 18px;
	text-align: center;
	border-radius: 50%;
	background: #F5222D;
	color: #FFFFFF;
	font-size: 14px;
}
.img-add {
	width: 76px;
	height: 76px;
	border-radius: 10px;
	border: 1px dashed #C8CDD4;
	color: #8F959E;
	font-size: 26px;
	display: flex;
	align-items: center;
	justify-content: center;
}
.field {
	margin-top: 8px;
}
.inp {
	height: 44px;
	background: #F4F5F7;
	border-radius: 12px;
	padding: 0 12px;
	font-size: 15px;
	margin-top: 6px;
}
.lh-card .lh-btn {
	margin-top: 18px;
}
.dis {
	background: #C8CDD4;
}
.hist-row {
	padding: 12px 0;
	border-bottom: 1px solid #EDEFF2;
}
.hist-row:last-child {
	border-bottom: none;
}
.h-top {
	display: flex;
	justify-content: space-between;
}
.h-type {
	font-size: 13px;
	color: #1677FF;
	font-weight: 600;
}
.h-status {
	font-size: 13px;
}
.h-text {
	font-size: 14px;
	color: #1A1A1A;
	margin: 6px 0 4px;
	display: block;
}
.h-reply {
	font-size: 13px;
	color: #00B96B;
	margin-top: 4px;
	display: block;
}
.hot-row {
	display: flex;
	justify-content: space-between;
	padding: 12px 0;
	border-bottom: 1px solid #EDEFF2;
}
.hot-row:last-child {
	border-bottom: none;
}
.hot-name {
	font-size: 15px;
	color: #1A1A1A;
}
.hot-tel {
	font-size: 15px;
	color: #1677FF;
	font-weight: 600;
}
</style>
