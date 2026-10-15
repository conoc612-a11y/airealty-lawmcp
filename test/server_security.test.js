// 전송(§7.2 수용), 보안(§8 가짜 키 누출 0), toolbox, tools/list 크기, 이름 교집합, cold start, 캐시 적중 p50, 레이트리밋.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHttpServer } from "../src/http-server.js";
import { CORE_TOOLS, CATALOG_TOOLS, TOOL_LIST, TOOL_LIST_BYTES, callTool } from "../src/registry.js";
import toolbox from "../src/tools/toolbox.js";
import { _setApiKey } from "../src/keys.js";
import { cache } from "../src/cache.js";
import { _test as drfTest, settings } from "../src/drf.js";
import { _setDictionary } from "../src/dictionary.js";

const FAKE = "FAKEKEYMARKER7x9q";
const here = dirname(fileURLToPath(import.meta.url));
let server, port;
before(async () => { server = createHttpServer(); await new Promise((r) => server.listen(0, "127.0.0.1", r)); port = server.address().port; });
after(() => server.close());

const post = (body, headers = {}) => fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
const rpc = (method, params, id = 1) => post({ jsonrpc: "2.0", id, method, params });

test("HTTP: POST 20회 연속 + 동시 10회 전부 200, 'already connected' 0", async () => {
  for (let i = 0; i < 20; i++) { const r = await rpc("tools/list", {}, i); assert.equal(r.status, 200); const j = await r.json(); assert.equal(j.result.tools.length, 12); }
  const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } }, i)));
  for (const r of rs) { assert.equal(r.status, 200); const t = await r.text(); assert.ok(!/already connected/i.test(t)); }
});

test("HTTP: GET/DELETE 405(+Allow), 잘못된 경로 404, GET 후 POST 200, healthz 키 없음, 본문 1MB 초과 413, JSON 오류 -32700, 외부 Origin 403", async () => {
  const g = await fetch(`http://127.0.0.1:${port}/mcp`); assert.equal(g.status, 405); assert.equal(g.headers.get("allow"), "POST");
  assert.equal((await fetch(`http://127.0.0.1:${port}/mcp`, { method: "DELETE" })).status, 405);
  assert.equal((await fetch(`http://127.0.0.1:${port}/nope`)).status, 404);
  assert.equal((await rpc("tools/list", {})).status, 200);
  const h = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json(); assert.equal(h.ok, true); assert.ok(h.cache && h.upstream); assert.ok(!JSON.stringify(h).includes(FAKE));
  assert.equal((await post("x".repeat(1024 * 1024 + 10))).status, 413);
  const bad = await post("{bad"); assert.equal(bad.status, 400); assert.equal((await bad.json()).error.code, -32700);
  assert.equal((await rpc("tools/list", {}, 1).then((r) => r.status)), 200);
  assert.equal((await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { origin: "https://evil.example" })).status, 403);
  assert.equal((await post({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, { origin: "http://localhost:3000" })).status, 200);
});

