// 오프라인 폴백 단위 테스트 — 업스트림 실패 시 48시간 이내 만료 캐시로 응답(모의 fetch, 네트워크 없음).
import { test } from "node:test";
import assert from "node:assert/strict";
import { LruCache } from "../src/cache.js";
import { cached, search } from "../src/upstream.js";
import { cache } from "../src/cache.js";
import { cacheState, mergeCache } from "../src/envelope.js";
import { _setApiKey } from "../src/keys.js";

test("LruCache: 만료 항목은 stale 로 보관되고 getStale 로 돌아온다", () => {
  const c = new LruCache();
  c.set("k", { v: 1 }, 10, 1000);
  assert.equal(c.get("k", 2000), undefined); // 만료 → miss + stale 이동
  const s = c.getStale("k", 3000);
  assert.deepEqual(s.value, { v: 1 });
  assert.ok(s.ageMs >= 0);
  assert.equal(c.stats().staleServes, 1);
});

test("LruCache: 48시간 이내 stale 은 살아 있고, 초과는 버린다", () => {
  const c = new LruCache();
  c.set("k", { v: 1 }, 10, 1000);
  c.get("k", 2000); // 만료 → stale
  assert.ok(c.getStale("k", 3000) !== undefined); // 이내면 살아 있음
  c.set("k2", { v: 2 }, 10, 1000);
  c.get("k2", 2000);
  assert.equal(c.getStale("k2", 1000 + 48 * 3600 * 1000 + 5000), undefined); // 초과 → 버림
});

test("LruCache: 축출(항목 상한)도 stale 재료가 된다", () => {
  const c = new LruCache({ maxEntries: 1 });
  c.set("a", { v: 1 }, 60000, 1000);
  c.set("b", { v: 2 }, 60000, 1000); // a 축출 → stale
  assert.ok(c.getStale("a", 2000).value.v === 1);
});

test("cached(): 업스트림 실패 시 만료 캐시로 폴백 응답, 실패 없으면 원래 오류", async () => {
  const origFetch = globalThis.fetch;
  _setApiKey("k1234567");
  cache.clear();
  let n = 0;
  globalThis.fetch = async () => { n++; return new Response(JSON.stringify({ result: "fail", msg: "auth" }), { status: 200 }); };
  try {
    // 1) 성공 캐시를 심는다(ttl 1ms → 즉시 만료 → 다음 get 에서 stale 이동)
    globalThis.fetch = async () => new Response(JSON.stringify({ LawSearch: { totalCnt: "1" } }), { status: 200 });
    const ok = await cached("lawSearch.do", { target: "eflaw", query: "s1" }, 1);
    assert.equal(ok.data.LawSearch.totalCnt, "1");
    await new Promise((r) => setTimeout(r, 5));
    // 2) 업스트림 인증 실패 — 같은 키의 stale 로 폴백
    globalThis.fetch = async () => new Response(JSON.stringify({ result: "fail", msg: "auth" }), { status: 200 });
    const again = await cached("lawSearch.do", { target: "eflaw", query: "s1" }, 1);
    assert.equal(again.data.LawSearch.totalCnt, "1");
    assert.equal(again.stale, true);
    assert.ok(cache.stats().staleServes >= 1);
    // 3) stale 없는 다른 키 — 원래 오류(UPSTREAM_AUTH)
    await assert.rejects(() => cached("lawSearch.do", { target: "eflaw", query: "no-stale" }, 60000), (e) => e.code === "UPSTREAM_AUTH");
  } finally { globalThis.fetch = origFetch; _setApiKey(""); cache.clear(); }
});

test("search()/cacheState: 폴백 응답은 봉투에서 'stale' 로 보인다 (miss 로 삼키지 않는다)", async () => {
  const origFetch = globalThis.fetch;
  _setApiKey("k1234567");
  cache.clear();
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ LawSearch: { totalCnt: "1", rows: [] } }), { status: 200 });
    await search("lawSearch.do", { target: "eflaw", query: "s1" }, { ttl: 1, rowKeys: ["LawSearch"] });
    await new Promise((r) => setTimeout(r, 5));
    globalThis.fetch = async () => new Response(JSON.stringify({ result: "fail", msg: "auth" }), { status: 200 });
    const r = await search("lawSearch.do", { target: "eflaw", query: "s1" }, { ttl: 1, rowKeys: ["LawSearch"] });
    assert.equal(r.stale, true);
    assert.equal(cacheState(r), "stale");
    assert.equal(mergeCache([cacheState(r), "hit"]), "stale");
  } finally { globalThis.fetch = origFetch; _setApiKey(""); cache.clear(); }
});
