<template>
	<view class="lh-page chat-page">
		<!-- 顶部：场景快捷入口 -->
		<view class="scene-bar">
			<scroll-view scroll-x class="scene-scroll">
				<view class="scene-list">
					<text
						v-for="(s, i) in scenes"
						:key="i"
						class="lh-pill scene-pill"
						@click="ask(s.text)"
					>{{ s.icon }} {{ s.name }}</text>
				</view>
			</scroll-view>
		</view>

		<!-- 消息流 -->
		<scroll-view scroll-y class="msgs" :scroll-into-view="scrollTo" scroll-with-animation>
			<view v-for="(m, i) in messages" :key="i" :id="'m' + i" class="msg-row" :class="m.role">
				<view v-if="m.role === 'assistant'" class="avatar">鲤</view>
				<view class="bubble" :class="m.role">
					<text class="txt">{{ m.text }}</text>

					<!-- 卡片：生活圈评分 -->
					<view v-if="m.cards && m.cards.length" class="cards">
						<view v-for="(c, ci) in m.cards" :key="ci" class="card">
							<view v-if="c.type === 'life_score'" class="card-life">
								<text class="c-title">生活圈体检 {{ c.score }} 分 · {{ c.level }}</text>
								<view v-for="(s, si) in (c.shortboards || [])" :key="si" class="c-line">• {{ s }}</view>
							</view>

							<view v-else-if="c.type === 'poi_list'" class="card-poi">
								<text class="c-title">{{ c.title }}</text>
								<view v-for="(p, pi) in (c.items || []).slice(0, 5)" :key="pi" class="c-poi-row" @click="goRoute(p)">
									<text class="p-name">{{ p.name }}</text>
									<text class="p-dist">{{ fmtDist(p.distance) }}</text>
								</view>
							</view>

							<view v-else-if="c.type === 'route'" class="card-route">
								<text class="c-title">路线 {{ (c.distance / 1000).toFixed(1) }} km · 约 {{ Math.round((c.duration || 0) / 60) }} 分钟</text>
								<text v-if="c.congestion" class="c-sub">路况：{{ c.congestion }}</text>
							</view>

							<view v-else-if="c.type === 'cost'" class="card-cost">
								<text class="c-title">{{ c.title || '省钱方案' }}</text>
								<text v-if="c.recommended" class="c-sub">推荐：{{ c.recommended.name }} · ¥{{ c.recommended.cost }}</text>
								<text v-if="c.saved" class="c-save">比最贵方案省 ¥{{ c.saved }}，月省约 ¥{{ c.monthlySavingEstimate }}</text>
								<text v-if="c.verdict" class="c-sub">{{ c.verdict }}</text>
							</view>

							<view v-else-if="c.type === 'weather'" class="card-weather">
								<text class="c-title">{{ c.city }} {{ c.temperature }}° {{ c.text }}</text>
								<text class="c-sub">湿度 {{ c.humidity }}% · AQI {{ c.aqi }}</text>
							</view>

							<view v-else-if="c.type === 'action_plan'" class="card-action">
								<text class="c-title">{{ c.title }}（需您确认）</text>
								<view v-for="(s, si) in (c.steps || [])" :key="si" class="c-line">{{ s.step }}. {{ s.action }}</view>
								<button class="lh-btn confirm-btn" @click="confirmAction(c)">我已确认，继续</button>
							</view>
						</view>
					</view>

					<!-- 动作按钮 -->
					<view v-if="m.actions && m.actions.length" class="actions">
						<button v-for="(a, ai) in m.actions" :key="ai" class="lh-btn act-btn" @click="runAction(a)">{{ a.type === 'open_app' ? '打开' + a.app + '导航' : a.type }}</button>
					</view>

					<view v-if="m.meta" class="meta">
						<text class="lh-mini">{{ m.meta }}</text>
					</view>
				</view>
			</view>
			<view style="height: 16px"></view>
		</scroll-view>

		<!-- 输入区 -->
		<view class="input-bar">
			<view class="care-toggle" :class="{ on: careMode }" @click="toggleCare">
				<text>{{ careMode ? '关怀' : '标准' }}</text>
			</view>
			<input
				v-model="input"
				class="chat-input"
				placeholder="问鲤慧：附近哪里能看病？"
				placeholder-class="ph"
				confirm-type="send"
				@confirm="send"
			/>
			<view class="mic-btn" :class="{ rec: recording }" @click="toggleRecord">
				<text>{{ recording ? '■' : '🎙' }}</text>
			</view>
			<view class="send-btn" :class="{ dis: !input.trim() }" @click="send">
				<text>发送</text>
			</view>
		</view>
	</view>
</template>