test("tools/list ≤ 13KB · 코어 12 · 카탈로그 12 · 이전 서버 이름과 교집합 0", () => {
  assert.ok(TOOL_LIST_BYTES <= 13 * 1024, `${TOOL_LIST_BYTES}B`);
  assert.equal(CORE_TOOLS.length, 12); assert.equal(CATALOG_TOOLS.length, 12);
  const p = join(here, "..", "forbidden_tool_names.txt");
  if (existsSync(p)) { const forbidden = new Set(readFileSync(p, "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean)); assert.equal(forbidden.size, 104); for (const t of [...CORE_TOOLS, ...CATALOG_TOOLS]) assert.ok(!forbidden.has(t.name), t.name); }
});

test("toolbox: list/describe/call, 코어 이름 call 거부, 스키마 위반 INVALID_INPUT, list p50 ≤ 5ms", async () => {
  const l = await toolbox.invoke({ action: "list" }); assert.equal(l.ok, true); assert.equal(l.items.length, 12);
  const q = await toolbox.invoke({ action: "list", query: "조문코드 변환" }); assert.equal(q.items[0].name, "jo_code");
  const d = await toolbox.invoke({ action: "describe", name: "jo_code" }); assert.ok(d.items[0].inputSchema.properties.input);
  const c = await toolbox.invoke({ action: "call", name: "jo_code", args: { input: "제38조의2" } }); assert.equal(c.items[0].code, "003802");
  const back = await toolbox.invoke({ action: "call", name: "jo_code", args: { input: "003802" } }); assert.equal(back.items[0].label, "제38조의2");
  const core = await toolbox.invoke({ action: "call", name: "article_get", args: {} }); assert.equal(core.error.code, "INVALID_INPUT");
  const bad = await toolbox.invoke({ action: "call", name: "jo_code", args: { nope: 1 } }); assert.equal(bad.error.code, "INVALID_INPUT");
  const times = []; for (let i = 0; i < 20; i++) { const t0 = performance.now(); await toolbox.invoke({ action: "list", query: "판례" }); times.push(performance.now() - t0); }
  times.sort((a, b) => a - b); assert.ok(times[10] <= 5, `list p50 ${times[10].toFixed(2)}ms`);
});

test("보안: 가짜 키로 모든 코어 도구·오류 경로 실행 → 응답·stdout·stderr·디스크 캐시에 키 0회", async () => {
  _setApiKey(FAKE); drfTest.reset(); cache.clear();
  const origFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => { seen.push(String(url)); return new Response(JSON.stringify({ result: "사용자 정보 검증에 실패하였습니다.", msg: `bad key ${FAKE}` }), { status: 200 }); };
  const out = []; const logs = [];
  const oe = console.error; console.error = (...a) => logs.push(a.join(" "));
  try {
    const calls = [["statute_find", { query: "주택법" }], ["statute_find", { mode: "suggest", query: "주택" }], ["article_get", { name: "주택법", articles: ["제15조"] }], ["statute_outline", { name: "주택법" }], ["annex_get", { name: "주택법" }], ["statute_history", { name: "주택법" }], ["source_search", { source: "precedent", query: "x" }], ["source_get", { source: "precedent", id: "1" }], ["citation_audit", { text: "민법 제750조" }], ["precedent_trace", { caseNo: "2025다220329" }], ["contract_risk_scan", { text: "x" }], ["research_run", { scenario: "statute_map", query: "주택법" }], ["toolbox", { action: "call", name: "term_lookup", args: { query: "월세" } }], ["nope", {}]];
    for (const [n, a] of calls) out.push(JSON.stringify(await callTool(n, a)));
  } finally { globalThis.fetch = origFetch; console.error = oe; _setApiKey(""); }
  assert.ok(seen.length > 0 && seen.every((u) => u.includes(`OC=${FAKE}`)), "업스트림 URL 에는 키가 간다");
  for (const o of out) assert.ok(!o.includes(FAKE), "응답에 키 없음");
  for (const l of logs) assert.ok(!l.includes(FAKE), "stderr 에 키 없음");
  for (const k of cache.map.keys()) assert.ok(!k.includes(FAKE), "캐시 키에 키 없음");
  assert.ok(out.some((o) => o.includes("UPSTREAM_AUTH")));
  const dir = process.env.LAWMCP_CACHE_DIR || join(process.env.HOME || process.env.USERPROFILE || "", ".cache", "airealty-lawmcp");
  if (existsSync(dir)) for (const f of readdirSync(dir)) if (statSync(join(dir, f)).isFile()) assert.ok(!readFileSync(join(dir, f), "utf8").includes(FAKE), "디스크 캐시에 키 없음");
});

test("재시도·레이트리밋: HTML 응답 재시도 후 성공, 인증 오류 무재시도, 초당 요청 수 ≤ 버킷", async () => {
  _setApiKey("k1234567"); drfTest.reset(); cache.clear();
  const origFetch = globalThis.fetch; const origBackoff = settings.backoffMs; settings.backoffMs = 5;
  let n = 0; const stamps = [];
  globalThis.fetch = async () => { n++; stamps.push(Date.now()); if (n === 1) return new Response("<html>점검</html>", { status: 200 }); return new Response(JSON.stringify({ LawSearch: { totalCnt: "0" } }), { status: 200 }); };
  try {
    const { call } = await import("../src/drf.js");
    const d = await call("lawSearch.do", { target: "eflaw", query: "x1" }); assert.equal(d.LawSearch.totalCnt, "0"); assert.equal(n, 2);
    n = 0; globalThis.fetch = async () => { n++; return new Response(JSON.stringify({ result: "fail", msg: "auth" }), { status: 200 }); };
    await assert.rejects(() => call("lawSearch.do", { target: "eflaw", query: "x2" }), (e) => e.code === "UPSTREAM_AUTH"); assert.equal(n, 1, "인증 오류는 재시도 없음");
    n = 0; stamps.length = 0; globalThis.fetch = async () => { n++; stamps.push(Date.now()); return new Response(JSON.stringify({ LawSearch: { totalCnt: "0" } }), { status: 200 }); };
    await Promise.all(Array.from({ length: 16 }, (_, i) => call("lawSearch.do", { target: "eflaw", query: `q${i}` })));
    const windowMax = Math.max(...stamps.map((t) => stamps.filter((s) => s >= t && s < t + 1000).length));
    assert.ok(windowMax <= settings.burst + settings.ratePerSec, `1초 창 최대 ${windowMax}`);
  } finally { globalThis.fetch = origFetch; settings.backoffMs = origBackoff; _setApiKey(""); drfTest.reset(); }
});

test("캐시 적중 호출 p50 ≤ 10ms (모의 사전·모의 본문)", async () => {
  _setApiKey("k1234567"); drfTest.reset(); cache.clear();
  _setDictionary({ entries: [{ n: "주택법", k: "법률", i: "001809", m: "289171", e: "2026-09-08" }], abbreviations: [], loadedAt: Date.now() });
  const body = JSON.parse(readFileSync(join(here, "fixtures", "eflaw_body_id_jo15.json"), "utf8"));
  const vers = JSON.parse(readFileSync(join(here, "fixtures", "eflaw_versions_jutaek.json"), "utf8"));
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (u) => new Response(JSON.stringify(String(u).includes("LID=") ? vers : body), { status: 200 });
  try {
    const { default: article_get } = await import("../src/tools/article_get.js");
    const first = await article_get.invoke({ name: "주택법", articles: ["제15조"] }); assert.equal(first.ok, true); assert.equal(first.items[0].title, "사업계획의 승인");
    const times = []; for (let i = 0; i < 11; i++) { const t0 = performance.now(); const r = await article_get.invoke({ name: "주택법", articles: ["제15조"] }); assert.equal(r.meta.cache, "hit"); times.push(performance.now() - t0); }
    times.sort((a, b) => a - b); assert.ok(times[5] <= 10, `p50 ${times[5].toFixed(2)}ms`);
  } finally { globalThis.fetch = origFetch; _setApiKey(""); }
});

test("cold start: 프로세스 시작~initialize 응답 < 300ms (5회 중앙값)", async () => {
  const run = () => new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [join(here, "..", "src", "index.js")], { env: { ...process.env, openlaw_API_KEY: "k1234567", LAWMCP_PREWARM: "0" }, stdio: ["pipe", "pipe", "pipe"] });
    let buf = ""; child.stdout.on("data", (d) => { buf += d; if (buf.includes('"result"')) { child.kill(); resolve(Date.now() - t0); } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } }) + "\n");
    setTimeout(() => { child.kill(); resolve(99999); }, 10000);
  });
  const ms = []; for (let i = 0; i < 5; i++) ms.push(await run());
  ms.sort((a, b) => a - b); assert.ok(ms[2] < 300, `cold start p50 ${ms[2]}ms (${ms.join(",")})`);
});

