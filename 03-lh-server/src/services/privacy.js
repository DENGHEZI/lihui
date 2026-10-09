/**
 * 鲤慧 LiHui · 隐私合规（零依赖）
 *
 * 背景：用户画像会采集搜索/对话主题/点店/导航行为，位置与设备 ID 属个人信息。
 * 本模块补齐三件事：
 *   1) 隐私政策（版本化）——GET /privacy/policy 下发，静态页 /privacy 展示全文
 *   2) 用户同意机制 —— POST /privacy/consent 落库（版本+时间）；
 *      userProfile.track 前置同意校验（未同意不采集；LH_PRIVACY_REQUIRE_CONSENT=false 可关）
 *   3) 个人权利 —— GET /privacy/export 导出本人数据；POST /privacy/delete 删除/匿名化本人数据
 *
 * 注意：本模块不 require userProfile（userProfile 反向依赖本模块做门控，避免循环）；
 * 导出/删除直接走统一存储层读 profiles 文档。
 */
const store = require('./store');
const logger = require('../utils/logger');

const PRIVACY_VERSION = '2026-10-09';
const POLICY = {
  version: PRIVACY_VERSION,
  effectiveAt: '2026-10-09',
  contact: 'privacy@lihui-tech.online',
  summary:
    '鲤慧在你同意后才会记录用于「个性化推荐」的行为数据（搜过什么、聊过什么话题、点过哪些店、发起过导航）；' +
    '未同意时这些功能照常可用，只是不做个性化。你可随时导出或删除你的全部数据。',
  collected: [
    { item: '设备标识（Device ID）', purpose: '在同一设备上记住你的偏好与同意状态', required: true, note: '由端上随机生成并本地持久化，不含姓名/手机号等身份信息' },
    { item: '位置信息（经纬度）', purpose: '周边搜索、路线规划、15 分钟生活圈体检', required: true, note: '仅用于当次请求的计算，不落库、不形成轨迹历史' },
    { item: '搜索关键词与对话主题类目', purpose: '个性化排序与回复（同意后）', required: false, note: '只存离散关键词与类目计数，带时间衰减自动遗忘（约 30 天半衰期）' },
    { item: '点店 / 导航行为（POI 名称与坐标）', purpose: '「常去地点」加权推荐（同意后）', required: false, note: '最多保留 30 条，随时间衰减自动清理' },
  ],
  notCollected: ['姓名、手机号、身份证等实名信息（未登录时）', '精确轨迹 / 历史位置序列', '通讯录、相册、剪贴板'],
  storage: '行为画像存于服务端数据目录（profiles），可随时导出或彻底删除；对话会话默认保留最近 40 条用于上下文。',
  rights: [
    '拒绝/撤回同意：关闭端上「个性化推荐」或调用删除接口，画像立即停采并清空',
    '数据导出：GET /api/v1/privacy/export?deviceId=<你的设备ID>',
    '数据删除：POST /api/v1/privacy/delete { "deviceId": "<你的设备ID>" }',
  ],
};

const consentCol = store.collection('consents', []);

function requireConsent() {
  return process.env.LH_PRIVACY_REQUIRE_CONSENT !== 'false';
}

/** 记录同意（幂等，更新为最新版本） */
function setConsent(deviceId, version = PRIVACY_VERSION) {
  if (!deviceId || deviceId === 'anonymous') return null;
  const exist = consentCol.find((x) => x.deviceId === deviceId);
  if (exist) {
    return consentCol.update(exist.id, { version, at: Date.now(), withdrawn: false, withdrawnAt: null });
  }
  return consentCol.add({ id: store.uid('pc'), deviceId: String(deviceId).slice(0, 64), version, at: Date.now(), withdrawn: false, withdrawnAt: null });
}

function getConsent(deviceId) {
  if (!deviceId) return null;
  return consentCol.find((x) => x.deviceId === deviceId && !x.withdrawn) || null;
}

/** 画像采集门控：需要同意且已同意 → true */
function hasConsent(deviceId) {
  if (!requireConsent()) return true; // 部署方显式关闭同意门控（如纯内网演示）
  return !!getConsent(deviceId);
}

/** 撤回同意：停采 + 立即清空画像 */
function withdraw(deviceId) {
  const c = consentCol.find((x) => x.deviceId === deviceId && !x.withdrawn);
  if (c) consentCol.update(c.id, { withdrawn: true, withdrawnAt: Date.now() });
  deleteData(deviceId);
  return { withdrawn: true };
}

/** 数据导出（数据可携权）：画像 + 同意记录 + Token 用量 */
function exportData(deviceId) {
  const profiles = store.read('profiles', {}) || {};
  const tokens = store.collection('tokens', []).all().filter((x) => x.deviceId === deviceId).slice(-200);
  return {
    deviceId,
    exportedAt: new Date().toISOString(),
    policyVersion: PRIVACY_VERSION,
    profile: profiles[deviceId] || null,
    consent: getConsent(deviceId),
    tokenUsage: tokens,
  };
}

/** 数据删除（被遗忘权）：画像 / 同意记录 / Token 记录中属于该设备的数据全部清除 */
function deleteData(deviceId) {
  if (!deviceId) return { deleted: 0 };
  let deleted = 0;
  const profiles = store.read('profiles', {}) || {};
  if (profiles[deviceId]) {
    delete profiles[deviceId];
    store.write('profiles', profiles);
    deleted++;
  }
  for (const c of consentCol.all().filter((x) => x.deviceId === deviceId)) {
    consentCol.remove(c.id);
    deleted++;
  }
  const tokens = store.collection('tokens', []);
  for (const t of tokens.all().filter((x) => x.deviceId === deviceId)) {
    tokens.remove(t.id);
    deleted++;
  }
  logger.info('privacy', `已删除设备 ${String(deviceId).slice(0, 8)}*** 的 ${deleted} 项数据`);
  return { deleted };
}

module.exports = { PRIVACY_VERSION, POLICY, requireConsent, setConsent, getConsent, hasConsent, withdraw, exportData, deleteData };
