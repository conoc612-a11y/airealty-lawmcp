// 조문 번호 색인·체계도 디스크 캐시·예열 — 모의 업스트림, 네트워크 없음. 임시 LAWMCP_CACHE_DIR 로 격리.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "lawmcp-test-"));
process.env.LAWMCP_CACHE_DIR = tmp;
process.env.LAWMCP_PREWARM = "1";

const { _setApiKey } = await import("../src/keys.js");
const { _test: drfTest } = await import("../src/drf.js");
const { cache } = await import("../src/cache.js");
const { _setDictionary } = await import("../src/dictionary.js");
const { buildIndex, getArticleIndex, lookup, rangeOf, nearestFromIndex, hasFreshIndex, INDEX_TTL, _test: ixTest } = await import("../src/article_index.js");
const { readDisk, writeDisk } = await import("../src/diskcache.js");
const { readHierarchy, writeHierarchy, hasFreshHierarchy, HIERARCHY_TTL } = await import("../src/hierarchy_cache.js");
const { startPrewarm, prewarmState, _test: pwTest } = await import("../src/prewarm.js");

const fx = (n) => JSON.parse(readFileSync(join(here, "fixtures", n), "utf8"));
const FULL = fx("eflaw_body_id_full.json");
const JO15 = fx("eflaw_body_id_jo15.json");
const VERS = fx("eflaw_versions_jutaek.json");
const STMD = fx("lsStmd_jutaek.json");
const EMPTY_JO = { 법령: { 기본정보: FULL.법령.기본정보, 조문: { 조문단위: [] } } };
const FAKE = "k1234567";
const KEY = "001809_289171_20260908";

before(() => { _setApiKey(FAKE); drfTest.reset(); cache.clear(); ixTest.clear(); _setDictionary({ entries: [{ n: "주택법", k: "법률", i: "001809", m: "289171", e: "2026-09-08" }], abbreviations: [], loadedAt: Date.now() }); });
after(() => { _setApiKey(""); rmSync(tmp, { recursive: true, force: true }); });

/** 모의 업스트림: 요청 URL 을 기록하고 target·파라미터로 응답을 고른다. */
function mockFetch(seen, { stmdDelayMs = 0 } = {}) {
  return async (u) => {
    const url = String(u); seen.push(url);
    const q = new URL(url).searchParams;
    let body;
    if (q.get("target") === "lsStmd") { if (stmdDelayMs) await new Promise((r) => setTimeout(r, stmdDelayMs)); body = STMD; }
    else if (q.get("target") === "lsRlt") body = { lsRltService: { 법령: [{ 관련법령: [{ 관련법령명: "주택법 시행령", 관련법령ID: "009999", 법령간관계: "하위법", 법령간관계코드: "2" }] }] } };
    else if (q.get("LID")) body = VERS;
    else if (q.get("JO")) body = q.get("JO") === "001500" ? JO15 : EMPTY_JO;
    else body = FULL; // 전체 본문
    return new Response(JSON.stringify(body), { status: 200 });
  };
}
const fullBodyCalls = (seen) => seen.filter((u) => /target=eflaw(&|$)/.test(u) && !/JO=/.test(u) && !/LID=/.test(u)).length;

test("색인: 전체 본문 → 조·가지·삭제·마지막 조, 조회·범위·가까운 조문", () => {
  const ix = buildIndex(FULL, { lawId: "001809", mst: "289171", efYd: "20260908" });
  assert.ok(ix.count > 50 && ix.last >= 100, `count ${ix.count} last ${ix.last}`);
  assert.deepEqual(lookup(ix, { article: 15, branch: 0 }), { article: 15, branch: 0, deleted: false });
  assert.equal(lookup(ix, { article: 999, branch: 0 }), null);
  assert.match(rangeOf(ix).validRange, /^제1조~제\d+조$/);
  assert.ok(ix.articles.some((x) => x[1] > 0), "가지번호 조문 있음");
  const near = nearestFromIndex(ix, { article: 15, branch: 0 }); assert.equal(near[0], "제15조"); assert.equal(near.length, 3);
  assert.ok(!JSON.stringify(ix).includes(FAKE));
});

test("디스크 캐시: 원자적 쓰기·읽기·나이, 인증값 포함 시 거부, 깨진 파일 null", () => {
  assert.equal(writeDisk("t", "a b/c", { x: 1 }, 1000), true);
  const d = readDisk("t", "a b/c", 5000); assert.deepEqual(d.value, { x: 1 }); assert.equal(d.ageMs, 4000);
  assert.equal(writeDisk("t", "bad", { s: `OC=${FAKE}` }), false);
  assert.equal(readDisk("t", "none"), null);
  assert.ok(!readdirSync(join(tmp, "t")).some((f) => f.endsWith(".tmp")));
});

