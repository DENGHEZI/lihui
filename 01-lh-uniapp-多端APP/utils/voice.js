/**
 * 鲤慧 LiHui · 语音能力封装（自定义语音）
 *  - 播报：优先服务端 TTS 音频；无音频时回落端上系统 TTS（关怀模式自动降速）
 *  - 识别：端上录音 → 上传服务端 ASR；失败提示改用文字输入
 */
import { tts as ttsApi, getVoiceConfig } from '../api/user.js'

let audioCtx = null
let voiceCfg = null

export async function loadVoiceConfig(force) {
	if (voiceCfg && !force) return voiceCfg
	try {
		voiceCfg = await getVoiceConfig()
	} catch (e) {
		voiceCfg = { engine: 'local', speed: 1, pitch: 1, volume: 1, speaker: 'per_0', careMode: false, autoSpeak: true }
	}
	return voiceCfg
}

export function getCachedVoiceConfig() {
	return voiceCfg
}

/**
 * 播报文本
 * @param {string} text
 * @param {object} opts { scene, careMode }
 */
export async function speak(text, opts = {}) {
	if (!text) return
	const cfg = await loadVoiceConfig()
	const careMode = opts.careMode !== undefined ? opts.careMode : cfg.careMode
	const speed = careMode ? Math.min(cfg.speed || 1, 0.85) : cfg.speed || 1
	const volume = careMode ? Math.max(cfg.volume || 1, 1.2) : cfg.volume || 1

	// 1) 服务端 TTS
	try {
		const r = await ttsApi(text, { scene: opts.scene || 'chat' })
		if (r && r.mode === 'server-audio' && r.audioUrl) {
			const base = require('../utils/config.js').default.BASE_URL.replace('/api/v1', '')
			const url = /^https?:\/\//.test(r.audioUrl) ? r.audioUrl : base + r.audioUrl
			return playAudio(url, volume)
		}
	} catch (e) {
		// 忽略，走端上
	}

	// 2) 端上系统 TTS
	return systemSpeak(text, { speed, pitch: cfg.pitch || 1, volume })
}

function playAudio(url, volume) {
	return new Promise((resolve) => {
		try {
			if (audioCtx) {
				audioCtx.destroy()
				audioCtx = null
			}
			audioCtx = uni.createInnerAudioContext()
			audioCtx.src = url
			audioCtx.volume = Math.min(1, volume || 1)
			audioCtx.onEnded(() => resolve(true))
			audioCtx.onError(() => {
				systemSpeak('', {}).finally(() => resolve(false))
			})
			audioCtx.play()
		} catch (e) {
			resolve(false)
		}
	})
}

function systemSpeak(text, { speed = 1, pitch = 1, volume = 1 } = {}) {
	// #ifdef APP-PLUS
	try {
		const Speech = plus.speech
		if (Speech && Speech.startRecognize === undefined && plus.android) {
			// Android 系统 TTS
		}
	} catch (e) {}
	// #endif

	// uni-app 通用：Android/iOS/H5 用 plus.speech（App）或朗读 API
	// #ifdef APP-PLUS
	try {
		const main = plus.android ? plus.android.runtimeMainActivity() : null
		if (plus.ios && plus.ios.importClass) {
			// iOS：AVSpeechSynthesizer
			const AVSpeechSynthesizer = plus.ios.importClass('AVSpeechSynthesizer')
			const AVSpeechUtterance = plus.ios.importClass('AVSpeechUtterance')
			const synth = new AVSpeechSynthesizer()
			const utt = AVSpeechUtterance.speechUtteranceWithString(text)
			utt.setRate(0.5 * speed)
			utt.setVolume(volume)
			synth.speakUtterance(utt)
			return Promise.resolve(true)
		}
		if (main && plus.android) {
			// Android：TextToSpeech
			const TextToSpeech = plus.android.importClass('android.speech.tts.TextToSpeech')
			const tts = new TextToSpeech(main, null)
			tts.setSpeechRate(speed)
			tts.setPitch(pitch)
			tts.speak(text, 0, null, 'lh_' + Date.now())
			return Promise.resolve(true)
		}
	} catch (e) {}
	// #endif

	// #ifdef H5
	try {
		if (typeof window !== 'undefined' && window.speechSynthesis) {
			const u = new SpeechSynthesisUtterance(text)
			u.lang = 'zh-CN'
			u.rate = speed
			u.pitch = pitch
			u.volume = Math.min(1, volume)
			window.speechSynthesis.speak(u)
			return Promise.resolve(true)
		}
	} catch (e) {}
	// #endif

	console.log('[鲤慧-语音] 当前平台无系统 TTS，文本：', text)
	return Promise.resolve(false)
}

export function stopSpeak() {
	try {
		if (audioCtx) {
			audioCtx.stop()
			audioCtx.destroy()
			audioCtx = null
		}
	} catch (e) {}
	// #ifdef H5
	try {
		window.speechSynthesis && window.speechSynthesis.cancel()
	} catch (e) {}
	// #endif
}

/* ---------------- 语音识别（录音 → 服务端 ASR） ---------------- */
let recorder = null
let recordStart = 0

export function startRecord(onStop) {
	recorder = uni.getRecorderManager()
	recorder.onStop((res) => {
		onStop && onStop(res)
	})
	recorder.start({
		duration: 60000,
		sampleRate: 16000,
		numberOfChannels: 1,
		encodeBitRate: 96000,
		format: 'wav'
	})
	recordStart = Date.now()
}

export function stopRecord() {
	try {
		recorder && recorder.stop()
	} catch (e) {}
	return Date.now() - recordStart
}

/**
 * 上传音频做识别
 * @returns {Promise<string>} 识别出的文本
 */
export function recognize(tempFilePath) {
	return new Promise((resolve, reject) => {
		const config = require('../utils/config.js').default
		const { getDeviceId } = require('../utils/token.js')
		uni.uploadFile({
			url: config.BASE_URL + '/voice/asr',
			filePath: tempFilePath,
			name: 'audio',
			header: { 'X-Device-Id': getDeviceId() },
			success: (res) => {
				try {
					const body = JSON.parse(res.data)
					if (body.code === 0 && body.data && body.data.text) resolve(body.data.text)
					else reject(new Error((body.data && body.data.hint) || '未识别到内容'))
				} catch (e) {
					reject(e)
				}
			},
			fail: reject
		})
	})
}
