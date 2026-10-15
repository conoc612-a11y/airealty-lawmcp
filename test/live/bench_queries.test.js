// 실업스트림 수용 테스트 B1~B11 (SPEC §10.1) — 실서버 HTTP 로 호출한다. 서버가 안 떠 있으면 건너뛴다.
// 실행: LAWMCP_LIVE_URL=http://127.0.0.1:3457/mcp node --test test/live/
import { test, before } from "node:test";
import assert from "node:assert/strict";

const URL_ = process.env.LAWMCP_LIVE_URL || "http://127.0.0.1:3457/mcp";
let alive = false;
try { alive = (await fetch(URL_.replace(/\/mcp$/, "/healthz"))).ok; } catch { alive = false; }
const skip = () => !alive && { skip: `실서버 없음(${URL_})` };

async function call(name, args) {
  const r = await fetch(URL_, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  assert.equal(r.status, 200);
  const text = await r.text();
  const j = JSON.parse(text);
  const inner = j.result.content[0].text;
  return { body: JSON.parse(inner), bytes: Buffer.byteLength(inner), raw: text };
}
const noKey = (s) => assert.ok(!/OC=[A-Za-z0-9]{4,}/.test(s), "응답에 인증값 없음");

test("B1 statute_find 주택법", skip() || {}, async () => {
  const { body, raw } = await call("statute_find", { query: "주택법" }); noKey(raw);
  assert.equal(body.ok, true); const top = body.items[0];
  assert.equal(top.name, "주택법"); assert.equal(top.matchType, "exact"); assert.equal(top.kind, "법률");
  assert.ok(top.promulgationDate && top.effectiveDate && top.status === "current");
  assert.ok(Array.isArray(top.upcoming)); for (const u of top.upcoming) assert.ok(u.mst && u.effectiveDate > body.meta.asOf);
  assert.ok(body.next.some((n) => n.tool === "article_get"));
  assert.ok(!JSON.stringify(body.items).includes("법령명한글"), "업스트림 원본 키 없음");
});

test("B2 article_get 주택법 제15조", skip() || {}, async () => {
  const { body, raw } = await call("article_get", { name: "주택법", articles: ["제15조"] }); noKey(raw);
  assert.equal(body.ok, true); const it = body.items[0];
  assert.equal(it.label, "제15조"); assert.equal(it.title, "사업계획의 승인"); assert.ok(it.paragraphs.length >= 2);
  assert.ok(it.paragraphs[0].items && it.paragraphs[0].items.length >= 2 && it.paragraphs[0].items[0].no === "1.");
  assert.ok(["current", "upcoming"].includes(body.law.status));
  if (body.law.upcoming.length) assert.ok(body.warnings.some((w) => w.includes("시행예정")));
  assert.ok(!("text" in it) && it.head && it.head.startsWith("제15조"), "structured: 본문은 paragraphs 에만, 머리글은 head");
  const t = await call("article_get", { name: "주택법", articles: ["제15조"], format: "text" }); assert.ok(t.body.items[0].text.length > 200 && !("paragraphs" in t.body.items[0]));
});

test("B2' 시행예정 MST 직접 지정 → 경고", skip() || {}, async () => {
  const f = await call("statute_find", { query: "주택법" }); const up = f.body.items[0].upcoming.find((u) => u.mst !== f.body.items[0].mst) || f.body.items[0].upcoming[0];
  if (!up) return;
  const { body } = await call("article_get", { mst: up.mst, articles: ["제15조"] });
  assert.equal(body.ok, true); assert.ok(body.warnings.some((w) => /아직 시행 전|적용 판이 아님/.test(w)), JSON.stringify(body.warnings));
});

test("B3 article_get 소득세법 시행령 제155조 전문", skip() || {}, async () => {
  const { body, bytes } = await call("article_get", { name: "소득세법 시행령", articles: ["제155조"], maxBytes: 200000 });
  assert.equal(body.ok, true); assert.equal(body.items.length, 1); const it = body.items[0];
  assert.equal(it.label, "제155조"); assert.ok(!("text" in it)); assert.ok(it.paragraphs.length >= 20); assert.ok(bytes <= 40 * 1024, `${bytes}B(본문 중복 없음)`);
  assert.ok(!body.items.some((x) => x.branch)); assert.equal(body.page.hasMore, false);
  assert.match(it.paragraphs[it.paragraphs.length - 1].no, /^(㉕|<25>|㉖|<26>|㉔|<24>)$/);
});

test("B3' 목차 모드 ≤ 20KB(주택법)", skip() || {}, async () => {
  const { body, bytes } = await call("article_get", { name: "주택법" });
  assert.equal(body.ok, true); assert.ok(bytes <= 20 * 1024, `${bytes}B`); assert.ok(body.items.every((t) => !t.text));
});

test("B4 annex_get 주택법 → 하위법 보충", skip() || {}, async () => {
  const { body, raw } = await call("annex_get", { name: "주택법" }); noKey(raw);
  assert.equal(body.ok, true); assert.ok(body.total >= 1);
  assert.ok(body.items.every((it) => ["주택법 시행령", "주택법 시행규칙"].includes(it.law.name)));
  assert.ok(body.notes.some((n) => n.includes("별표·서식")));
  assert.equal(new Set(body.items.map((i) => i.key)).size, body.items.length);
  assert.equal(body.page.hasMore, body.total > body.items.length);
  const one = await call("annex_get", { name: "주택법 시행령", annexNo: "별표 1" }); assert.ok(one.body.items[0].text.length > 500);
});

test("B5 source_search 판례 임대차보증금", skip() || {}, async () => {
  const { body, bytes, raw } = await call("source_search", { source: "precedent", query: "임대차보증금" }); noKey(raw);
  assert.ok(body.total >= 100); assert.equal(body.returned, 20); assert.equal(body.page.hasMore, true);
  assert.ok(body.items.every((i) => i.caseNo && i.date && i.link && !i.link.includes("OC=")));
  assert.ok(body.items.filter((i) => i.court).length >= 15);
  assert.ok(body.next.some((n) => n.tool === "source_search" && n.args.page === 2));
  assert.ok(bytes <= 10569 * 0.6 + 300, `${bytes}B`);
});

test("B6 source_search [interpretation, tax_ruling] 양도소득세", skip() || {}, async () => {
  const { body, raw } = await call("source_search", { source: ["interpretation", "tax_ruling"], query: "양도소득세" }); noKey(raw);
  assert.equal(body.items.length, 2); for (const g of body.items) assert.ok(g.total >= 1 && g.items.length);
  assert.ok(body.notes.some((n) => n.includes("병합"))); assert.ok(!raw.includes("&amp;"));
});

test("B7 statute_find suggest 주택", skip() || {}, async () => {
  const { body } = await call("statute_find", { mode: "suggest", query: "주택" });
  const top5 = body.items.slice(0, 5).map((i) => i.name);
  assert.ok(top5.includes("주택법") && top5.includes("주택임대차보호법"), top5.join(","));
  assert.ok(body.items.every((i) => i.mst && i.lawId && i.kind)); assert.ok(!body.items.some((i) => i.kind === "시행규칙"));
});

test("B8 statute_outline hierarchy 주택법 ≤ 8KB", skip() || {}, async () => {
  const { body, bytes } = await call("statute_outline", { name: "주택법", view: "hierarchy" });
  assert.equal(body.ok, true); const it = body.items[0];
  assert.equal(it.law.name, "주택법"); assert.ok(bytes <= 8 * 1024, `${bytes}B`);
  assert.ok(it.lower.decree.some((d) => d.name === "주택법 시행령")); assert.ok(it.lower.rule.some((d) => d.name === "주택법 시행규칙"));
  assert.ok(it.lower.rule.every((d) => d.kind && d.kind !== "부령"), "법종은 사전·체계도 값(국토교통부령 등)");
  if (it.adminRules.total != null) assert.ok(it.lower.rule.some((d) => d.name === "공동주택 층간소음의 범위와 기준에 관한 규칙"), "체계도가 있으면 공동부령도 포함");
  const d = await call("statute_outline", { name: "주택법", view: "delegation", size: 5 }); assert.ok(d.body.items.length >= 1 && d.body.items.every((n) => n.label && n.title));
});

test("B9 citation_audit 벤치 문장", skip() || {}, async () => {
  const { body } = await call("citation_audit", { text: "임대인의 불법행위에는 민법 제750조가 적용되고, 소액임차인의 최우선변제는 주택임대차보호법 제8조에 따른다. 또한 소득세법 제999조에 따라 비과세된다." });
  assert.equal(body.items.length, 3);
  assert.equal(body.items[0].status, "VERIFIED"); assert.equal(body.items[0].law, "민법"); assert.equal(body.items[0].actual.title, "불법행위의 내용");
  assert.equal(body.items[1].status, "VERIFIED"); assert.equal(body.items[1].law, "주택임대차보호법"); assert.equal(body.items[1].actual.title, "보증금 중 일정액의 보호");
  assert.equal(body.items[2].status, "ARTICLE_NOT_FOUND"); assert.equal(body.items[2].law, "소득세법"); assert.match(body.items[2].validRange, /^제1조~제\d+조$/);
  assert.ok(!body.items.some((i) => /행위에는|또한/.test(i.law))); assert.equal(body.summary.suspicious, 1);
});

test("B10 source_search tax_tribunal 취득세 중과", skip() || {}, async () => {
  const { body, raw } = await call("source_search", { source: "tax_tribunal", query: "취득세 중과" }); noKey(raw);
  assert.ok(body.total >= 1000); assert.equal(body.returned, 20);
  const dates = body.items.map((i) => i.date).filter(Boolean); assert.ok(dates[0] >= "2020-01-01" && dates.every((d, i) => !i || d <= dates[i - 1]), `최신순: ${dates.slice(0, 3)}`);
  assert.ok(body.notes.some((n) => /최신순/.test(n)));
});

test("B6' tax_ruling 기본 최신순", skip() || {}, async () => {
  const { body } = await call("source_search", { source: "tax_ruling", query: "양도소득세" });
  const dates = body.items.map((i) => i.date).filter(Boolean); assert.ok(dates[0] >= "2020-01-01", dates[0]);
});

test("B11 precedent_trace 2025다220329", skip() || {}, async () => {
  const { body } = await call("precedent_trace", { caseNo: "2025다220329" });
  const it = body.items[0];
  assert.equal(it.case.court, "대법원"); assert.ok(it.outgoing.articles.some((a) => a.law === "민법" && a.label === "제1026조"));
  assert.ok(typeof it.case.holding === "string" && it.case.holding.length > 20 && it.case.holding.length <= 301, "판시사항 앞 300자");
  const keys = it.outgoing.cases.map((c) => c.caseNo); assert.equal(new Set(keys).size, keys.length);
  assert.equal(it.signal.label, "no_later_citation");
});

test("문서 위험 규칙 basis 전부 VERIFIED (통합)", skip() || {}, async () => {
  const { readFileSync } = await import("node:fs");
  const rules = JSON.parse(readFileSync(new URL("../../src/risk/rules.json", import.meta.url), "utf8")).rules;
  const cits = []; for (const r of rules) for (const b of r.basis) if (!cits.some((c) => c.law === b.law && c.article === b.label)) cits.push({ law: b.law, article: b.label });
  const { body } = await call("citation_audit", { citations: cits });
  const bad = body.items.filter((i) => i.status !== "VERIFIED");
  assert.deepEqual(bad.map((i) => `${i.law} ${i.article} ${i.status}`), []);
  // 수치 근거: 규칙의 numberBasis 문자열이 현행 원문에 있는지
  for (const r of rules) if (r.check?.numberBasis) { const nb = r.check.numberBasis; const a = await call("article_get", { name: nb.law, articles: [nb.label], format: "text" }); assert.ok(a.body.items[0].text.includes(nb.mustContain), `${r.id}: ${nb.law} ${nb.label} 에 '${nb.mustContain}' 없음`); }
});
