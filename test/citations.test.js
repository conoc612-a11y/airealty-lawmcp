// 인용 추출·사건번호·내용 일치 — 앞말 제거 10케이스, 「」, 같은 법/동법, 날짜 오인 0, airealty citation.test.js 기대값 회귀.
import { test } from "node:test";
import assert from "node:assert/strict";
import { _setDictionary } from "../src/dictionary.js";
import { extractCitations, matchClaim, similarity, normalizeForMatch } from "../src/citations.js";
import { findCaseNumbers, isCaseNo } from "../src/casenos.js";

_setDictionary({ entries: ["주택법", "주택법 시행령", "민법", "소득세법", "주택임대차보호법", "상가건물 임대차보호법", "상법", "국제사법", "지방자치법", "조세특례제한법", "형법", "건축법"].map((n, i) => ({ n, k: "법률", i: String(i).padStart(6, "0"), m: "1", e: "2026-01-01" })), abbreviations: [{ abbr: "상임법", name: "상가건물 임대차보호법", lawId: "000005", current: true }], loadedAt: Date.now() });

const laws = (t) => extractCitations(t).filter((c) => c.kind === "statute").map((c) => [c.law, c.label]);

test("앞말 제거 10케이스: 조사·접속어·문장 중간", () => {
  const cases = [
    ["임대인의 불법행위에는 민법 제750조가 적용된다", ["민법", "제750조"]],
    ["또한 소득세법 제999조에 따라", ["소득세법", "제999조"]],
    ["소액임차인의 최우선변제는 주택임대차보호법 제8조에 따른다", ["주택임대차보호법", "제8조"]],
    ["그러나주택법 제15조는", ["주택법", "제15조"]],
    ["(민법 제105조)", ["민법", "제105조"]],
    ["민법제750조", ["민법", "제750조"]],
    ["상임법 제10조의4제1항", ["상가건물 임대차보호법", "제10조의4"]],
    ["이 경우 「지방자치법」 제198조제1항에 따른", ["지방자치법", "제198조"]],
    ["조세특례제한법 제99조의3(신축주택)", ["조세특례제한법", "제99조의3"]],
    ["국제사법 제2조와 사법 제1조", ["국제사법", "제2조"]],
  ];
  for (const [t, want] of cases) { const got = laws(t); assert.deepEqual(got[0], want, t); }
  // 마지막 케이스: '사법' 은 사전에 없으므로 두 번째 인용은 법령 미상
  const last = extractCitations("국제사법 제2조와 사법 제1조").filter((c) => c.kind === "statute"); assert.equal(last[1].law, null);
});

test("「」 이름(사전 밖)·같은 법/동법 해소·쉼표 나열 연속·제목 표기", () => {
  const c = extractCitations("「없는특별법」 제3조와 같은 법 제4조, 제5조. 동법 제6조(목적)");
  assert.equal(c[0].law, "없는특별법"); assert.equal(c[0].inDictionary, false);
  assert.equal(c[1].law, "없는특별법"); assert.equal(c[1].anaphora, "같은법");
  assert.equal(c[2].law, "없는특별법"); assert.equal(c[2].continuation, true);
  assert.equal(c[3].law, "없는특별법"); assert.equal(c[3].titleInText, "목적");
  const u = extractCitations("같은 법 제3조에 따른다"); assert.equal(u[0].unresolved, true);
  const refs = extractCitations("[1] 민법 제1026조 제1호 / [2] 민법 제105조 / [3] 민법 제105조, 제1022조, 제1026조 제1호");
  assert.deepEqual(refs.map((r) => r.label), ["제1026조", "제105조", "제105조", "제1022조", "제1026조"]);
  assert.ok(refs.every((r) => r.law === "민법"));
  assert.deepEqual(extractCitations("「주택법」 제15조 제1항 제3호")[0].ref, { article: 15, branch: 0, paragraph: 1, item: 3 });
  assert.equal(extractCitations("주택법 시행령 제20조의2 제2호")[0].law, "주택법 시행령");
});

test("사건번호: 부호 검증, 날짜 오인 0, 법원명", () => {
  const t = "2026년 5월 8일 대법원 2004. 3. 12. 선고 2003다63586 판결과 2025다220329, 2019헌바315, 서울중앙지방법원 2020가합12345";
  const cs = findCaseNumbers(t);
  assert.deepEqual(cs.map((c) => c.caseNo), ["2003다63586", "2025다220329", "2019헌바315", "2020가합12345"]);
  assert.equal(cs[0].court, "대법원"); assert.equal(cs[3].court, "서울중앙지방법원");
  assert.equal(findCaseNumbers("2026년 5월 2025년 12월").length, 0);
  assert.ok(isCaseNo("2025다220329")); assert.ok(!isCaseNo("2025년5월"));
});

test("내용 일치: 정규화·포함·2-gram 유사도 (airealty citation.test.js 회귀)", () => {
  assert.equal(normalizeForMatch("제 15조 「가·나」"), "제15조가나");
  assert.equal(matchClaim("제15조 제1항", "제15조 제1항").method, "exact");
  assert.equal(matchClaim("제15조", "제15조 제1항에 따라").method, "contained");
  const r = matchClaim("누구든지 타인의 토지를 무단점유할 수 없다", "타인의 토지를 무단점유하는 행위는 금지된다", [], 0.9);
  assert.equal(r.method, "similar"); assert.ok(r.similarity > 0.3); assert.equal(r.ok, false);
  assert.equal(matchClaim("제99조 제9항", "제15조 제1항", [], 0.9).ok, false);
  assert.equal(similarity("abc", "abc"), 1); assert.ok(similarity("가나다", "가나다라") > 0.5); assert.equal(similarity("", "가나"), 0);
});
