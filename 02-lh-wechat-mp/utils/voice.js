/**
 * 鲤慧 LiHui · 小程序语音能力（v3 · 全内置零插件）
 *
 * 识别链路（唯一）：
 *   RecorderManager（微信原生录音）→ 服务端 ASR（/voice/asr）
 *   ⚠️ 不再使用「微信同声传译插件」——插件授权失败(89360)会导致模拟器无法启动，
 *      且依赖 mp 后台逐个授权，与「能力内置」原则冲突。已整体移除。
 * 播报链路（唯一）：
 *   服务端 TTS（/voice/tts）→ 音频 URL 播放
 *   服务端内置微软 Edge 免费合成引擎（无需任何密钥），百度语音密钥配置后自动优先用百度音色。
 *
 * ⚠️ 架构要点：RecorderManager 是「全局单例」，onXxx 监听器只能注册一次，
 *    否则多次点击麦克风会堆积旧监听器、跨页面互踩（已修复的历史 Bug）。
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

/* ---------------- 播报（服务端 TTS） ---------------- */
function speak(text, opts) {
  opts = opts || {}
  if (!text) return Promise.resolve(false)
  return loadVoiceConfig().then((cfg) => {
    // 自动播报开关（设置页可关；opts.force 用于「试听」强制播报）
    if (cfg.autoSpeak === false && !opts.force) return false
    const careMode = opts.careMode !== undefined ? opts.careMode : cfg.careMode
    const volume = careMode ? Math.max(cfg.volume || 1, 1.2) : cfg.volume || 1

    return api
      .tts(text, { scene: opts.scene || 'chat' })
      .then((r) => {
        if (r && r.mode === 'server-audio' && r.audioUrl) {
          const base = config.BASE_URL.replace('/api/v1', '')
          const url = /^https?:\/\//.test(r.audioUrl) ? r.audioUrl : base + r.audioUrl
          return play(url, volume)
        }
        return false
      })
      .catch(() => false)
  })
}

function play(url, volume) {
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
      audio.onError(() => resolve(false))
      audio.play()
    } catch (e) {
      resolve(false)
    }
  })
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

/* ---------------- 识别（录音 → 服务端 ASR） ---------------- */
let recHandler = null

function ensureRecorder() {
  if (recorder) return recorder
  recorder = wx.getRecorderManager()
  // 监听器只注册一次，通过 recHandler 转发 —— 防止重复注册导致旧回调互踩
  recorder.onStop((res) => {
    const h = recHandler
    recHandler = null
    if (!h) return
    recognize(res.tempFilePath)
      .then((text) => {
        if (text) h.onFinal(text)
        else h.onError({ msg: '没听清，请再试一次' })
      })
      .catch((e) => h.onError(e))
  })
  recorder.onError((e) => {
    const h = recHandler
    recHandler = null
    if (h) h.onError(e)
  })
  return recorder
}

/**
 * 开始语音识别（统一入口，页面只调这个）
 * handlers: { onPartial(text)?, onFinal(text), onError(err) }
 * 返回 'recorder' | 'denied' | null
 */
function startSpeech(handlers) {
  wx.getSetting({
    success: (s) => {
      const auth = s.authSetting && s.authSetting['scope.record']
      if (auth === false) {
        wx.showModal({
          title: '需要麦克风权限',
          content: '语音对话需要使用麦克风。请在设置中开启「麦克风」权限后重试。',
          confirmText: '去开启',
          success: (r) => {
            if (r.confirm) wx.openSetting({})
          }
        })
        handlers.onError({ msg: 'record auth denied' })
        return
      }
      recHandler = handlers
      try {
        ensureRecorder().start({
          duration: 60000,
          sampleRate: 16000,
          numberOfChannels: 1,
          encodeBitRate: 96000,
          format: 'wav'
        })
      } catch (e) {
        recHandler = null
        handlers.onError(e)
      }
    },
    fail: () => handlers.onError({ msg: 'getSetting failed' })
  })
}

/** 结束识别 */
function stopSpeech() {
  try {
    recorder && recorder.stop()
  } catch (e) {}
}

/* ---------------- 兼容旧接口 ---------------- */
function startRecord(onStop) {
  startSpeech({
    onFinal: (text) => onStop && onStop({ tempFilePath: null, text }),
    onError: (e) => onStop && onStop(null, e)
  })
}

function stopRecord() {
  stopSpeech()
}

function recognize(tempFilePath) {
  if (!tempFilePath) return Promise.resolve('')
  return api.uploadAsr(tempFilePath)
}

module.exports = {
  loadVoiceConfig,
  getCached,
  speak,
  stopSpeak,
  startSpeech,
  stopSpeech,
  startRecord,
  stopRecord,
  recognize
}
