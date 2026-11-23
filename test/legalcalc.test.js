// legal_calc 엔진 단위 테스트 — 업스트림 없이 순수 계산만 검증.
import { test } from "node:test";
import assert from "node:assert/strict";
import { calcDeadline, calcDaysBetween, calcInterest, citationsFor } from "../src/legalcalc.js";
import { holidayName, isNonBusinessDay } from "../src/holidays.js";
import { casenoShape } from "./fixtures/caseno_shape.js";

test("만료일 — 일 단위, 초일 불산입(민법 제157조)", () => {
  // 2026-01-01 부 30일 → 초일 불산입 1/31 만료
  const r = calcDeadline("20260101", { unit: "days", value: 30 });
  assert.equal(r.expiry, "20260131");
  const r2 = calcDeadline("20260101", { unit: "days", value: 30, includeFirstDay: true });
  assert.equal(r2.expiry, "20260130");
});

test("만료일 — 월 단위, 초일 산입 여부와 대응일(민법 제160조)", () => {
  const r = calcDeadline("20260115", { unit: "months", value: 1 });
  assert.equal(r.expiry, "20260215"); // 기산일 1/16, 대응일 2/16
  assert.equal(r.correspondence, "20260216");
  assert.equal(r.lastOfMonth, false);
  assert.equal(calcDeadline("20260115", { unit: "months", value: 1, includeFirstDay: true }).expiry, "20260214");
  assert.equal(calcDeadline("20260228", { unit: "years", value: 1 }).expiry, "20270228");
});

test("만료일 — 대응일이 없으면 만료월 말일", () => {
  const r = calcDeadline("20260130", { unit: "months", value: 1 });
  assert.equal(r.expiry, "20260228"); // 2026년 2월 말일
  assert.equal(r.lastOfMonth, true);
  assert.equal(r.correspondence, null);
});

test("만료일 — 휴일 민기(rollHoliday): 설날 연휴를 넘긴다", () => {
  // 2026-02-14 + 1일 = 2026-02-15(일요일) → 2/16(설 전날·월) → 2/17(설) → 2/18(설 다음날) → 2/19
  const r = calcDeadline("20260214", { unit: "days", value: 1, rollHoliday: true });
  assert.equal(r.rolled, "20260219");
  // 민기 없이면 원래 만료일
  const r0 = calcDeadline("20260214", { unit: "days", value: 1 });
  assert.equal(r0.expiry, "20260215");
  assert.equal(r0.rolled, null);
});

test("공휴일 판정 — 토요일과 내장표", () => {
  assert.ok(isNonBusinessDay("20260117")); // 토요일
  assert.ok(isNonBusinessDay("20260101")); // 신정
  assert.equal(holidayName("20260217"), "설날");
  assert.equal(holidayName("20260220"), null);
  assert.ok(isNonBusinessDay("20260603")); // 전국동시지방선거
  assert.ok(isNonBusinessDay("20260916", new Set(["20260916"])));
  assert.ok(isNonBusinessDay("20270209")); // 설날 대체공휴일
  assert.equal(holidayName("20270607"), null);
});

test("일수 계산 — 초일 산입 옵션과 영업일수", () => {
  const r = calcDaysBetween("20260101", "20260110", { includeFirstDay: false });
  assert.equal(r.calendar, 9);
  const r2 = calcDaysBetween("20260101", "20260110", { includeFirstDay: true, businessOnly: true });
  assert.equal(r2.calendar, 10);
  // 2026-01-01(목·신정) ~ 01-10(토): 불산입 영업일 = 1/2(금) + 1/5~1/9(월~금) = 6일
  assert.equal(r2.business, 6);
});

test("영업일수 off-by-one 회귀 — 종료일이 영업일이면 반드시 센다(불산입)", () => {
  // 1/1(목·신정) ~ 1/2(금): 불산입 기간은 1/2 하루 — 영업일 1
  const r = calcDaysBetween("20260101", "20260102", { includeFirstDay: false, businessOnly: true });
  assert.equal(r.calendar, 1);
  assert.equal(r.business, 1);
  // 산입이면 1/1(공휴일) 포함 → 영업일 1(1/2만)
  const r2 = calcDaysBetween("20260101", "20260102", { includeFirstDay: true, businessOnly: true });
  assert.equal(r2.business, 1);
});

test("영업일수 — 주말과 중복 공휴일은 한 번만 차감한다", () => {
  const extraHolidays = new Set(["2026-06-03", "2026-06-04", "20260604", "2026-06-06"]);
  assert.deepEqual(calcDaysBetween("20260601", "20260614", { includeFirstDay: true, businessOnly: true, extraHolidays }), {
    calendar: 14, business: 8,
  });
});

test("지연손해금 — 계산식과 금액", () => {
  const r = calcInterest(10_000_000, 5, "20260101", "20260131", { basis: 365 });
  // 30일 × 10,000,000 × 5% ÷ 365 = 41,095.89 → 41,096
  assert.equal(r.days, 30);
  assert.equal(r.interest, 41096);
  assert.ok(r.formula.includes("10,000,000"));
  assert.ok(r.formula.includes("41,096"));
});

test("근거 조문 — 모드별 조문이 붙는다", () => {
  const d = citationsFor("deadline", "months").map((c) => c.article);
  assert.deepEqual(d, ["제157조", "제159조", "제160조", "제161조", "제170조"]);
  const i = citationsFor("interest").map((c) => c.article);
  assert.ok(i.includes("제379조") && i.includes("제397조") && i.includes("제54조"));
});

test("사건번호 형식 규칙 샘플(불변 데이터 검사)", () => {
  // casenos.js 체계와 계약: 형식 통과/기각 표본과 텍스트 추출이 규칙과 일치해야 한다
  const err = casenoShape.selfcheck();
  assert.equal(err, null, err || undefined);
});
