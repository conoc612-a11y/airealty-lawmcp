#!/usr/bin/env node
// 벤치: (1) cold start(프로세스 시작~initialize 응답) 5회, (2) 실서버 HTTP 로 B1~B11 질의 5회(1.5초 간격) — 콜드·웜·p50·p90·바이트.
// 사용: node tools/bench.js [--url http://127.0.0.1:3457/mcp] [--reps 5] [--out bench.json]
//   --cold B8,B9        : 매 반복마다 새 프로세스 + 새 캐시 디렉터리(사전 파일만 복사) 로 첫 호출 지연을 잰다(예열 끔)
//   --prewarmed B8,B9   : 예열 서버를 한 번 끝까지 돌려 디스크를 채운 뒤, 매 반복마다 새 프로세스로 첫 호출 지연을 잰다
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync, copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir, homedir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => (a.startsWith("--") ? [a.slice(2), arr[i + 1]] : [])).filter((x) => x.length));
const URL_ = args.url || "http://127.0.0.1:3457/mcp";
const REPS = +(args.reps || 5);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))]; };

// ── 새 프로세스 벤치(--cold / --prewarmed) ──
const DICT_SRC = join(process.env.LAWMCP_CACHE_DIR || join(homedir(), ".cache", "airealty-lawmcp"), "law_dictionary.json");
function freshCacheDir(withDictionary = true) {
  const d = mkdtempSync(join(tmpdir(), "lawmcp-bench-"));
  if (withDictionary && existsSync(DICT_SRC)) copyFileSync(DICT_SRC, join(d, "law_dictionary.json"));
  return d;
}
async function spawnHttp({ cacheDir, prewarm, port }) {
  const child = spawn(process.execPath, [join(here, "..", "src", "http-server.js")], { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, LAWMCP_CACHE_DIR: cacheDir, LAWMCP_PREWARM: prewarm ? "1" : "0", LAWMCP_PORT: String(port) } });
  child.stderr.on("data", () => {});
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/healthz`)).ok) return { child, base }; } catch {} await sleep(50); }
  child.kill(); throw new Error("server did not start");
}
async function callAt(base, tool, a) {
  const t0 = Date.now();
  const res = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: a } }) });
  const text = await res.text(); const ms = Date.now() - t0;
  let body = null; try { body = JSON.parse(JSON.parse(text).result?.content?.[0]?.text || "null"); } catch {}
  return { ms, ok: body?.ok, cache: body?.meta?.cache, upstreamMs: body?.meta?.upstreamMs, statuses: body?.items?.map?.((i) => i.status).filter(Boolean) };
}
async function freshProcessBench(ids, { prewarmed }) {
  const picked = QUERIES.filter(([id]) => ids.includes(id));
  let cacheDir = freshCacheDir();
  const port = 3480 + Math.floor(Math.random() * 100);
  const out = { mode: prewarmed ? "cold-with-prewarm" : "cold", reps: REPS, cacheDir, prewarm: null, queries: [] };
  if (prewarmed) {
    const t0 = Date.now();
    const { child, base } = await spawnHttp({ cacheDir, prewarm: true, port });
    let st;
    for (;;) { st = (await (await fetch(`${base}/healthz`)).json()).prewarm; if (st.state === "done" || st.state === "disabled") break; await sleep(1000); }
    child.kill(); await sleep(300);
    out.prewarm = { ...st, ms: Date.now() - t0 };
    console.log("prewarm", JSON.stringify(out.prewarm));
  }
  const runs = Object.fromEntries(picked.map(([id]) => [id, []]));
  for (let i = 0; i < REPS; i++) {
    if (!prewarmed) { rmSync(cacheDir, { recursive: true, force: true }); cacheDir = freshCacheDir(); }
    const { child, base } = await spawnHttp({ cacheDir, prewarm: prewarmed, port: port + 1 + i });
    for (const [id, tool, a] of picked) { const r = await callAt(base, tool, a); runs[id].push(r); console.log(`${out.mode} rep${i + 1} ${id} ${r.ms}ms cache=${r.cache} ok=${r.ok} ${r.statuses ? r.statuses.join(",") : ""}`); }
    child.kill(); await sleep(1500);
  }
  for (const [id, tool, a] of picked) { const ms = runs[id].map((r) => r.ms); out.queries.push({ id, tool, args: a, p50: pct(ms, 0.5), p90: pct(ms, 0.9), min: Math.min(...ms), max: Math.max(...ms), runs: runs[id] }); console.log(out.mode, id, `p50 ${pct(ms, 0.5)} p90 ${pct(ms, 0.9)} min ${Math.min(...ms)} max ${Math.max(...ms)}`); }
  rmSync(cacheDir, { recursive: true, force: true });
  return out;
}

async function coldStart() {
  const t0 = Date.now();
  const child = spawn(process.execPath, [join(here, "..", "src", "index.js")], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, openlaw_API_KEY: process.env.openlaw_API_KEY || "bench-fake-key", LAWMCP_PREWARM: "0" } });
  let buf = "";
  const done = new Promise((resolve) => { child.stdout.on("data", (d) => { buf += d; if (buf.includes('"result"')) resolve(Date.now() - t0); }); });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "bench", version: "0" } } }) + "\n");
  const ms = await Promise.race([done, sleep(10000).then(() => -1)]);
  child.kill();
  return ms;
}

async function rpc(method, params, id = 1) {
  const t0 = Date.now();
  const res = await fetch(URL_, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
  const text = await res.text();
  const ms = Date.now() - t0;
  let json = null; try { json = JSON.parse(text); } catch { const m = text.match(/data:\s*(\{.*\})/); if (m) json = JSON.parse(m[1]); }
  return { ms, status: res.status, bytes: Buffer.byteLength(text), json };
}

export const QUERIES = [
  ["B1", "statute_find", { query: "주택법" }],
  ["B2", "article_get", { name: "주택법", articles: ["제15조"] }],
  ["B3", "article_get", { name: "소득세법 시행령", articles: ["제155조"] }],
  ["B4", "annex_get", { name: "주택법" }],
  ["B5", "source_search", { source: "precedent", query: "임대차보증금" }],
  ["B6", "source_search", { source: ["interpretation", "tax_ruling"], query: "양도소득세" }],
  ["B7", "statute_find", { mode: "suggest", query: "주택" }],
  ["B8", "statute_outline", { name: "주택법", view: "hierarchy" }],
  ["B9", "citation_audit", { text: "임대인의 불법행위에는 민법 제750조가 적용되고, 소액임차인의 최우선변제는 주택임대차보호법 제8조에 따른다. 또한 소득세법 제999조에 따라 비과세된다." }],
  ["B10", "source_search", { source: "tax_tribunal", query: "취득세 중과" }],
  ["B11", "precedent_trace", { caseNo: "2025다220329" }],
];

async function main() {
  if (args.cold || args.prewarmed) {
    const ids = String(args.cold || args.prewarmed).split(",").map((s) => s.trim()).filter(Boolean);
    const res = await freshProcessBench(ids, { prewarmed: !!args.prewarmed });
    if (args.out) writeFileSync(args.out, JSON.stringify({ at: new Date().toISOString(), ...res }, null, 1));
    return;
  }
  const out = { at: new Date().toISOString(), url: URL_, reps: REPS, coldStartMs: [], init: null, list: null, queries: [] };
  for (let i = 0; i < REPS; i++) out.coldStartMs.push(await coldStart());
  console.log("cold start ms", out.coldStartMs, "p50", pct(out.coldStartMs, 0.5));
  const init = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "bench", version: "0" } });
  out.init = { ms: init.ms, status: init.status };
  const lists = []; for (let i = 0; i < REPS; i++) lists.push(await rpc("tools/list", {}));
  out.list = { p50: pct(lists.map((l) => l.ms), 0.5), bytes: Buffer.byteLength(JSON.stringify(lists[0].json?.result || {})), count: lists[0].json?.result?.tools?.length };
  console.log("tools/list", out.list);
  for (const [id, tool, a] of QUERIES) {
    const runs = [];
    for (let i = 0; i < REPS; i++) { const r = await rpc("tools/call", { name: tool, arguments: a }); let body = null; try { body = JSON.parse(r.json?.result?.content?.[0]?.text || "null"); } catch {} runs.push({ ms: r.ms, status: r.status, bytes: r.bytes, ok: body?.ok, upstreamMs: body?.meta?.upstreamMs, cache: body?.meta?.cache, isError: !!r.json?.result?.isError, error: body?.error?.code }); await sleep(1500); }
    const ms = runs.map((r) => r.ms);
    const row = { id, tool, args: a, cold: ms[0], warm: pct(ms.slice(1), 0.5), p50: pct(ms, 0.5), p90: pct(ms, 0.9), bytes: runs[0].bytes, errors: runs.filter((r) => r.status !== 200 || r.error).length, runs };
    out.queries.push(row);
    console.log(id, tool, `cold ${row.cold} warm ${row.warm} p50 ${row.p50} p90 ${row.p90} bytes ${row.bytes} errors ${row.errors}/${REPS}`);
  }
  if (args.out) writeFileSync(args.out, JSON.stringify(out, null, 1));
}
if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, "/")}`).href) main().catch((e) => { console.error(e); process.exit(1); });