test("색인 얻기: 없으면 한 번 만들고 디스크에 저장 → 다음은 디스크/메모리(업스트림 0회), 만료 뒤엔 옛 것 먼저 + 뒤에서 갱신", async () => {
  const seen = []; const orig = globalThis.fetch; globalThis.fetch = mockFetch(seen);
  try {
    const access = { lawId: "001809", useId: true }, ver = { mst: "289171", efYd: "20260908" };
    const a = await getArticleIndex(access, ver); assert.equal(a.source, "built"); assert.equal(fullBodyCalls(seen), 1);
    assert.ok(existsSync(join(tmp, "article_index", `${KEY}.json`)));
    const b = await getArticleIndex(access, ver); assert.equal(b.source, "mem"); assert.equal(fullBodyCalls(seen), 1);
    ixTest.clear(); const c = await getArticleIndex(access, ver); assert.equal(c.source, "disk"); assert.equal(fullBodyCalls(seen), 1);
    assert.equal(hasFreshIndex(access, ver), true);
    // 만료: 디스크 파일을 옛날 것으로 바꾼다 → stale 반환 + 백그라운드 재생성
    ixTest.clear(); writeDisk("article_index", KEY, c.index, Date.now() - INDEX_TTL - 1000);
    assert.equal(hasFreshIndex(access, ver), false);
    const d = await getArticleIndex(access, ver); assert.equal(d.source, "stale"); assert.ok(d.index.count > 0);
    for (let i = 0; i < 50 && fullBodyCalls(seen) < 2; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(fullBodyCalls(seen), 2, "뒤에서 한 번 다시 받음");
    for (let i = 0; i < 50 && !hasFreshIndex(access, ver); i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(hasFreshIndex(access, ver), true);
  } finally { globalThis.fetch = orig; }
});

test("citation_audit: VERIFIED 는 ID+JO 1회뿐, ARTICLE_NOT_FOUND 는 색인(디스크)로 범위 — 전체 본문 0회", async () => {
  const seen = []; const orig = globalThis.fetch; globalThis.fetch = mockFetch(seen);
  cache.clear(); ixTest.clear();
  try {
    const { default: citation_audit } = await import("../src/tools/citation_audit.js");
    const r = await citation_audit.invoke({ citations: [{ law: "주택법", article: "제15조" }, { law: "주택법", article: "제999조" }], checkContent: false });
    assert.equal(r.ok, true);
    assert.equal(r.items[0].status, "VERIFIED"); assert.equal(r.items[0].actual.title, "사업계획의 승인");
    assert.equal(r.items[1].status, "ARTICLE_NOT_FOUND"); assert.match(r.items[1].validRange, /^제1조~제\d+조$/);
    assert.equal(fullBodyCalls(seen), 0, "색인이 디스크에 있으면 전체 본문을 받지 않는다");
    assert.equal(seen.filter((u) => /JO=/.test(u)).length, 2);
    assert.equal(seen.filter((u) => /LID=/.test(u)).length, 0, "오늘 기준이면 판 목록도 없음");
  } finally { globalThis.fetch = orig; }
});

test("article_get: 없는 조문의 validRange·nearest 는 색인에서(전체 본문 0회)", async () => {
  const seen = []; const orig = globalThis.fetch; globalThis.fetch = mockFetch(seen);
  cache.clear(); ixTest.clear();
  try {
    const { default: article_get } = await import("../src/tools/article_get.js");
    const r = await article_get.invoke({ name: "주택법", articles: ["제999조"] });
    assert.equal(r.ok, false); assert.equal(r.error.code, "ARTICLE_NOT_FOUND");
    assert.match(r.error.data?.validRange || r.error.validRange || "", /^제1조~제\d+조$/);
    assert.equal(fullBodyCalls(seen), 0);
  } finally { globalThis.fetch = orig; }
});

test("체계도 디스크 캐시: 첫 호출은 예산 안 응답 + 늦게 온 체계도 저장, 두 번째(새 메모리)는 업스트림 lsStmd 0회, 만료는 옛 값 + 뒤 갱신", async () => {
  const seen = []; const orig = globalThis.fetch; globalThis.fetch = mockFetch(seen, { stmdDelayMs: 400 });
  cache.clear(); const origBudget = process.env.LAWMCP_HIERARCHY_BUDGET_MS; process.env.LAWMCP_HIERARCHY_BUDGET_MS = "100";
  try {
    const { default: statute_outline } = await import("../src/tools/statute_outline.js");
    const ident = { lawId: "001809", mst: "289171" };
    await statute_outline.invoke({ name: "주택법", view: "toc" }); // 모듈 로드·이름 해석 워밍(측정 밖)
    seen.length = 0; drfTest.reset(); // 토큰 버킷 재충전(앞 테스트들이 소비) — 측정은 모의 지연만
    const t0 = Date.now(); const a = await statute_outline.invoke({ name: "주택법", view: "hierarchy" });
    assert.equal(a.ok, true); assert.ok(Date.now() - t0 < 350, "예산 안에 응답"); assert.equal(a.items[0].adminRules.total, null);
    assert.ok(a.items[0].lower.decree.some((d) => d.name === "주택법 시행령"), "관련법령으로 하위법 채움");
    for (let i = 0; i < 100 && !hasFreshHierarchy(ident); i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(hasFreshHierarchy(ident), true, "늦게 온 체계도가 디스크에 저장됨");
    const stmdBefore = seen.filter((u) => /lsStmd/.test(u)).length; assert.equal(stmdBefore, 1);
    cache.clear();
    const b = await statute_outline.invoke({ name: "주택법", view: "hierarchy" });
    assert.equal(b.ok, true); assert.equal(b.items[0].law.name, "주택법"); assert.notEqual(b.items[0].adminRules.total, null);
    assert.equal(seen.filter((u) => /lsStmd|lsRlt/.test(u)).length, 2, "디스크 적중: 체계도·관련법령 호출 없음");
    assert.ok(!b.notes.some((n) => /준비되지/.test(n)));
    // 만료 → 옛 값 즉시 + 백그라운드 갱신
    const h = readHierarchy(ident); writeHierarchy(ident, { tree: h.tree, related: h.related }, Date.now() - HIERARCHY_TTL - 1000);
    cache.clear();
    const c = await statute_outline.invoke({ name: "주택법", view: "hierarchy" });
    assert.equal(c.ok, true); assert.ok(c.notes.some((n) => /갱신 중/.test(n)));
    for (let i = 0; i < 100 && !hasFreshHierarchy(ident); i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(hasFreshHierarchy(ident), true);
    assert.equal(seen.filter((u) => /lsStmd/.test(u)).length, 2);
  } finally { globalThis.fetch = orig; if (origBudget == null) delete process.env.LAWMCP_HIERARCHY_BUDGET_MS; else process.env.LAWMCP_HIERARCHY_BUDGET_MS = origBudget; }
});

test("예열: 끄면 disabled·네트워크 0, 켜면 색인·체계도를 채우고 신선하면 건너뜀, 전경 요청 중엔 양보", async () => {
  const seen = []; const orig = globalThis.fetch; globalThis.fetch = mockFetch(seen);
  cache.clear(); ixTest.clear(); pwTest.reset(); drfTest.reset();
  try {
    process.env.LAWMCP_PREWARM = "0"; await startPrewarm({ laws: ["주택법"] }); assert.equal(prewarmState.state, "disabled"); assert.equal(seen.length, 0);
    process.env.LAWMCP_PREWARM = "1"; pwTest.reset();
    rmSync(join(tmp, "article_index"), { recursive: true, force: true }); rmSync(join(tmp, "hierarchy"), { recursive: true, force: true });
    const { summarizeTree } = await import("../src/tools/statute_outline.js");
    const st = await startPrewarm({ laws: ["주택법"], summarize: summarizeTree });
    assert.equal(st.state, "done"); assert.equal(st.index.built, 1, JSON.stringify(st)); assert.equal(st.hierarchy.built, 1, JSON.stringify(st)); assert.equal(st.done, 2);
    assert.ok(existsSync(join(tmp, "article_index", `${KEY}.json`)) && existsSync(join(tmp, "hierarchy", "001809_289171.json")));
    const n1 = seen.length;
    pwTest.reset(); const st2 = await startPrewarm({ laws: ["주택법"], summarize: summarizeTree });
    assert.equal(st2.index.skipped, 1); assert.equal(st2.hierarchy.skipped, 1); assert.equal(seen.length, n1, "신선하면 업스트림 0회");
    // 양보: 전경 요청이 걸려 있는 동안 백그라운드 호출은 나가지 않는다
    let release; const gate = new Promise((r) => (release = r));
    globalThis.fetch = async (u) => { const url = String(u); seen.push(url); if (/query=slow/.test(url)) { await gate; return new Response(JSON.stringify({ LawSearch: { totalCnt: "0" } }), { status: 200 }); } return mockFetch([])(u); };
    const { call } = await import("../src/drf.js");
    const fg = call("lawSearch.do", { target: "eflaw", query: "slow" });
    const bgSeen = () => seen.filter((u) => /target=lsRlt/.test(u)).length; const before = bgSeen();
    const bg = call("lawSearch.do", { target: "lsRlt", ID: "001809" }, { background: true });
    await new Promise((r) => setTimeout(r, 250)); assert.equal(bgSeen(), before, "전경 진행 중엔 백그라운드가 안 나감");
    release(); await fg; await bg; assert.equal(bgSeen(), before + 1);
  } finally { globalThis.fetch = orig; drfTest.reset(); }
});
