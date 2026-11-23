// Workers cron 사전 갱신(refreshDictionaryStep) — 쪽 나눠 받기·이어받기·완성본 쓰기·신선하면 건너뛰기. 모의 업스트림, 네트워크 없음.
import { test } from "node:test";
import assert from "node:assert/strict";

const { _setApiKey } = await import("../src/keys.js");
const { _test: drfTest } = await import("../src/drf.js");
const { cache } = await import("../src/cache.js");
const { refreshDictionaryStep, useRemoteStore, dictionary } = await import("../src/dictionary.js");

const TOTAL = 250; // 100건씩 3쪽
const page = (n) => {
  const rows = [];
  for (let i = (n - 1) * 100; i < Math.min(TOTAL, n * 100); i++) rows.push({ 법령명한글: `법${i}`, 법령ID: String(i).padStart(6, "0"), 법령일련번호: String(1000 + i), 법령구분명: "법률", 시행일자: "20260101" });
  return { LawSearch: { totalCnt: String(TOTAL), page: String(n), law: rows } };
};

test("사전 갱신: 회차마다 pages 쪽씩 · 진행분 저장 · 다 받으면 완성본 쓰고 진행분 지움 · 신선하면 건너뜀", async () => {
  _setApiKey("FAKEKEY123456"); drfTest.reset(); cache.clear();
  const calls = []; const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(url); calls.push(u.searchParams.get("target") + ":" + (u.searchParams.get("page") || ""));
    const body = u.searchParams.get("target") === "lsAbrv" ? { LsAbrvSearch: { law: [{ 법령약칭명: "약1", 법령명한글: "법1", 법령ID: "000001", 현행연혁코드: "현행" }] } } : page(+u.searchParams.get("page"));
    return new Response(JSON.stringify(body), { status: 200 });
  };
  let saved = null; let prog = null;
  useRemoteStore({ get: async () => saved, put: async (d) => { saved = d; } });
  const progress = { get: async () => prog, put: async (p) => { prog = p; } };
  try {
    const r1 = await refreshDictionaryStep(progress, { pages: 2 });
    assert.deepEqual(r1, { done: false, next: 3, entries: 200 });
    assert.equal(saved, null, "1회차엔 완성본을 쓰지 않는다");
    assert.equal(prog.next, 3); assert.equal(prog.entries.length, 200);
    assert.deepEqual(calls, ["eflaw:1", "eflaw:2"]);
    const r2 = await refreshDictionaryStep(progress, { pages: 2 });
    assert.equal(r2.done, true); assert.equal(r2.entries, 250); assert.equal(r2.abbreviations, 1);
    assert.equal(prog, null, "끝나면 진행분 삭제");
    assert.equal(saved.entries.length, 250); assert.equal(dictionary().entries.length, 250);
    const n = calls.length;
    const r3 = await refreshDictionaryStep(progress, { pages: 2 });
    assert.equal(r3.skipped, true); assert.equal(calls.length, n, "신선하면 업스트림 0회");
  } finally { globalThis.fetch = orig; useRemoteStore(null); _setApiKey(""); }
});
