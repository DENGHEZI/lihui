<template>
	<view class="lh-page">
		<!-- 模型列表 -->
		<view class="lh-card">
			<view class="head">
				<text class="lh-h2">我的模型 / API</text>
				<text class="add" @click="openEditor()">+ 添加</text>
			</view>
			<text class="lh-cap">支持 OpenAI 兼容 / Anthropic / Gemini / Ollama 等任意接口，Key 只存在你自己的服务端。</text>

			<view v-for="m in models" :key="m.id" class="model-row" :class="{ on: m.isDefault }">
				<view class="m-mid" @click="setDefault(m)">
					<view class="m-name-row">
						<text class="m-name">{{ m.name }}</text>
						<text v-if="m.isDefault" class="m-badge">使用中</text>
						<text v-else-if="!m.enabled" class="m-badge off">已停用</text>
					</view>
					<text class="m-meta">{{ m.provider }} · {{ m.model }}</text>
					<text class="m-meta">{{ m.baseUrl || '（默认地址）' }} · Key {{ m.apiKey || '未设置' }}</text>
					<text v-if="m.note" class="lh-mini">{{ m.note }}</text>
				</view>
				<view class="m-ops">
					<text class="op" @click="testModelItem(m)">测试</text>
					<text class="op" @click="openEditor(m)">编辑</text>
				</view>
			</view>
		</view>

		<!-- 语音设置 -->
		<view class="lh-card">
			<text class="lh-h2">自定义语音</text>
			<text class="lh-cap">选择音色、语速、方言，老年人可开启关怀模式自动放慢加响。</text>

			<view class="row">
				<text class="lh-body">语音引擎</text>
				<picker :range="engineNames" :value="engineIndex" @change="onEngine">
					<text class="pick">{{ engineNames[engineIndex] }} ▾</text>
				</picker>
			</view>

			<view class="row">
				<text class="lh-body">音色</text>
				<picker :range="speakerNames" :value="speakerIndex" @change="onSpeaker">
					<text class="pick">{{ speakerNames[speakerIndex] }} ▾</text>
				</picker>
			</view>

			<view class="row">
				<text class="lh-body">方言</text>
				<picker :range="dialectNames" :value="dialectIndex" @change="onDialect">
					<text class="pick">{{ dialectNames[dialectIndex] }} ▾</text>
				</picker>
			</view>

			<view class="slider-row">
				<text class="lh-body">语速 {{ voice.speed.toFixed(2) }}</text>
				<slider :value="voice.speed * 50" min="25" max="100" activeColor="#1677FF" @change="onSpeed" />
			</view>
			<view class="slider-row">
				<text class="lh-body">音调 {{ voice.pitch.toFixed(2) }}</text>
				<slider :value="voice.pitch * 50" min="25" max="100" activeColor="#1677FF" @change="onPitch" />
			</view>
			<view class="slider-row">
				<text class="lh-body">音量 {{ voice.volume.toFixed(2) }}</text>
				<slider :value="voice.volume * 50" min="0" max="75" activeColor="#1677FF" @change="onVolume" />
			</view>

			<view class="row">
				<text class="lh-body">唤醒词</text>
				<input v-model="voice.wakeWord" class="row-inp" placeholder="如：小鲤小鲤" placeholder-class="ph" @blur="save" />
			</view>

			<view class="row">
				<text class="lh-body">自动播报结果</text>
				<switch :checked="voice.autoSpeak" color="#1677FF" @change="voice.autoSpeak = $event.detail.value; save()" />
			</view>

			<view class="row">
				<text class="lh-body">关怀模式（老年人）</text>
				<switch :checked="voice.careMode" color="#1677FF" @change="onCare" />
			</view>

			<button class="lh-btn ghost" @click="trySpeak">试听一下</button>
		</view>

		<!-- 高级 -->
		<view class="lh-card">
			<text class="lh-h2">高级</text>
			<view class="row">
				<text class="lh-body">当前套餐</text>
				<view class="plans">
					<text class="lh-pill" :class="{ 'lh-pill--on': plan === 'free' }" @click="setPlan('free')">免费基础版</text>
					<text class="lh-pill" :class="{ 'lh-pill--on': plan === 'pro' }" @click="setPlan('pro')">增强版</text>
				</view>
			</view>
			<view class="row">
				<text class="lh-body">MCP 工具</text>
				<text class="lh-cap" @click="showMcp">查看可用工具 ›</text>
			</view>
			<text class="lh-mini">增强版会调用 MCP 工具（成本优化、情感疏通、桌面操作等），Token 消耗更高。</text>
		</view>

		<!-- 模型编辑弹层 -->
		<view v-if="editor.show" class="mask" @click="editor.show = false">
			<view class="editor" @click.stop>
				<text class="lh-h2">{{ editor.id ? '编辑模型' : '添加模型' }}</text>

				<view class="e-row">
					<text class="lh-cap">显示名称</text>
					<input v-model="editor.name" class="e-inp" placeholder="如：我的通义千问" placeholder-class="ph" />
				</view>
				<view class="e-row">
					<text class="lh-cap">协议类型</text>
					<picker :range="providerNames" :value="providerIndex" @change="onProvider">
						<text class="pick">{{ providerNames[providerIndex] }} ▾</text>
					</picker>
				</view>
				<view class="e-row">
					<text class="lh-cap">Base URL</text>
					<input v-model="editor.baseUrl" class="e-inp" placeholder="https://…/v1" placeholder-class="ph" />
				</view>
				<view class="e-row">
					<text class="lh-cap">API Key</text>
					<input v-model="editor.apiKey" class="e-inp" placeholder="sk-…" placeholder-class="ph" password />
				</view>
				<view class="e-row">
					<text class="lh-cap">模型名</text>
					<input v-model="editor.model" class="e-inp" placeholder="如 qwen-plus / deepseek-chat" placeholder-class="ph" />
				</view>

				<view class="e-ops">
					<button class="lh-btn ghost half" @click="editor.show = false">取消</button>
					<button class="lh-btn half" @click="saveModelItem">保存</button>
				</view>
			</view>
		</view>

		<view style="height: 32px"></view>
	</view>
