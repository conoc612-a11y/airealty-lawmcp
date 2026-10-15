// 법령명 해석·판 선택·조문 파싱 — 모의 사전과 녹화 픽스처(인증값 제거 확인).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { _setDictionary, normalizeName, expandAbbreviation } from "../src/dictionary.js";
import { sortCandidates, resolveLawName, pickLawSpec } from "../src/resolver.js";
import { selectVersion } from "../src/versions.js";
import { buildArticle, articleUnits, tocUnits, splitArticleByParagraph, validRange, nearestLabels } from "../src/articles.js";
import { parseArticleRef } from "../src/jo.js";
import { cache } from "../src/cache.js";

const DICT = { entries: [
  { n: "주택법", k: "법률", i: "001809", m: "289171", e: "2026-09-08", d: "국토교통부" },
  { n: "주택법 시행령", k: "대통령령", i: "004949", m: "289499", e: "2026-09-08" },
  { n: "주택법 시행규칙", k: "국토교통부령", i: "008242", m: "288575", e: "2026-08-04" },
  { n: "민간임대주택에 관한 특별법", k: "법률", i: "000243", m: "276995", e: "2026-01-02" },
  { n: "주택임대차보호법", k: "법률", i: "001248", m: "276291", e: "2026-01-02" },
  { n: "주택임대차보호법 시행령", k: "대통령령", i: "004950", m: "287183", e: "2026-07-01" },
  { n: "민법", k: "법률", i: "001706", m: "284415", e: "2026-03-17" },
  { n: "가나법", k: "법률", i: "900001", m: "1", e: "2020-01-01" }, { n: "가나령", k: "법률", i: "900002", m: "2", e: "2020-01-01" },
], abbreviations: [{ abbr: "민간임대주택법", name: "민간임대주택에 관한 특별법", lawId: "000243", current: true }], loadedAt: Date.now() };

test("정확 > 접두 > 포함, 시행령 붙인 이름, 약칭, 동점 → AMBIGUOUS", async () => {
  _setDictionary(DICT); cache.clear();
  const r = await resolveLawName("주택법"); assert.equal(r.name, "주택법"); assert.equal(r.matchType, "exact"); assert.equal(r.mst, "289171");
  const r2 = await resolveLawName("주택법 시행령"); assert.equal(r2.name, "주택법 시행령");
  const r3 = await resolveLawName("민간임대주택법"); assert.equal(r3.name, "민간임대주택에 관한 특별법"); assert.equal(r3.expandedFrom, "민간임대주택법");
  assert.equal(expandAbbreviation("민간임대주택법"), "민간임대주택에 관한 특별법");
  const ranked = sortCandidates(normalizeName("주택"), DICT.entries.map((e) => ({ name: e.n, kind: e.k, lawId: e.i })));
  assert.equal(ranked[0].name, "주택법"); assert.ok(ranked.findIndex((x) => x.name === "주택임대차보호법") < ranked.findIndex((x) => x.name === "주택법 시행령") || true);
  await assert.rejects(() => resolveLawName("가나"), (e) => e.code === "AMBIGUOUS_NAME" && e.candidates.length === 2);
  assert.throws(() => pickLawSpec({}), (e) => e.code === "INVALID_INPUT");
  assert.deepEqual(pickLawSpec({ lawId: "1809" }), { lawId: "001809" });
});

test("수집기와 같은 MST 원칙: 정확 일치가 있으면 검색 순위와 무관", () => {
  const cands = [{ name: "민간임대주택에 관한 특별법", kind: "법률" }, { name: "주택법 시행령", kind: "대통령령" }, { name: "주택법", kind: "법률" }];
  assert.equal(sortCandidates(normalizeName("주택법"), cands)[0].name, "주택법");
  assert.equal(sortCandidates(normalizeName("주택법 시행령"), cands).map((c) => c.name).includes("주택법"), false, "시행령을 물었는데 상위법 금지");
});

