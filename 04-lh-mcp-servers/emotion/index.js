#!/usr/bin/env node
/**
 * 鲤慧 LiHui · MCP Server: emotion
 * 用户情感疏通 —— 情绪识别 + 共情陪伴 + 生活化建议（老年人与青年人均适用）
 * 工具：soothe / detect_mood
 */
const readline = require('readline');

const MOODS = [
  { key: 'lonely', name: '孤独', re: /孤独|一个人|没人|寂寞|没人说话/, care: '一个人的时候确实容易闷。要不要我陪您到楼下公园走一圈？我把路线念给您听。' },
  { key: 'anxious', name: '焦虑', re: /焦虑|紧张|心慌|睡不着|失眠|担心/, care: '先别急，慢慢呼吸三次。我们把事情拆小：今天只需处理一件最小的事，我陪您一起。' },
  { key: 'angry', name: '生气', re: /生气|气死|烦死|讨厌|火大|气人/, care: '这事确实让人上火。要不先放一放，去走 10 分钟散散心，回来再决定怎么处理。' },
  { key: 'sad', name: '低落', re: /难过|伤心|哭|低落|没意思|抑郁|不想活/, care: '我听见了，您现在很不好受。您愿意跟我说说发生了什么吗？我一直在。' },
  { key: 'tired', name: '疲惫', re: /累|疲惫|扛不住|没力气|撑不住/, care: '辛苦了。今天就别硬撑了，先吃点热乎的，早点休息，明天的事明天再说。' },
  { key: 'happy', name: '愉悦', re: /开心|高兴|太好了|不错|顺利|棒/, care: '真好！这份好心情值得记录下来，您愿意说说是哪件事让您这么开心吗？' },
];

const RISK = /不想活|活不下去|自杀|结束生命|跳楼|吃药自尽/;

const TOOLS = [
  {
    name: 'soothe',
    description: '情感疏通：识别用户情绪，给出共情回应与生活化的小行动建议；高风险情绪自动提示转介热线。',
    inputSchema: { type: 'object', properties: { text: { type: 'string', description: '用户原话' }, mood: { type: 'string', description: '可选，已知情绪' }, careMode: { type: 'boolean', description: '关怀模式（说话更慢更短）' } }, required: ['text'] },
  },
  {
    name: 'detect_mood',
    description: '仅做情绪识别，返回情绪标签、强度与置信度，不生成回应。',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
];

function detectMood(text) {
  const s = String(text || '');
  const hits = MOODS.filter((m) => m.re.test(s));
  const exclam = (s.match(/[!！]/g) || []).length;
  const intensity = Math.min(5, 1 + hits.length + Math.min(2, Math.floor(exclam / 2)));
  return {
    moods: hits.map((h) => ({ key: h.key, name: h.name })),
    primary: hits[0] ? hits[0].key : 'neutral',
    primaryName: hits[0] ? hits[0].name : '平静',
    intensity,
    confidence: hits.length ? Number(Math.min(0.95, 0.6 + hits.length * 0.12).toFixed(2)) : 0.4,
    risk: RISK.test(s),
  };
}

function soothe({ text, mood, careMode = false }) {
  const d = detectMood(text);
  const hit = MOODS.find((m) => m.key === (mood || d.primary));

  if (d.risk) {
    return {
      ...d,
      reply: '我很担心您。请现在联系信任的家人，或拨打全国心理援助热线 12356（24 小时）、北京心理危机干预热线 010-82951332。\n我一直在，先跟我说一句「我在」好吗？',
      urgent: true,
      hotlines: ['全国心理援助热线 12356', '北京心理危机干预中心 010-82951332', '希望 24 热线 400-161-9995'],
      actions: [{ type: 'call', label: '一键拨打心理援助热线', tel: '12356' }],
    };
  }

  const base = (hit && hit.care) || '我在听。您慢慢说，不着急。';
  const reply = careMode ? base.replace(/。/g, '。\n') : base;

  const micro = [
    { key: 'walk', label: '出门走 10 分钟', hint: '附近的公园我已帮您标好，需要就说「带我去」' },
    { key: 'water', label: '喝一杯温水', hint: '简单但真的有用' },
    { key: 'call', label: '给家人发一条消息', hint: '一句「我今天挺好的」就够了' },
    { key: 'music', label: '听一首熟悉的老歌', hint: '熟悉的声音最能安神' },
  ];

  return {
    ...d,
    reply,
    microActions: micro,
    followUp: careMode ? '要不要我每隔两小时陪您聊两句？' : '要不要我陪您聊一会儿，或者帮您找点事做？',
    tone: careMode ? 'slow-short' : 'normal',
  };
}

const IMPL = {
  soothe,
  detect_mood: ({ text }) => detectMood(text),
};

const SERVER_INFO = { name: 'lh-emotion', version: '1.0.0' };
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
