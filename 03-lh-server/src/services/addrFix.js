/**
 * 鲤慧 LiHui · 地址补查（用户共创）服务
 *
 * 为什么要有这一层：
 *   百度 place 检索对部分 POI（小区/站台/新店/乡村点位）返回的 address 为空或不准，
 *   端上只能显示「地址未知」——客户实际就在那里，最清楚真实地址。
 *   与其等数据源更新，不如让客户一键补充：提交 → 云端留存 → 之后所有人检索时自动生效。
 *
 * 数据流：
 *   端上 POST /map/addr-fix { uid?, name, lng, lat, address, phone? }
 *     → 落 data/addr-fixes.json（同 POI 同地址去重计票）
 *     → poiSearch 出结果时 applyToItems() 覆盖命中条目的 address
 *     → 「地图上没有的地点」补报（无 uid）后，augment() 会把它注入到关键词命中的检索结果里
 *
 * 审核口径：默认 autoApproved=true 直接生效（鲤慧体量下先跑通闭环）；
 *   若后续出现恶意灌水，把 autoApproved 关掉，改为 approved 后才 apply，管理端走 /addr-fix/list 审核。
 */
const store = require('./store');
const logger = require('../utils/logger');

const col = store.collection('addr-fixes', []);
const AUTO_APPROVED = true;

/** 同一地点 500 米内视为同一 POI（uid 缺失时按名字 + 距离判重） */
const SAME_POI_M = 500;

function haversine(lng1, lat1, lng2, lat2) {
  const R = 6371000;
  const rad = (d) => (Number(d) * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function samePoi(a, b) {
  if (a.uid && b.uid) return a.uid === b.uid;
  if (!a.name || !b.name) return false;
  const nameEq = String(a.name).trim() === String(b.name).trim();
  if (a.lng && a.lat && b.lng && b.lat) return nameEq && haversine(a.lng, a.lat, b.lng, b.lat) <= SAME_POI_M;
  return nameEq;
}

/** 客户提交一条地址补充 */
function submit(p = {}) {
  const name = String(p.name || '').trim().slice(0, 60);
  const address = String(p.address || '').trim().slice(0, 200);
  if (!name) throw Object.assign(new Error('name 必填'), { code: 1001 });
  if (!address) throw Object.assign(new Error('address 必填'), { code: 1001 });

  const rec = {
    id: store.uid('fix'),
    uid: p.uid ? String(p.uid) : '',
    name,
    address,
    lng: Number.isFinite(Number(p.lng)) ? Number(p.lng) : null,
    lat: Number.isFinite(Number(p.lat)) ? Number(p.lat) : null,
    phone: String(p.phone || '').slice(0, 30),
    deviceId: p.deviceId || 'anonymous',
    kind: p.uid ? 'fix' : 'add', // fix=纠正已有 POI 的地址 / add=补充地图上没有的地点
    status: AUTO_APPROVED ? 'approved' : 'pending',
    votes: 1,
    source: 'user',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  // 判重：同地点 + 同地址 → 计一票（同一客户重复提交不重复计）
  const exist = col.all().find((x) => x.status === 'approved' && samePoi(x, rec));
  if (exist) {
    if (exist.address === rec.address) {
      const bumped = col.update(exist.id, {
        votes: (exist.votes || 1) + (exist.deviceId === rec.deviceId ? 0 : 1),
        updatedAt: rec.updatedAt,
      });
      return { ...bumped, merged: true };
    }
    // 同地点不同地址：保留两版，审核时以票数高者为准；apply 时取最新 approved
    return col.add(rec);
  }
  return col.add(rec);
}

/**
 * 把已生效的用户补充覆盖到检索结果上（按 uid 优先、名字+距离兜底匹配）
 * @returns {Array} 新数组（不污染入参），被覆盖的条目带 addressFixedByUser=true
 */
function applyToItems(items = []) {
  if (!Array.isArray(items) || !items.length) return items;
  const approved = col.all().filter((x) => x.status === 'approved' && x.kind === 'fix');
  if (!approved.length) return items;
  return items.map((it) => {
    const hit = approved.find((f) => samePoi(f, it));
    if (!hit) return it;
    return { ...it, address: hit.address, addressFixedByUser: true };
  });
}

/**
 * 把「地图上没有的地点」（kind=add）注入检索结果：
 * 关键词任一分段命中名字 / 标签，且落在检索半径内，追加到末尾并标 userAdded。
 */
function augment(items = [], { query = '', lng, lat, radius = 1200 } = {}) {
  const adds = col.all().filter((x) => x.status === 'approved' && x.kind === 'add');
  if (!adds.length || !Array.isArray(items)) return items || [];
  const words = String(query).split('|').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const out = items.slice();
  for (const a of adds) {
    if (out.some((it) => samePoi(a, it))) continue; // 已在结果里就不重复注入
    if (a.lng == null || a.lat == null || !Number.isFinite(Number(lng))) continue;
    const dist = haversine(Number(lng), Number(lat), a.lng, a.lat);
    if (dist > Math.max(Number(radius) || 1200, 3000)) continue;
    const hay = (a.name + ' ' + (a.tags || []).join(' ')).toLowerCase();
    if (words.length && !words.some((w) => hay.includes(w))) continue;
    out.push({
      uid: a.id,
      name: a.name,
      address: a.address,
      lng: a.lng,
      lat: a.lat,
      distance: Math.round(dist),
      tag: '用户补充',
      type: 'user_added',
      userAdded: true,
      telephone: a.phone || '',
      rating: null,
    });
  }
  return out;
}

/** 管理端：分页列出 */
function list(q = {}) {
  let all = col.all().slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  if (q.status) all = all.filter((x) => x.status === q.status);
  if (q.kind) all = all.filter((x) => x.kind === q.kind);
  const page = Number(q.page) || 1;
  const pageSize = Math.min(Number(q.pageSize) || 20, 50);
  return { total: all.length, page, pageSize, items: all.slice((page - 1) * pageSize, page * pageSize) };
}

/** 审核状态流转（预留：关掉 autoApproved 后启用） */
function setStatus(id, status) {
  if (!['pending', 'approved', 'rejected'].includes(status)) {
    throw Object.assign(new Error('status 非法'), { code: 1001 });
  }
  return col.update(id, { status, updatedAt: new Date().toISOString() });
}

function summary() {
  const all = col.all();
  return {
    total: all.length,
    byStatus: all.reduce((m, x) => ((m[x.status] = (m[x.status] || 0) + 1), m), {}),
    byKind: all.reduce((m, x) => ((m[x.kind] = (m[x.kind] || 0) + 1), m), {}),
    latest: all.slice(-5).reverse().map((x) => ({ id: x.id, name: x.name, address: x.address, kind: x.kind })),
  };
}

module.exports = { submit, applyToItems, augment, list, setStatus, summary };
