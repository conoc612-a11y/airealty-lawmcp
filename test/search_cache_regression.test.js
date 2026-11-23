import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getTool } from "../src/registry.js";
import { dictionary, _setDictionary } from "../src/dictionary.js";
import { extractCitations } from "../src/citations.js";
import { cache, TTL } from "../src/cache.js";
import { readDisk, writeDisk } from "../src/diskcache.js";
import { _setApiKey } from "../src/keys.js";
import { requestKey, _test as drf } from "../src/drf.js";
import { listVersions } from "../src/versions.js";
import { analyze } from "../src/risk/engine.js";

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
function tempDir(t, env) {
  const dir = mkdtempSync(join(tmpdir(), "law-regression-"));
  const old = process.env[env];
  process.env[env] = dir;
  t.after(() => {
    if (old === undefined) delete process.env[env]; else process.env[env] = old;
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}
function mockUpstream(t, respond) {
  drf.reset(); cache.clear(); _setApiKey("fixture-only");
  t.mock.method(globalThis, "fetch", respond);
  t.after(() => { cache.clear(); _setApiKey(""); drf.reset(); });
}

test("case_search returns ranked local snippets via toolbox and respects the byte cap", async (t) => {
  const dir = tempDir(t, "LAWMCP_CASES_DIR");
  mkdirSync(join(dir, "old"));
  writeFileSync(join(dir, "old", "alpha.txt"), "앞".repeat(60) + "ALPHA 보증금 Alpha");
  writeFileSync(join(dir, "claim.md"), "보증금");
  writeFileSync(join(dir, "large.txt"), "가".repeat(500) + "보증금");
  writeFileSync(join(dir, "packed.hwpx"), Buffer.from("PK\x03\x04보증금"));
  const run = () => getTool("toolbox").invoke({ action: "call", name: "case_search", args: { query: "보증금 Alpha 미납", maxFileBytes: 1000 } });
  const first = await run();
  assert.equal(first.ok, true);
  assert.equal(first.total, 2);
  assert.deepEqual(first.items.map((x) => [x.name, x.score]), [["alpha.txt", 13], ["claim.md", 1]]);
  assert.deepEqual(first.items[0].matchedTerms, ["보증금", "Alpha"]);
  assert.deepEqual(first.items[0].missingTerms, ["미납"]);
  assert.equal(first.items[0].snippet, "…" + "앞".repeat(40) + "ALPHA 보증금 Alpha…");
  writeFileSync(join(dir, "claim.md"), "종결");
  assert.equal((await run()).total, 1);
});

test("citation index refreshes on a same-size dictionary swap, including abbreviation IDs and spans", (t) => {
  const original = dictionary();
  t.after(() => _setDictionary(original));
  const entries = [{ n: "시험 특별법", i: "000001" }, { n: "특별법", i: "000002" }];
  const abbr = (lawId) => [{ abbr: "약칭", name: "시험 특별법", lawId }];
  const text = "시험 특별법 제3조 및 「약칭」 제4조";
  _setDictionary({ entries, abbreviations: abbr("000001") });
  const before = extractCitations(text);
  assert.deepEqual(before.map((c) => [text.slice(...c.span), c.lawId]), [["시험 특별법 제3조", "000001"], ["「약칭」 제4조", "000001"]]);
  _setDictionary({ entries: [{ n: "교체법", i: "000003" }, entries[1]], abbreviations: [{ abbr: "약칭", name: "교체법", lawId: "000003" }] });
  assert.deepEqual(extractCitations(text).map((c) => c.lawId), ["000002", "000003"]);
});

test("disk-loaded versions retain their original TTL and expire at Korean midnight", async (t) => {
  tempDir(t, "LAWMCP_CACHE_DIR");
  const raw = fixture("eflaw_versions_jutaek.json");
  const upstream = () => Promise.resolve(new Response(raw));
  let now = Date.parse("2026-11-23T09:00:00+09:00");
  t.mock.method(Date, "now", () => now);
  mockUpstream(t, upstream);
  const value = { name: "disk", kind: "법률", versions: [{ mst: "1" }] };
  writeDisk("versions", "001809", value, now - TTL.resolve + 10);
  assert.equal((await listVersions("001809")).name, "disk");
  now += 10;
  assert.equal((await listVersions("001809")).name, "주택법");
  now = Date.parse("2026-11-23T23:59:59.990+09:00");
  cache.clear();
  assert.equal((await listVersions("001809")).hit, false);
  assert.equal((await listVersions("001809")).hit, true);
  now += 10;
  assert.equal((await listVersions("001809")).hit, false);
});

test("a failed refresh keeps stale version pages and precedent bodies marked stale", async (t) => {
  tempDir(t, "LAWMCP_CACHE_DIR");
  mockUpstream(t, async () => new Response(JSON.stringify({ result: "fail", msg: "auth" })));
  const expired = Date.now() - 1000;
  const seed = (path, params, filename) => cache.set("drf:" + requestKey(path, params), JSON.parse(fixture(filename)), 1, expired);
  const data = JSON.parse(fixture("eflaw_versions_jutaek.json")).LawSearch;
  const pages = Math.max(1, Math.min(5, Math.ceil(+data.totalCnt / 100)));
  for (let page = 1; page <= pages; page++)
    seed("lawSearch.do", { target: "eflaw", LID: "001809", nw: "1,2,3", display: 100, page, sort: "efdes" }, "eflaw_versions_jutaek.json");
  assert.equal((await listVersions("001809")).stale, true);
  assert.equal(readDisk("versions", "001809"), null);
  assert.equal((await listVersions("001809")).stale, true);
  seed("lawService.do", { target: "prec", ID: "621911" }, "prec_body_621911.json");
  const body = await getTool("source_get").invoke({ source: "precedent", id: "621911" });
  assert.equal(body.ok, true);
  assert.equal(body.meta.cache, "stale");
});

test("limiting contract findings preserves order, grade, conflicts and total", () => {
  const text = fixture("lease_risky.txt");
  const all = analyze(text, { maxFindings: 100 }), top = analyze(text, { maxFindings: 2 });
  assert.ok(all.findingsTotal > 2);
  assert.deepEqual(top, { ...all, findings: all.findings.slice(0, 2) });
});
