#!/usr/bin/env node
/**
 * 鲤慧 LiHui · MCP Server: voice
 * 自定义语音 —— 音色/语速/音调/音量/方言 配置，TTS 合成与 ASR 识别
 * 工具：list_speakers / tts_plan / asr_hint
 * 说明：真正的音频合成在 03-lh-server 的 /api/v1/voice/tts 完成；
 *      本 MCP 负责「语音策略决策」——决定用什么音色、什么参数、以及端上还是服务端合成。
 */
const readline = require('readline');

const SPEAKERS = [
  { id: 'per_0', name: '度小美', gender: 'female', style: '标准女声，清晰稳重', suitable: ['通用播报', '青年'] },
  { id: 'per_1', name: '度小宇', gender: 'male', style: '标准男声，平稳', suitable: ['通用播报'] },
  { id: 'per_3', name: '度逍遥', gender: 'male', style: '磁性男声', suitable: ['青年', '听书'] },
  { id: 'per_4', name: '度丫丫', gender: 'female', style: '温柔女声，亲和', suitable: ['关怀模式', '老年人'] },
  { id: 'per_5', name: '度小娇', gender: 'female', style: '甜美女声', suitable: ['青年'] },
  { id: 'per_6', name: '度博文', gender: 'male', style: '播报男声', suitable: ['资讯播报'] },
  { id: 'per_7', name: '度小童', gender: 'female', style: '童声', suitable: ['儿童陪伴'] },
  { id: 'per_8', name: '度小萌', gender: 'female', style: '萌系女声', suitable: ['青年', '闲聊'] },
  { id: 'per_5003', name: '度米朵', gender: 'female', style: '情感女声', suitable: ['情感陪伴'] },
];

const DIALECTS = [
  { id: 'putonghua', name: '普通话' },
  { id: 'yue', name: '粤语' },
  { id: 'sichuan', name: '四川话' },
  { id: 'dongbei', name: '东北话' },
  { id: 'henan', name: '河南话' },
  { id: 'shandong', name: '山东话' },
];

const TOOLS = [
  {
    name: 'list_speakers',
    description: '列出可选的 TTS 音色与方言，按适用人群筛选（老年人关怀 / 青年标准）。',
    inputSchema: { type: 'object', properties: { forWhom: { type: 'string', enum: ['elderly', 'youth', 'all'], description: '默认 all' } } },
  },
  {
    name: 'tts_plan',
    description: '生成语音合成策略：给定文本与场景，决定音色、语速、音调、音量，并判断端上还是服务端合成。输出可直接传给 /api/v1/voice/tts。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '待播报文本' },
        scene: { type: 'string', enum: ['navigation', 'search_result', 'emotion', 'alert', 'chat'], description: '播报场景' },
        careMode: { type: 'boolean', description: '关怀模式' },
        lengthPreference: { type: 'string', enum: ['short', 'full'], description: '播报长度偏好' },
      },
      required: ['text'],
    },
  },
  {
    name: 'asr_hint',
    description: '给出端上语音识别的最佳实践配置（采样率、格式、引擎选择），用于 uni-app / 微信小程序侧实现。',
    inputSchema: { type: 'object', properties: { platform: { type: 'string', enum: ['uniapp', 'miniprogram'], description: '默认 uniapp' } } },
  },
];

function listSpeakers({ forWhom = 'all' } = {}) {
  const filter = (s) => forWhom === 'all' || s.suitable.includes(forWhom === 'elderly' ? '老年人' : '青年');
  return {
    forWhom,
    speakers: SPEAKERS.filter(filter),
    dialects: DIALECTS,
    recommend: forWhom === 'elderly' ? { speaker: 'per_4', speed: 0.85, volume: 1.2, reason: '度丫丫音色温柔，降速提音量，老年人听得清' } : { speaker: 'per_0', speed: 1.0, volume: 1.0, reason: '度小美清晰稳重，适合通用播报' },
  };
}

function ttsPlan({ text = '', scene = 'chat', careMode = false, lengthPreference = 'short' } = {}) {
  const profile = careMode
    ? { speaker: 'per_4', speed: 0.85, pitch: 1.0, volume: 1.2 }
    : scene === 'emotion'
    ? { speaker: 'per_5003', speed: 0.92, pitch: 1.0, volume: 1.05 }
    : scene === 'alert'
    ? { speaker: 'per_0', speed: 1.0, pitch: 1.0, volume: 1.3 }
    : { speaker: 'per_0', speed: 1.0, pitch: 1.0, volume: 1.0 };

  // 导航播报必须精简
  let out = String(text);
  if (scene === 'navigation' || lengthPreference === 'short') {
    out = out.split(/[。；\n]/)[0].slice(0, 40);
  }

  return {
    text: out,
    originalLength: String(text).length,
    speakLength: out.length,
    scene,
    careMode,
    options: profile,
    engine: out.length > 120 || scene === 'navigation' ? 'server' : 'client',
    reason:
      scene === 'navigation'
        ? '导航播报需极短句，优先服务端预合成以降低端上 CPU 占用'
        : out.length > 120
        ? '文本较长，服务端合成音质更稳'
        : '短句用端上系统 TTS 更快，无需网络',
    fallback: '若端上无 TTS 引擎，回落到 uni.createInnerAudioContext 播放服务端音频',
  };
}

function asrHint({ platform = 'uniapp' } = {}) {
  if (platform === 'miniprogram') {
    return {
      platform,
      engine: '微信同声传译插件（wx-voice-plugin）或 wx.getRecorderManager + 服务端 ASR',
      format: 'aac / wav',
      sampleRate: 16000,
      channels: 1,
      maxDuration: 60000,
      tips: ['录音前请求 scope.record 授权', '优先使用「按住说话」交互，老年人更易理解', '识别失败时回落到文字输入并放大字号'],
    };
  }
  return {
    platform,
    engine: 'uni.getRecorderManager 采集 + POST /api/v1/voice/asr（百度短语音识别）',
    format: 'wav',
    sampleRate: 16000,
    channels: 1,
    encodeBitRate: 96000,
    maxDuration: 60000,
    tips: ['App 端需配置录音权限', '鸿蒙端使用 @ohos.multimedia.audio 采集后上传', 'iOS 需在 manifest 中声明 NSMicrophoneUsageDescription'],
  };
}

const IMPL = { list_speakers: listSpeakers, tts_plan: ttsPlan, asr_hint: asrHint };
const SERVER_INFO = { name: 'lh-voice', version: '1.0.0' };
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');

readline.createInterface({ input: process.stdin, terminal: false }).on('line', (line) => {
  const s = line.trim();
  if (!s) return;
  let msg;
  try { msg = JSON.parse(s); } catch (_) { return; }
  const { id, method, params } = msg;
  if (method === 'initialize') return send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO } });
  if (method === 'notifications/initialized' || method === 'initialized') return;
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  if (method === 'tools/call') {
    const name = params && params.name;
    const fn = IMPL[name];
    if (!fn) return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `未知工具: ${name}` } });
    try {
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(fn((params && params.arguments) || {})) }] } });
    } catch (e) {
      return send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: e.message }) }] } });
    }
  }
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `未实现的方法: ${method}` } });
});