test("인증: 토큰 서버 — 없음/틀림 401(WWW-Authenticate), 맞음 200, tools/call 버스트 초과 429(Retry-After), healthz·로그에 토큰 값 0회, OPTIONS 204, 허용 Origin 통과", async () => {
  const { createTokenStore, createLimiter } = await import("../src/auth.js");
  const { createHash } = await import("node:crypto");
  const { writeFileSync, mkdtempSync, utimesSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const TOKEN = "lm_SAMPLE_TOKEN_abcdefghijklmnop";
  const HASHED = "lm_SAMPLE_HASHED_qrstuvwxyz01234";
  const logs = []; const oe = console.error; console.error = (...a) => logs.push(a.join(" "));
  const tf = join(mkdtempSync(join(tmpdir(), "lawmcp-")), "tokens.txt");
  writeFileSync(tf, `# c
  # indented comment
alice ${TOKEN}
bob ${createHash("sha256").update(HASHED).digest("hex")}
`);
  const store = createTokenStore({ list: "short:abc", file: tf, everyMs: 0 });
  const s = createHttpServer({ tokens: store, allowedOrigins: ["https://app.example"], limiter: createLimiter({ ratePerSec: 1, burst: 3, daily: 100 }) });
  await new Promise((r) => s.listen(0, "127.0.0.1", r)); const p = s.address().port;
  const call = (headers = {}, method = "tools/list") => fetch(`http://127.0.0.1:${p}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: method === "tools/call" ? { name: "toolbox", arguments: { action: "list" } } : {} }) });
  try {
    const none = await call(); assert.equal(none.status, 401); assert.match(none.headers.get("www-authenticate"), /Bearer/);
    assert.equal((await call({ authorization: "Bearer nope" })).status, 401);
    assert.equal((await call({ authorization: "Bearer abc" })).status, 401, "16자 미만 토큰은 등록되지 않는다");
    const ok = await call({ authorization: `Bearer ${TOKEN}` }); assert.equal(ok.status, 200); assert.equal((await ok.json()).result.tools.length, 12);
    assert.equal((await call({ authorization: `Bearer ${HASHED}` })).status, 200, "파일의 sha256 항목으로 인증");
    const batch = await fetch(`http://127.0.0.1:${p}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "toolbox", arguments: { action: "list" } } }]) });
    assert.equal(batch.status, 400, "배치는 거부(한도 우회 금지)");
    writeFileSync(tf, "# revoked all\n"); utimesSync(tf, new Date(), new Date(Date.now() + 5000));
    assert.equal((await call({ authorization: `Bearer ${HASHED}` })).status, 200, "0개로 다시 읽히면 옛 목록 유지");
    writeFileSync(tf, `alice ${TOKEN}
carol ${createHash("sha256").update("lm_SAMPLE_carol_0123456789abcdef").digest("hex")}
`); utimesSync(tf, new Date(), new Date(Date.now() + 10000));
    assert.equal((await call({ authorization: `Bearer ${HASHED}` })).status, 401, "폐기가 재시작 없이 반영");
    assert.equal((await call({ authorization: "Bearer lm_SAMPLE_carol_0123456789abcdef" })).status, 200);
    const statuses = []; for (let i = 0; i < 4; i++) statuses.push((await call({ authorization: `Bearer ${TOKEN}` }, "tools/call")).status);
    assert.deepEqual(statuses, [200, 200, 200, 429]);
    const r429 = await call({ authorization: `Bearer ${TOKEN}` }, "tools/call"); assert.ok(+r429.headers.get("retry-after") >= 1);
    const h = await (await fetch(`http://127.0.0.1:${p}/healthz`)).text(); assert.ok(!h.includes(TOKEN)); assert.ok(!h.includes("required"), "인증 없는 healthz 는 ok·version 만");
    const hf = await (await fetch(`http://127.0.0.1:${p}/healthz`, { headers: { authorization: `Bearer ${TOKEN}` } })).text(); assert.ok(hf.includes('"required":true'));
    assert.equal((await fetch(`http://127.0.0.1:${p}/mcp`, { method: "OPTIONS", headers: { origin: "https://app.example" } })).status, 204);
    assert.equal((await call({ authorization: `Bearer ${TOKEN}`, origin: "https://app.example" })).status, 200);
    assert.equal((await call({ authorization: `Bearer ${TOKEN}`, origin: "https://evil.example" })).status, 403);
    for (const l of logs) assert.ok(!l.includes(TOKEN), "stderr 에 토큰 없음");
  } finally { console.error = oe; s.close(); }
});

test("인증 꺼진 서버: 프록시 헤더(cf-connecting-ip)가 붙은 요청은 401", async () => {
  const r = await post({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, { "cf-connecting-ip": "203.0.113.9" }); assert.equal(r.status, 401);
  const h = await (await fetch(`http://127.0.0.1:${port}/healthz`, { headers: { "x-forwarded-for": "203.0.113.9" } })).json(); assert.equal(h.cache, undefined);
});

test("인증: tools/list 에 annotations(title·readOnlyHint) 전부", () => {
  for (const t of TOOL_LIST) { assert.ok(t.annotations?.title, t.name); assert.equal(t.annotations.readOnlyHint, true, t.name); }
});
