// 메모리 LRU — 항목 수 상한 2,000 및 바이트 상한 64MB(둘 중 먼저). TTL 은 항목마다(SPEC §6.3).
// 키에 인증값을 넣지 않는다(호출자 책임 + set 에서 검사).
// 만료·축출 항목은 stale 보관소에 옮겨 둔다 — 업스트림 장애 시 오프라인 폴백 응답용(상한 48시간, 2026-11-22).
import { apiKey } from "./keys.js";

const STALE_MAX_MS = 48 * 3600 * 1000;
const STALE_MAX_ENTRIES = 500;

export class LruCache {
  constructor({ maxEntries = 2000, maxBytes = 64 * 1024 * 1024 } = {}) {
    this.maxEntries = maxEntries; this.maxBytes = maxBytes;
    this.map = new Map(); this.bytes = 0; this.hits = 0; this.misses = 0;
    this.stale = new Map(); this.staleServes = 0;
  }
  get(key, now = Date.now()) {
    const e = this.map.get(key);
    if (!e) { this.misses++; return undefined; }
    if (e.exp <= now) { this.map.delete(key); this.bytes -= e.size; this.misses++; this._toStale(key, e, now); return undefined; }
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
    if (old) {
      this.map.delete(key); this.bytes -= old.size;
      if (old.exp <= now) this._toStale(key, old, now); // 만료된 이전 값은 stale 로
    }
    this.map.set(key, { value, exp: now + ttlMs, size });
    this.bytes += size;
    while (this.map.size > this.maxEntries || this.bytes > this.maxBytes) {
      const first = this.map.keys().next().value;
      const e = this.map.get(first); this.map.delete(first); this.bytes -= e.size;
      this._toStale(first, e, now); // 축출도 stale 로(오프라인 폴백 재료) — 축출된 키 기준
    }
    return true;
  }
  _toStale(key, e, now) {
    if (!e) return;
    this.stale.set(key, { value: e.value, exp: e.exp });
    while (this.stale.size > STALE_MAX_ENTRIES) this.stale.delete(this.stale.keys().next().value);
  }
  /** 만료된 이전 값(48시간 이내) — 업스트림 장애 시 오프라인 폴백용. 없거나 너무 오래됐으면 undefined. */
  getStale(key, now = Date.now()) {
    const e = this.stale.get(key);
    if (!e) return undefined;
    const ageMs = Math.max(0, now - e.exp);
    if (ageMs > STALE_MAX_MS) { this.stale.delete(key); return undefined; }
    this.stale.delete(key); this.stale.set(key, e); // LRU 갱신
    this.staleServes++;
    return { value: e.value, ageMs };
  }
  delete(key) { const e = this.map.get(key); if (e) { this.map.delete(key); this.bytes -= e.size; } }
  clear() { this.map.clear(); this.bytes = 0; this.stale.clear(); }
  stats() { return { entries: this.map.size, bytes: this.bytes, hits: this.hits, misses: this.misses, stale: this.stale.size, staleServes: this.staleServes }; }
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
