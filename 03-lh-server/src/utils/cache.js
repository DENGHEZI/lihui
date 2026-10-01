/**
 * 鲤慧 LiHui · 内存缓存（带 TTL + LRU 上限）
 */
class Cache {
  constructor(max = 500) {
    this.max = max;
    this.map = new Map();
  }
  get(key) {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expire && hit.expire < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    // LRU: 命中后移到末尾
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }
  set(key, value, ttl = 60000) {
    if (this.map.size >= this.max) {
      const firstKey = this.map.keys().next().value;
      this.map.delete(firstKey);
    }
    this.map.set(key, { value, expire: ttl > 0 ? Date.now() + ttl : 0 });
    return value;
  }
  del(key) {
    this.map.delete(key);
  }
  clear() {
    this.map.clear();
  }
  get size() {
    return this.map.size;
  }
}

module.exports = { Cache, cache: new Cache() };
