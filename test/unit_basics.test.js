// 공통 단위 테스트 — 날짜 4형식, KST 경계, 조문 표기 7형식, 조문코드 왕복, 캐시, 봉투 분할, 오류 코드, 링크 정규화.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDate, fmtDate, todayKst, msUntilKstMidnight, addDays } from "../src/kst.js";
import { parseArticleRef, formatArticleRef, toJoCode, fromJoCode, circledToNumber } from "../src/jo.js";
import { LruCache } from "../src/cache.js";
import { paginateByBytes, ok, toMcp, mergeCache } from "../src/envelope.js";
import { LawError, coerce } from "../src/errors.js";
import { classifyBody } from "../src/drf.js";
import { normalizeUpstreamLink, lawLink, decodeEntities } from "../src/links.js";
import { scrub, _setApiKey } from "../src/keys.js";
import { diff, diffSentences } from "../src/diff.js";

test("날짜 입력 4형식 → YYYYMMDD, 출력 YYYY-MM-DD", () => {
  for (const s of ["20260101", "2026-01-01", "2026.01.01", "2026. 1. 1."]) assert.equal(parseDate(s), "20260101");
  assert.equal(fmtDate("20261013"), "2026-10-13");
  assert.equal(parseDate("2026-13-01"), null);
  assert.equal(parseDate("2026-02-30"), null);
  assert.equal(addDays("20260301", -1), "20260228");
});

test("KST 기준일: UTC 15:00 경계", () => {
  const t = Date.UTC(2026, 9, 13, 14, 59, 59); // 2026-10-13 23:59:59 KST
  assert.equal(todayKst(t), "20261013");
  assert.equal(todayKst(t + 1000), "20261014");
  assert.ok(msUntilKstMidnight(t) <= 1000 && msUntilKstMidnight(t) > 0);
});

test("조문 표기 7형식 정규화", () => {
  const cases = { "제15조": { article: 15, branch: 0 }, "15조": { article: 15, branch: 0 }, "15": { article: 15, branch: 0 }, "제155조의2": { article: 155, branch: 2 }, "155의2": { article: 155, branch: 2 }, "제8조제1항제2호": { article: 8, branch: 0, paragraph: 1, item: 2 }, "제8조 제1항 제2호 가목": { article: 8, branch: 0, paragraph: 1, item: 2, subitem: "가" } };
  for (const [k, v] of Object.entries(cases)) assert.deepEqual(parseArticleRef(k), v, k);
  assert.equal(parseArticleRef("조문"), null);
  assert.equal(formatArticleRef(parseArticleRef("제8조 제1항 제2호 가목")), "제8조제1항제2호가목");
  assert.equal(circledToNumber("㉕"), 25);
});

test("조문코드 왕복 항등", () => {
  for (const s of ["제38조의2", "제2조", "제10조의2", "제1234조의99"]) { const ref = parseArticleRef(s); const code = toJoCode(ref); assert.deepEqual(fromJoCode(code), { article: ref.article, branch: ref.branch }); }
  assert.equal(toJoCode(parseArticleRef("제38조의2")), "003802");
});

test("LRU 캐시: TTL·항목 상한·바이트 상한·키에 키값 금지", () => {
  const c = new LruCache({ maxEntries: 2, maxBytes: 10000 });
  c.set("a", 1, 1000, 0); c.set("b", 2, 1000, 0); c.set("c", 3, 1000, 0);
  assert.equal(c.get("a", 1), undefined); assert.equal(c.get("c", 1), 3);
  assert.equal(c.get("c", 2000), undefined);
  _setApiKey("SECRETKEY123"); assert.throws(() => c.set("x SECRETKEY123", 1, 10)); _setApiKey("");
  assert.equal(new LruCache({ maxBytes: 10 }).set("k", "x".repeat(100), 10), false);
});