<script>
import { chat, newSessionId } from '@/api/agent.js'
import { getLocation } from '@/api/user.js'
import { getCareMode, toggleCareMode } from '@/utils/care.js'
import { speak, startRecord, stopRecord, recognize } from '@/utils/voice.js'
import { jumpToApp } from '@/utils/action.js'
import { logAction } from '@/utils/token.js'

export default {
	data() {
		return {
			sessionId: newSessionId(),
			input: '',
			messages: [],
			scrollTo: '',
			careMode: false,
			recording: false,
			location: null,
			scenes: [
				{ icon: '🏥', name: '附近看病', text: '附近 15 分钟能看病吗？' },
				{ icon: '🛒', name: '买菜', text: '附近哪里买菜最方便？' },
				{ icon: '🌳', name: '遛弯', text: '附近适合遛弯的公园在哪？' },
				{ icon: '💰', name: '省一笔', text: '帮我算下最省钱的出行方案' },
				{ icon: '🚌', name: '怎么走', text: '我要出门，帮我规划路线并避开拥堵' },
				{ icon: '🛍', name: '帮买', text: '帮我看看哪里买洗衣液最划算' },
				{ icon: '💬', name: '聊聊', text: '今天有点累，想找人聊聊' }
			]
		}
	},
	onLoad() {
		this.careMode = getCareMode()
		this.messages.push({
			role: 'assistant',
			text: '我是鲤慧。\n可以问我：\n1. 附近哪里能看病？\n2. 15 分钟生活圈缺什么？\n3. 怎么走最省时间、最省钱？\n直接说，或按住麦克风讲。',
			meta: '关怀模式已' + (this.careMode ? '开启' : '关闭')
		})
		getLocation().then((l) => (this.location = l))
	},
	methods: {
		async send() {
			const text = this.input.trim()
			if (!text) return
			this.input = ''
			await this.ask(text)
		},

		async ask(text) {
			this.messages.push({ role: 'user', text })
			this.messages.push({ role: 'assistant', text: '正在为您查询…', loading: true })
			this.toBottom()
			try {
				const r = await chat({
					text,
					sessionId: this.sessionId,
					lng: this.location && this.location.lng,
					lat: this.location && this.location.lat
				})
				this.messages.splice(this.messages.length - 1, 1)
				this.messages.push({
					role: 'assistant',
					text: r.reply,
					cards: r.cards,
					actions: r.actions,
					meta: `${r.model} · Token ${r.usage.total} · ¥${r.usage.costCny}`
				})
				this.toBottom()
				speak(r.reply, { scene: 'chat', careMode: this.careMode })
			} catch (e) {
				this.messages.splice(this.messages.length - 1, 1)
				this.messages.push({ role: 'assistant', text: '抱歉，刚才没查成功。请确认服务端已启动，或稍后再试。' })
				this.toBottom()
			}
		},

		toBottom() {
			this.$nextTick(() => {
				this.scrollTo = 'm' + (this.messages.length - 1)
			})
		},

		toggleRecord() {
			if (this.recording) {
				this.recording = false
				stopRecord()
				return
			}
			this.recording = true
			uni.showToast({ title: '请开始说话', icon: 'none', duration: 1000 })
			startRecord(async (res) => {
				this.recording = false
				try {
					const text = await recognize(res.tempFilePath)
					if (text) await this.ask(text)
					else uni.showToast({ title: '没听清，请再说一次', icon: 'none' })
				} catch (e) {
					uni.showModal({
						title: '语音识别未就绪',
						content: (e && e.message) || '服务端未配置语音识别密钥，可先用文字输入',
						showCancel: false
					})
				}
			})
		},

		toggleCare() {
			this.careMode = toggleCareMode()
			uni.showToast({ title: this.careMode ? '关怀模式已开启' : '关怀模式已关闭', icon: 'none' })
		},

		async runAction(a) {
			if (a.type === 'open_app') {
				uni.showModal({
					title: '确认跳转',
					content: `即将打开「${a.app}」并开始导航，是否继续？`,
					success: async (r) => {
						if (r.confirm) {
							logAction({ action: 'open_app', app: a.app, uri: a.uri })
							try {
								await jumpToApp({ app: a.app, destination: '' })
							} catch (e) {
								uni.showToast({ title: '跳转失败', icon: 'none' })
							}
						}
					}
				})
			}
		},

		confirmAction(c) {
			uni.showModal({
				title: '安全确认',
				content: '鲤慧不会读取或填写任何支付信息。付款前请务必自行核对价格与收货信息。是否继续？',
				confirmText: '已确认，继续',
				success: (r) => {
					if (r.confirm) {
						uni.showToast({ title: '已记录，请按步骤操作', icon: 'none' })
						logAction({ action: 'desktop_operate_confirm', title: c.title })
					}
				}
			})
		},

		goRoute(p) {
			uni.navigateTo({ url: `/pages/route/route?name=${encodeURIComponent(p.name)}&lng=${p.lng}&lat=${p.lat}` })
		},

		fmtDist(d) {
			if (d === null || d === undefined) return ''
			return Number(d) >= 1000 ? (Number(d) / 1000).toFixed(1) + 'km' : Math.round(Number(d)) + 'm'
		}
	}
}
</script>

