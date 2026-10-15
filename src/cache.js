// 메모리 LRU — 항목 수 상한 2,000 및 바이트 상한 64MB(둘 중 먼저). TTL 은 항목마다(SPEC §6.3).
// 키에 인증값을 넣지 않는다(호출자 책임 + set 에서 검사).
import { apiKey } from "./keys.js";

export class LruCache {
  constructor({ maxEntries = 2000, maxBytes = 64 * 1024 * 1024 } = {}) {
    this.maxEntries = maxEntries; this.maxBytes = maxBytes;
    this.map = new Map(); this.bytes = 0; this.hits = 0; this.misses = 0;
  }
  get(key, now = Date.now()) {
    const e = this.map.get(key);
    if (!e) { this.misses++; return undefined; }
    if (e.exp <= now) { this.map.delete(key); this.bytes -= e.size; this.misses++; return undefined; }
    this.map.delete(key); this.map.set(key, e); // LRU 갱신
    this.hits++;
    return e.value;
  }
  has(key, now = Date.now()) { return this.get(key, now) !== undefined; }
  set(key, value, ttlMs, now = Date.now()) {
    const k = apiKey();
    if (k && k.length >= 4 && key.includes(k)) throw new Error("cache key contains credential");
    const size = estimateSize(value) + key.length * 2;
    if (size > this.maxBytes) return false;
    const old = this.map.get(key);
    if (old) { this.map.delete(key); this.bytes -= old.size; }
    this.map.set(key, { value, exp: now + ttlMs, size });
    this.bytes += size;
    while (this.map.size > this.maxEntries || this.bytes > this.maxBytes) {
      const first = this.map.keys().next().value;
      const e = this.map.get(first); this.map.delete(first); this.bytes -= e.size;
    }
    return true;
  }
  delete(key) { const e = this.map.get(key); if (e) { this.map.delete(key); this.bytes -= e.size; } }
  clear() { this.map.clear(); this.bytes = 0; }
  stats() { return { entries: this.map.size, bytes: this.bytes, hits: this.hits, misses: this.misses }; }
}

function estimateSize(v) {
  if (typeof v === "string") return v.length * 2;
  try { return JSON.stringify(v).length * 2; } catch { return 1024; }
}

export const TTL = {
  body: 7 * 24 * 3600 * 1000,       // 판 본문(MST 지정)
  resolve: 6 * 3600 * 1000,         // 이름 해석(+KST 자정)
  dictionary: 24 * 3600 * 1000,     // 법령명 사전·약칭
  list: 10 * 60 * 1000,             // 목록 검색
  sourceBody: 7 * 24 * 3600 * 1000, // 판례·해석례 본문
  incoming: 3600 * 1000,            // 인용 관계
  negative: 5 * 60 * 1000,          // 없음 판정
};

export const cache = new LruCache();