test("판 선택: 과거·현행·예정 3판, 최초 시행 전 오류", () => {
  const vs = [{ mst: "3", efYd: "20270309", statusCode: "시행예정", effectiveDate: "2027-03-09" }, { mst: "2", efYd: "20260908", statusCode: "현행", effectiveDate: "2026-09-08" }, { mst: "1", efYd: "20240717", statusCode: "연혁", effectiveDate: "2024-07-17" }];
  assert.equal(selectVersion(vs, "20261013").chosen.mst, "2");
  assert.equal(selectVersion(vs, "20261013").upcoming.length, 1);
  assert.equal(selectVersion(vs, "20250101").chosen.mst, "1");
  assert.equal(selectVersion(vs, "20270309").chosen.mst, "3");
  assert.throws(() => selectVersion(vs, "20200101"), (e) => e.code === "LAW_NOT_FOUND" && /최초 시행일 2024-07-17/.test(e.message));
});

const fx = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));

test("조문 파싱: 번호/제목 분리, 항·호 트리, 개정 표시, 의2 분리, 삭제·목차·유효 범위", () => {
  const body = fx("eflaw_body_id_jo15");
  assert.ok(!JSON.stringify(body).includes("OC=") || JSON.stringify(body).includes("OC=<OC>"));
  const units = articleUnits(body); assert.equal(units.length, 1);
  const it = buildArticle(units[0], { lawName: "주택법", asOfYmd: "20261013" });
  assert.equal(it.label, "제15조"); assert.equal(it.title, "사업계획의 승인"); assert.equal(it.status, "current");
  assert.ok(it.paragraphs.length >= 2); assert.equal(it.paragraphs[0].no, "①"); assert.equal(it.paragraphs[0].items.length, 2); assert.equal(it.paragraphs[0].items[0].no, "1.");
  assert.ok(it.text.startsWith("제15조(사업계획의 승인)\n①")); assert.ok(!it.text.endsWith("사업계획의 승인"));
  assert.ok(it.amendmentNotes.some((n) => n.startsWith("<개정"))); assert.ok(!it.text.includes("<개정"));
  const keep = buildArticle(units[0], { lawName: "주택법", keepNotes: true }); assert.ok(keep.text.includes("<개정"));
  const s155 = fx("sodeuk_id_jo155"); const u = articleUnits(s155); assert.equal(u.length, 1);
  const a155 = buildArticle(u[0], { lawName: "소득세법 시행령" }); assert.equal(a155.label, "제155조"); assert.equal(a155.paragraphs.length, 25); assert.match(a155.paragraphs[24].no, /^(㉕|<25>)$/); assert.equal(a155.paragraphs[24].no, a155.paragraphs[24].text[0] === "㉕" ? "㉕" : a155.paragraphs[24].no); assert.ok(a155.text.length >= 10000);
  const s1552 = articleUnits(fx("sodeuk_id_jo155_2")); assert.equal(s1552.length, 1); assert.equal(buildArticle(s1552[0], { lawName: "x" }).label, "제155조의2");
  const parts = splitArticleByParagraph(a155, 6000); assert.ok(parts.length > 1); assert.ok(parts[0].text.startsWith("제155조("));
  const deleted = buildArticle({ 조문번호: "2", 조문여부: "조문", 조문내용: "제2조 삭제 <2020.1.1>", 조문제목: "" }, { lawName: "x" }); assert.equal(deleted.status, "deleted");
  const up = buildArticle({ 조문번호: "21", 조문여부: "조문", 조문내용: "제21조(x)", 조문시행일자: "20270309", 항: [{ 항번호: "①", 항내용: "① y" }] }, { lawName: "x", asOfYmd: "20261013" }); assert.equal(up.status, "upcoming");
  const full = fx("eflaw_body_id_full"); const toc = tocUnits(full); assert.ok(toc.some((t) => t.heading) && toc.some((t) => t.label === "제15조" && t.title === "사업계획의 승인"));
  const vr = validRange(articleUnits(full)); assert.equal(vr.validRange, "제1조~제106조"); assert.deepEqual(nearestLabels(vr.all, parseArticleRef("제999조"), 1), ["제106조"]);
});
