/**
 * 鲤慧 LiHui · 小程序语音能力（v2 全链路）
 *
 * 识别链路（优先级）：
 *   1) 微信同声传译插件 WechatSI —— 免费官方，实时识别（onRecognize 部分结果），支持中英文
 *   2) RecorderManager 录音 → 服务端 ASR（需百度密钥，未配置时不可用）
 * 播报链路（优先级）：
 *   1) 服务端 TTS（自定义音色 / 语速 / 音调 / 音量，见设置页）
 *   2) WechatSI 插件 textToSpeech（普通话兜底）
 *
 * ⚠️ 架构要点：RecorderManager 与 WechatSI 识别管理器都是「全局单例」，
 *    onXxx 监听器只能注册一次，否则多次点击麦克风会堆积旧监听器、
 *    跨页面互踩，导致「点麦克风对话莫名关闭」（已修复的历史 Bug）。
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

/* ---------------- 播报 ---------------- */
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
          return play(url, volume, text)
        }
        return pluginSpeak(text)
      })
      .catch(() => pluginSpeak(text))
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
        pluginSpeak(fallbackText || '').then(() => resolve(false))
      })
      audio.play()
    } catch (e) {
      resolve(false)
    }
  })
}

/** 端上 TTS：微信同声传译插件（免费，普通话） */
function pluginSpeak(text) {
  const plugin = getPlugin()
  if (plugin && plugin.textToSpeech) {
    return new Promise((resolve) => {
      plugin.textToSpeech({
        lang: 'zh_CN',
        tts: true,
        content: String(text).slice(0, 500),
        success: (res) => {
          try {
            if (audio) {
              audio.stop()
              audio.destroy()
              audio = null
            }
            audio = wx.createInnerAudioContext()
            audio.src = res.filename
            audio.onEnded(() => resolve(true))
            audio.onError(() => resolve(false))
            audio.play()
          } catch (e) {
            resolve(false)
          }
        },
        fail: () => resolve(false)
      })
    })
  }
  console.log('[鲤慧-语音] 插件 TTS 不可用，文本：', text)
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

/* ---------------- 识别（主链路：WechatSI 实时识别） ---------------- */
let siManager = null
let siHandlers = null // { onPartial, onFinal, onError }

function getPlugin() {
  try {
    return requirePlugin('WechatSI') || null
  } catch (e) {
    return null
  }
}

/** 全局只初始化一次；监听器只注册一次，通过 siHandlers 转发到当前调用方 */
function getSiManager() {
  if (siManager) return siManager
  const plugin = getPlugin()
  if (!plugin || !plugin.getRecordRecognitionManager) return null
  siManager = plugin.getRecordRecognitionManager()
  siManager.onRecognize((res) => {
    if (siHandlers && siHandlers.onPartial && res && res.result) siHandlers.onPartial(res.result)
  })
  siManager.onStop((res) => {
    const h = siHandlers
    siHandlers = null
    if (!h) return
    const text = String((res && res.result) || '').trim()
    if (text) h.onFinal(text)
    else h.onError({ msg: '没听清，请再试一次' })
  })
  siManager.onError((err) => {
    const h = siHandlers
    siHandlers = null
    if (h) h.onError(err)
  })
  return siManager
}

/* ---------------- 识别（兜底：录音 + 服务端 ASR） ---------------- */
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
 * 返回 'plugin' | 'recorder' | 'denied' | null
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
      _startSpeechInner(handlers)
    },
    fail: () => _startSpeechInner(handlers)
  })
}

function _startSpeechInner(handlers) {
  const mgr = getSiManager()
  if (mgr) {
    siHandlers = handlers
    try {
      mgr.start({ duration: 60000, lang: 'zh_CN' })
      return 'plugin'
    } catch (e) {
      siHandlers = null
    }
  }
  // 兜底：录音 → 服务端 ASR
  recHandler = handlers
  try {
    ensureRecorder().start({
      duration: 60000,
      sampleRate: 16000,
      numberOfChannels: 1,
      encodeBitRate: 96000,
      format: 'wav'
    })
    return 'recorder'
  } catch (e) {
    recHandler = null
    handlers.onError(e)
    return null
  }
}

/** 结束识别：mode 为 startSpeech 的返回值 */
function stopSpeech(mode) {
  if (mode === 'plugin' && siManager) {
    try {
      siManager.stop()
    } catch (e) {}
    return
  }
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
  stopSpeech('recorder')
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
  getPlugin,
  startRecord,
  stopRecord,
  recognize
}
