/**
 * 鲤慧 LiHui · 小程序语音能力
 *  - 播报：服务端 TTS 音频 → InnerAudioContext 播放；无音频回落微信系统朗读（同声传译插件可选）
 *  - 识别：RecorderManager 录音 → 上传服务端 ASR
 */
const api = require('./api.js')
const config = require('./config.js')

let audio = null
let recorder = null
let voiceCfg = null

function loadVoiceConfig(force) {
  if (voiceCfg && !force) return Promise.resolve(voiceCfg)
  return api
    .getVoiceConfig()
    .then((c) => {
      voiceCfg = c
      return c
    })
    .catch(() => {
      voiceCfg = { engine: 'local', speed: 1, pitch: 1, volume: 1, speaker: 'per_0', careMode: false, autoSpeak: true }
      return voiceCfg
    })
}

function getCached() {
  return voiceCfg
}

/**
 * 播报
 */
function speak(text, opts) {
  opts = opts || {}
  if (!text) return Promise.resolve(false)
  return loadVoiceConfig().then((cfg) => {
    const careMode = opts.careMode !== undefined ? opts.careMode : cfg.careMode
    const volume = careMode ? Math.max(cfg.volume || 1, 1.2) : cfg.volume || 1

    return api
      .tts(text, { scene: opts.scene || 'chat' })
      .then((r) => {
        if (r && r.mode === 'server-audio' && r.audioUrl) {
          const base = config.BASE_URL.replace('/api/v1', '')
          const url = /^https?:\/\//.test(r.audioUrl) ? r.audioUrl : base + r.audioUrl
          return play(url, volume, text)
        }
        return systemSpeakFallback(text)
      })
      .catch(() => systemSpeakFallback(text))
  })
}

function play(url, volume, fallbackText) {
  return new Promise((resolve) => {
    try {
      if (audio) {
        audio.stop()
        audio.destroy()
        audio = null
      }
      audio = wx.createInnerAudioContext()
      audio.src = url
      audio.volume = Math.min(1, volume || 1)
      audio.onEnded(() => resolve(true))
      audio.onError(() => {
        systemSpeakFallback(fallbackText || '').then(() => resolve(false))
      })
      audio.play()
    } catch (e) {
      resolve(false)
    }
  })
}

/**
 * 端上兜底：优先微信同声传译插件，其次提示用户
 * 同声传译插件需在小程序后台「第三方设置 → 插件管理」申请后，于 app.json 中声明。
 */
function systemSpeakFallback(text) {
  try {
    const plugin = requirePlugin && requirePlugin('WechatSI')
    if (plugin && plugin.textToSpeech) {
      return new Promise((resolve) => {
        plugin.textToSpeech({
          lang: 'zh_CN',
          tts: true,
          content: text,
          success: (res) => {
            if (audio) {
              audio.stop()
              audio.destroy()
              audio = null
            }
            audio = wx.createInnerAudioContext()
            audio.src = res.filename
            audio.play()
            resolve(true)
          },
          fail: () => resolve(false)
        })
      })
    }
  } catch (e) {}
  console.log('[鲤慧-语音] 小程序未接入语音合成插件，文本：', text)
  return Promise.resolve(false)
}

function stopSpeak() {
  try {
    if (audio) {
      audio.stop()
      audio.destroy()
      audio = null
    }
  } catch (e) {}
}

/* ---------------- 录音识别 ---------------- */
function startRecord(onStop) {
  recorder = wx.getRecorderManager()
  recorder.onStop((res) => onStop && onStop(res))
  recorder.onError((e) => onStop && onStop(null, e))
  recorder.start({
    duration: 60000,
    sampleRate: 16000,
    numberOfChannels: 1,
    encodeBitRate: 96000,
    format: 'wav'
  })
  return true
}

function stopRecord() {
  try {
    recorder && recorder.stop()
  } catch (e) {}
}

function recognize(tempFilePath) {
  return api.uploadAsr(tempFilePath)
}

module.exports = { loadVoiceConfig, getCached, speak, stopSpeak, startRecord, stopRecord, recognize }