</template>

<script>
import { listModels, saveModel, testModel, setDefaultModel, getVoiceConfig, saveVoiceConfig, listTools } from '@/api/user.js'
import { getPlan, setPlan } from '@/utils/token.js'
import { getCareMode, setCareMode } from '@/utils/care.js'
import { speak, loadVoiceConfig } from '@/utils/voice.js'

export default {
	data() {
		return {
			models: [],
			voice: { engine: 'baidu', speaker: 'per_4', speed: 1, pitch: 1, volume: 1, wakeWord: '小鲤小鲤', dialect: 'putonghua', autoSpeak: true, careMode: false },
			plan: 'pro',
			editor: { show: false, id: '', name: '', provider: 'openai-compatible', baseUrl: '', apiKey: '', model: '' },
			providers: [
				{ key: 'openai-compatible', name: 'OpenAI 兼容' },
				{ key: 'deepseek', name: 'DeepSeek' },
				{ key: 'anthropic', name: 'Anthropic' },
				{ key: 'gemini', name: 'Gemini' },
				{ key: 'ollama', name: '本地 Ollama' },
				{ key: 'baidu-qianfan', name: '百度千帆' }
			],
			engines: [
				{ key: 'baidu', name: '百度语音（推荐）' },
				{ key: 'azure', name: 'Azure 语音' },
				{ key: 'local', name: '系统 TTS（离线）' },
				{ key: 'custom', name: '自定义接口' }
			],
			speakers: [
				{ key: 'per_4', name: '度丫丫 · 温柔女声（适老）' },
				{ key: 'per_0', name: '度小美 · 标准女声' },
				{ key: 'per_1', name: '度小宇 · 标准男声' },
				{ key: 'per_3', name: '度逍遥 · 磁性男声' },
				{ key: 'per_5003', name: '度米朵 · 情感女声' }
			],
			dialects: [
				{ key: 'putonghua', name: '普通话' },
				{ key: 'yue', name: '粤语' },
				{ key: 'sichuan', name: '四川话' },
				{ key: 'dongbei', name: '东北话' }
			]
		}
	},
	computed: {
		providerNames() {
			return this.providers.map((p) => p.name)
		},
		providerIndex() {
			const i = this.providers.findIndex((p) => p.key === this.editor.provider)
			return i < 0 ? 0 : i
		},
		engineNames() {
			return this.engines.map((e) => e.name)
		},
		engineIndex() {
			const i = this.engines.findIndex((e) => e.key === this.voice.engine)
			return i < 0 ? 0 : i
		},
		speakerNames() {
			return this.speakers.map((s) => s.name)
		},
		speakerIndex() {
			const i = this.speakers.findIndex((s) => s.key === this.voice.speaker)
			return i < 0 ? 0 : i
		},
		dialectNames() {
			return this.dialects.map((d) => d.name)
		},
		dialectIndex() {
			const i = this.dialects.findIndex((d) => d.key === this.voice.dialect)
			return i < 0 ? 0 : i
		}
	},
	onLoad() {
		this.plan = getPlan()
		this.loadModels()
		this.loadVoice()
	},
	methods: {
		async loadModels() {
			try {
				const d = await listModels(false)
				this.models = d.items || []
			} catch (e) {
				this.models = []
			}
		},

		async loadVoice() {
			try {
				const cfg = await getVoiceConfig()
				this.voice = Object.assign({}, this.voice, cfg)
				this.voice.careMode = getCareMode()
			} catch (e) {}
		},

		openEditor(m) {
			if (m) {
				this.editor = {
					show: true,
					id: m.id,
					name: m.name,
					provider: m.provider,
					baseUrl: m.baseUrl,
					apiKey: '',
					model: m.model
				}
			} else {
				this.editor = { show: true, id: '', name: '', provider: 'openai-compatible', baseUrl: '', apiKey: '', model: '' }
			}
		},

		onProvider(e) {
			this.editor.provider = this.providers[e.detail.value].key
		},

		async saveModelItem() {
			if (!this.editor.name || !this.editor.model) {
				uni.showToast({ title: '请填写名称与模型名', icon: 'none' })
				return
			}
			uni.showLoading({ title: '保存中' })
			try {
				await saveModel(this.editor)
				this.editor.show = false
				uni.hideLoading()
				uni.showToast({ title: '已保存', icon: 'success' })
				this.loadModels()
			} catch (e) {
				uni.hideLoading()
			}
		},

		async testModelItem(m) {
			uni.showLoading({ title: '测试中' })
			try {
				const r = await testModel({ id: m.id })
				uni.hideLoading()
				if (r && r.ok) {
					uni.showModal({ title: '连接正常', content: `耗时 ${r.latencyMs} ms\n模型回复：${r.reply}`, showCancel: false })
				} else {
					uni.showModal({ title: '连接失败', content: (r && r.msg) || '请检查 Base URL 与 Key', showCancel: false })
				}
			} catch (e) {
				uni.hideLoading()
			}
		},

		async setDefault(m) {
			try {
				await setDefaultModel(m.id)
				uni.showToast({ title: '已设为默认模型', icon: 'none' })
				this.loadModels()
			} catch (e) {}
		},

		onEngine(e) {
			this.voice.engine = this.engines[e.detail.value].key
			this.save()
		},
		onSpeaker(e) {
			this.voice.speaker = this.speakers[e.detail.value].key
			this.save()
		},
		onDialect(e) {
			this.voice.dialect = this.dialects[e.detail.value].key
			this.save()
		},
		onSpeed(e) {
			this.voice.speed = e.detail.value / 50
			this.save()
		},
		onPitch(e) {
			this.voice.pitch = e.detail.value / 50
			this.save()
		},
		onVolume(e) {
			this.voice.volume = e.detail.value / 50
			this.save()
		},
		onCare(e) {
			this.voice.careMode = e.detail.value
			setCareMode(e.detail.value)
			this.save()
		},

		async save() {
			try {
				await saveVoiceConfig(this.voice)
				await loadVoiceConfig(true)
			} catch (e) {}
		},

		async trySpeak() {
			await this.save()
			speak('前面 300 米有药店，走路 4 分钟就到。', { scene: 'navigation', careMode: this.voice.careMode })
			uni.showToast({ title: '正在试听', icon: 'none' })
		},

		setPlan(p) {
			this.plan = p
			setPlan(p)
			uni.showToast({ title: p === 'pro' ? '已切换到增强版' : '已切换到免费基础版', icon: 'none' })
		},

		async showMcp() {
			uni.showLoading({ title: '读取中' })
			try {
				const d = await listTools(this.plan)
				uni.hideLoading()
				const text = (d.groups || [])
					.map((g) => `${g.serverName}：${g.tools.map((t) => t.name).join('、')}`)
					.join('\n')
				uni.showModal({ title: `${d.total} 个可用工具`, content: text || '暂无', showCancel: false })
			} catch (e) {
				uni.hideLoading()
			}
		}
	}
}
</script>