<style scoped>
.chat-page {
	display: flex;
	flex-direction: column;
	height: 100vh;
	box-sizing: border-box;
}
.scene-bar {
	padding: 8px 0 4px;
	background: #FFFFFF;
	border-bottom: 1px solid #EDEFF2;
}
.scene-scroll {
	white-space: nowrap;
}
.scene-list {
	display: inline-flex;
	padding: 0 12px;
}
.scene-pill {
	margin-right: 8px;
	white-space: nowrap;
}
.msgs {
	flex: 1;
	padding: 12px 12px 0;
	box-sizing: border-box;
}
.msg-row {
	display: flex;
	margin-bottom: 14px;
}
.msg-row.user {
	flex-direction: row-reverse;
}
.avatar {
	width: 34px;
	height: 34px;
	border-radius: 50%;
	background: linear-gradient(135deg, #3A8BFF, #1677FF);
	color: #FFFFFF;
	font-size: 15px;
	font-weight: 600;
	display: flex;
	align-items: center;
	justify-content: center;
	margin-right: 8px;
	flex-shrink: 0;
}
.bubble {
	max-width: 78%;
	background: #FFFFFF;
	border-radius: 16px;
	padding: 12px 14px;
	box-shadow: 0 2px 10px rgba(0, 0, 0, .05);
}
.bubble.user {
	background: #1677FF;
}
.bubble.user .txt {
	color: #FFFFFF;
}
.txt {
	font-size: 15px;
	line-height: 1.55;
	color: #1A1A1A;
	word-break: break-all;
}
.cards {
	margin-top: 10px;
}
.card {
	background: #F8F9FB;
	border-radius: 12px;
	padding: 10px 12px;
	margin-bottom: 8px;
}
.c-title {
	font-size: 14px;
	font-weight: 600;
	color: #1A1A1A;
	display: block;
}
.c-sub {
	font-size: 12px;
	color: #646A73;
	margin-top: 4px;
	display: block;
}
.c-line {
	font-size: 12px;
	color: #646A73;
	margin-top: 4px;
	display: block;
	line-height: 1.5;
}
.c-save {
	font-size: 13px;
	color: #00B96B;
	font-weight: 600;
	margin-top: 6px;
	display: block;
}
.c-poi-row {
	display: flex;
	justify-content: space-between;
	padding: 7px 0;
	border-bottom: 1px solid #EDEFF2;
}
.c-poi-row:last-child {
	border-bottom: none;
}
.p-name {
	font-size: 13px;
	color: #1A1A1A;
	flex: 1;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.p-dist {
	font-size: 12px;
	color: #1677FF;
	margin-left: 8px;
}
.confirm-btn {
	height: 38px;
	font-size: 14px;
	margin-top: 10px;
}
.actions {
	margin-top: 10px;
}
.act-btn {
	height: 38px;
	font-size: 14px;
	margin-bottom: 6px;
}
.meta {
	margin-top: 8px;
}
.input-bar {
	display: flex;
	align-items: center;
	padding: 8px 12px;
	background: #FFFFFF;
	border-top: 1px solid #EDEFF2;
	padding-bottom: calc(8px + constant(safe-area-inset-bottom));
	padding-bottom: calc(8px + env(safe-area-inset-bottom));
}
.care-toggle {
	width: 48px;
	height: 34px;
	border-radius: 999px;
	background: #F4F5F7;
	color: #646A73;
	font-size: 12px;
	display: flex;
	align-items: center;
	justify-content: center;
	margin-right: 8px;
	flex-shrink: 0;
}
.care-toggle.on {
	background: #EAF2FF;
	color: #1677FF;
	font-weight: 600;
}
.chat-input {
	flex: 1;
	height: 40px;
	background: #F4F5F7;
	border-radius: 20px;
	padding: 0 14px;
	font-size: 15px;
}
.ph {
	color: #8F959E;
}
.mic-btn {
	width: 40px;
	height: 40px;
	border-radius: 50%;
	background: #EAF2FF;
	display: flex;
	align-items: center;
	justify-content: center;
	margin: 0 8px;
	font-size: 16px;
	color: #1677FF;
	flex-shrink: 0;
}
.mic-btn.rec {
	background: #F5222D;
	color: #FFFFFF;
}
.send-btn {
	height: 40px;
	padding: 0 16px;
	border-radius: 20px;
	background: #1677FF;
	color: #FFFFFF;
	font-size: 14px;
	font-weight: 600;
	display: flex;
	align-items: center;
	flex-shrink: 0;
}
.send-btn.dis {
	background: #C8CDD4;
}
</style>
