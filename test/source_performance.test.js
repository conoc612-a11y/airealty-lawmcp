import test from "node:test";
import assert from "node:assert/strict";
import { getTool } from "../src/registry.js";
import { cache, TTL } from "../src/cache.js";
import { requestKey } from "../src/drf.js";
import { _setApiKey } from "../src/keys.js";
import { change_feed } from "../src/tools/catalog.js";

function storeBody(target, params, data) {
  cache.set("drf:" + requestKey("lawService.do", { target, ...params }), data, TTL.body);
}

test("위원회 결정서·행정규칙 기본정보·영문 조문을 공식 응답 구조로 읽는다", async () => {
  const cases = [
    ["pipc", "ppc", { PpcService: { 의결서: { 결정문일련번호: "3", 안건명: "자료 공개", 주문: "인용한다." } } }, "자료 공개", "주문", "인용한다."],
    ["acr", "acr", { AcrService: { 의결서: { 결정문일련번호: "3", 제목: "퇴거", 이유: "시정을 권고한다." } } }, "퇴거", "이유", "시정을 권고한다."],
    ["admin_rule", "admrul", { AdmRulService: { 행정규칙기본정보: { 행정규칙명: "관리 규정", 행정규칙일련번호: "3" }, 조문내용: "제1조 목적" } }, "관리 규정", "조문내용", "제1조 목적"],
    ["english", "elaw", { Law: { InfSection: { lsNmEng: "Building Act" }, JoSection: { Jo: [{ joCts: "Article 1 Purpose" }, { joCts: "Article 2 Definitions" }] } } }, "Building Act", "조문", "Article 1 Purpose\nArticle 2 Definitions"],
  ];
  for (const [source, target, envelope, title, section, text] of cases) {
    storeBody(target, source === "english" ? { MST: "3" } : { ID: "3" }, envelope);
    const result = await getTool("source_get").invoke({ source, id: "3" });
    assert.equal(result.ok, true, source);
    assert.equal(result.items[0].title, title);
    assert.equal(result.items[0].sections[section], text);
  }
});

test("국세청 판례는 정부 HTML 링크를 제공한다", async () => {
  const params = { target: "prec", query: "법인세", display: 1, page: 1 };
  cache.set("drf:" + requestKey("lawSearch.do", params), { PrecSearch: { totalCnt: 1, prec: {
    판례일련번호: "123", 사건명: "법인세", 데이터출처명: "국세법령정보시스템",
  } } }, TTL.list);
  const result = await getTool("source_search").invoke({ source: "precedent", query: "법인세", size: 1 });
  assert.equal(result.items[0].bodyFormat, "html");
  assert.equal(new URL(result.items[0].link).searchParams.get("precSeq"), "123");
  assert.ok(!result.next?.some(step => step.tool === "source_get"));
  storeBody("prec", { ID: "123" }, { Law: "일치하는 자료가 없습니다." });
  const body = await getTool("source_get").invoke({ source: "precedent", id: "123" });
  assert.equal(body.error.code, "SOURCE_NOT_FOUND");
  assert.equal(body.error.link, result.items[0].link);
});

test("변경이력의 여섯 번째 쪽까지 집계하고 실패한 쪽을 표시한다", async t => {
  _setApiKey("fixture-only");
  const seen = [], failures = new Set(["20260121:3"]);
  t.mock.method(globalThis, "fetch", async input => {
    const q = new URL(input).searchParams, page = Number(q.get("page")), date = q.get("regDt");
    seen.push(date + ":" + page);
    if (failures.has(date + ":" + page)) return new Response("missing", {status: 404});
    const count = page === 6 ? 1 : 100;
    const rows = Array.from({length: count}, (_, i) => ({
      법령일련번호: String((page - 1) * 100 + i + 1), 법령명한글: "테스트", 시행일자: date,
    }));
    return Response.json({ LawSearch: {totalCnt: 501, law: rows} });
  });
  const full = await change_feed.invoke({date:"2026-01-20",size:1});
  assert.equal(full.total, 501); assert.deepEqual(full.warnings, []);
  const partial = await change_feed.invoke({date:"2026-01-21",size:1});
  assert.equal(partial.total, 401);
  assert(partial.warnings.some(s => s.includes("3쪽")));
  assert(seen.includes("20260121:6"));
});