<style scoped>
.head {
	display: flex;
	align-items: center;
	justify-content: space-between;
}
.add {
	font-size: 14px;
	color: #1677FF;
	font-weight: 600;
}
.lh-card > .lh-cap {
	display: block;
	margin-top: 6px;
}
.model-row {
	display: flex;
	align-items: center;
	padding: 14px 0;
	border-bottom: 1px solid #EDEFF2;
}
.model-row:last-child {
	border-bottom: none;
}
.model-row.on {
	background: #F5F9FF;
	margin: 0 -16px;
	padding: 14px 16px;
	border-radius: 12px;
}
.m-mid {
	flex: 1;
	min-width: 0;
}
.m-name-row {
	display: flex;
	align-items: center;
}
.m-name {
	font-size: 15px;
	font-weight: 600;
	color: #1A1A1A;
}
.m-badge {
	margin-left: 8px;
	font-size: 11px;
	color: #1677FF;
	background: #EAF2FF;
	border-radius: 6px;
	padding: 2px 6px;
}
.m-badge.off {
	color: #8F959E;
	background: #F4F5F7;
}
.m-meta {
	display: block;
	font-size: 12px;
	color: #646A73;
	margin-top: 3px;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.m-ops {
	display: flex;
	flex-direction: column;
	align-items: flex-end;
	margin-left: 10px;
}
.op {
	font-size: 13px;
	color: #1677FF;
	margin-bottom: 8px;
}
.row {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 12px 0;
	border-bottom: 1px solid #EDEFF2;
}
.row-inp {
	font-size: 15px;
	color: #1A1A1A;
	text-align: right;
	flex: 1;
}
.ph {
	color: #8F959E;
}
.pick {
	font-size: 15px;
	color: #1677FF;
}
.slider-row {
	padding: 6px 0;
}
.slider-row .lh-body {
	display: block;
	margin-bottom: 4px;
}
.plans {
	display: flex;
}
.plans .lh-pill {
	margin-left: 8px;
}
.lh-card .lh-btn {
	margin-top: 16px;
}
.mask {
	position: fixed;
	left: 0;
	right: 0;
	top: 0;
	bottom: 0;
	background: rgba(0, 0, 0, .45);
	z-index: 60;
	display: flex;
	align-items: flex-end;
}
.editor {
	width: 100%;
	background: #FFFFFF;
	border-radius: 20px 20px 0 0;
	padding: 20px 16px calc(20px + env(safe-area-inset-bottom));
	max-height: 86vh;
	overflow-y: auto;
	box-sizing: border-box;
}
.e-row {
	padding: 10px 0;
	border-bottom: 1px solid #EDEFF2;
}
.e-inp {
	height: 40px;
	background: #F4F5F7;
	border-radius: 10px;
	padding: 0 12px;
	font-size: 15px;
	margin-top: 6px;
}
.pick {
	display: block;
	margin-top: 6px;
	height: 40px;
	line-height: 40px;
	background: #F4F5F7;
	border-radius: 10px;
	padding: 0 12px;
	color: #1A1A1A;
}
.e-ops {
	display: flex;
	margin-top: 20px;
}
.half {
	flex: 1;
}
.half:first-child {
	margin-right: 10px;
}
</style>