test("봉투: 단위 경계 분할·이어받기·하나의 단위 분할", () => {
  const items = Array.from({ length: 10 }, (_, i) => ({ i, text: "가".repeat(1000) }));
  const p1 = paginateByBytes(items, { maxBytes: 8000, part: 1, overheadBytes: 0 });
  assert.ok(p1.hasMore && p1.items.length < 10);
  const all = []; for (let p = 1; p <= p1.parts; p++) all.push(...paginateByBytes(items, { maxBytes: 8000, part: p, overheadBytes: 0 }).items);
  assert.deepEqual(all, items, "이어받기 복원 시 원문과 동일");
  const big = [{ text: "나".repeat(20000), paragraphs: [{ no: "①", text: "나".repeat(10000) }, { no: "②", text: "나".repeat(10000) }] }];
  const split = paginateByBytes(big, { maxBytes: 30000, part: 1, overheadBytes: 0, splitUnit: (u) => u.paragraphs.map((p, i) => ({ ...u, text: p.text, paragraphs: [p], note: `제1조가 길어 2개 부분으로 나눔` })) });
  assert.ok(split.warnings.some((w) => w.includes("나눔")));
  const body = ok({ items: [1], total: 5 }); assert.equal(body.returned, 1); assert.equal(body.total, 5); assert.equal(body.meta.source, "법제처 DRF");
  assert.equal(mergeCache(["hit", "miss"]), "partial");
  const m = toMcp({ ok: false, error: { code: "X" }, meta: {} }); assert.equal(m.isError, true);
});

test("오류 코드: 인증 래퍼 무재시도, HTML 재시도, 타임아웃", () => {
  const auth = classifyBody(200, JSON.stringify({ result: "사용자 정보 검증에 실패하였습니다.", msg: "..." }));
  assert.ok(auth instanceof LawError && auth.code === "UPSTREAM_AUTH" && auth.retryable === false);
  const html = classifyBody(200, "<!DOCTYPE html><html>안내</html>");
  assert.ok(html instanceof LawError && html.code === "UPSTREAM_FORMAT" && html.retryable === true);
  assert.ok(classifyBody(200, "").code === "UPSTREAM_FORMAT");
  assert.ok(classifyBody(429, "{}").code === "RATE_LIMITED");
  assert.ok(classifyBody(503, "{}").code === "UPSTREAM_UNAVAILABLE");
  assert.deepEqual(classifyBody(200, '{"LawSearch":{"totalCnt":"0"}}'), { LawSearch: { totalCnt: "0" } });
  assert.equal(coerce(Object.assign(new Error("x"), { name: "AbortError", message: "The operation was aborted" })).code, "TIMEOUT");
  assert.throws(() => new LawError("NOPE", "x"));
});

test("링크: OC 제거·엔티티 복원·DRF 링크 거부·공개 링크 형식", () => {
  _setApiKey("ZZSECRET9");
  assert.equal(normalizeUpstreamLink("/DRF/lawService.do?OC=ZZSECRET9&amp;target=prec&amp;ID=1"), null);
  assert.equal(normalizeUpstreamLink("https://taxlaw.nts.go.kr/qt/x.do?a=1&amp;b=2"), "https://taxlaw.nts.go.kr/qt/x.do?a=1&b=2");
  assert.equal(normalizeUpstreamLink("/LSW/flDownload.do?flSeq=1"), "https://www.law.go.kr/LSW/flDownload.do?flSeq=1");
  assert.ok(!scrub("x?OC=ZZSECRET9&y=1").includes("ZZSECRET9"));
  assert.ok(!scrub("token ZZSECRET9 here").includes("ZZSECRET9"));
  _setApiKey("");
  assert.equal(lawLink("주택법", "제15조"), "https://www.law.go.kr/법령/%EC%A3%BC%ED%83%9D%EB%B2%95/%EC%A0%9C15%EC%A1%B0");
  assert.equal(decodeEntities("a&amp;b&quot;"), 'a&b"');
});

test("diff: 추가·삭제·동일, 문장 분리", () => {
  assert.deepEqual(diff(["a", "b", "c"], ["a", "c", "d"]), [{ op: "equal", text: "a" }, { op: "del", text: "b" }, { op: "equal", text: "c" }, { op: "add", text: "d" }]);
  assert.ok(diffSentences("제1조 가. 토지를 양도한다.", "제1조 가. 토지를 양도한다.").every((o) => o.op === "equal"));
  assert.ok(diffSentences("① 가나다. ② 라마바.", "① 가나다. ② 라마사.").some((o) => o.op === "add"));
});
