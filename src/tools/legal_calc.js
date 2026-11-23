// legal_calc — 기간 만료일·일수·지연손해금 계산(로컬 계산, 업스트림 0회). 계산식과 근거 조문을 함께 돌려준다.
// 공휴일은 내장표(2025~2027)+사용자 보충(extraHolidays). 임시공휴일·개정 누락 가능성을 notes 로 경고한다.
import { defineTool, ok, z } from "../tool.js";
import { invalid } from "../errors.js";
import { parseDate, fmtDate } from "../kst.js";
import { holidayName, isNonBusinessDay } from "../holidays.js";
import { calcDeadline, calcDaysBetween, calcInterest, citationsFor } from "../legalcalc.js";

const extraSet = (arr) => {
  const s = new Set();
  for (const raw of arr || []) {
    const d = parseDate(raw);
    if (d) s.add(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`);
  }
  return s;
};

export default defineTool({
  name: "legal_calc",
  description:
    "기간 만료일·기간 일수·지연손해금을 계산식과 근거 조문과 함께 돌려준다(로컬 계산 — 법제처 API 호출 없음). " +
    "민법 제157조·제159조~제161조에 따라 기간을 계산하고, 만료일이 토·일·공휴일이면 다음 영업일을 함께 산출하는 옵션이 있다.",
  catalog: { summary: "기간 만료일·일수·이자 계산(계산식·근거 조문 출력)", tags: ["계산", "기간", "이자", "만료일"], example: { mode: "deadline", start: "2026-11-01", value: 1, unit: "months" } },
  schema: {
    mode: z.enum(["deadline", "days_between", "interest"]).describe("deadline 만료일 · days_between 기간 일수 · interest 지연손해금"),
    start: z.string().min(1).max(12).describe("기간 계산의 기준일(YYYY-MM-DD 등 4형식)"),
    end: z.string().max(12).optional().describe("종료일(days_between·interest)"),
    value: z.number().int().min(1).max(9999).optional().describe("기간 수(deadline)"),
    unit: z.enum(["days", "weeks", "months", "years"]).optional().describe("기간 단위(deadline)"),
    includeFirstDay: z.boolean().optional().describe("초일 산입(기본 false, 민법 제157조)"),
    rollHoliday: z.boolean().optional().describe("토·일·공휴일인 만료일에 다음 영업일도 반환(기본 false)"),
    businessOnly: z.boolean().optional().describe("days_between 에서 영업일수도 계산(기본 false)"),
    principal: z.number().min(1).optional().describe("원본(원) — interest"),
    annualRatePct: z.number().min(0).max(40).optional().describe("연 이율 %(interest) — 미지정 시 5%(민법 제379조)"),
    basis: z.number().int().min(300).max(370).optional().describe("일수 기준(기본 365)"),
    extraHolidays: z.array(z.string().max(12)).max(50).optional().describe("내장표에 없는 공휴일(YYYY-MM-DD) — 임시공휴일 등"),
  },
  async handler(a) {
    const start = parseDate(a.start);
    if (!start) throw invalid("start 형식 오류(YYYY-MM-DD 등 4형식)");
    const extra = extraSet(a.extraHolidays);
    const notes = [
      "공휴일은 내장표(2025~2027) 기준 — 임시공휴일·개정이 반영되지 않을 수 있으니 확정 전 공휴일을 다시 확인하세요(extraHolidays 로 보충 가능)",
      "결과는 기계 계산 참고값 — 기일 확정과 법적 판단은 담당 변호사가 해야 합니다",
    ];
    const warnings = [];

    if (a.mode === "deadline") {
      if (!a.value || !a.unit) throw invalid("deadline 은 value·unit 필요");
      const r = calcDeadline(start, { unit: a.unit, value: a.value, includeFirstDay: !!a.includeFirstDay, rollHoliday: !!a.rollHoliday, extraHolidays: extra });
      const items = [{
        start: fmtDate(start),
        value: a.value,
        unit: a.unit,
        includeFirstDay: !!a.includeFirstDay,
        expiry: fmtDate(r.expiry),
        rollHoliday: !!a.rollHoliday,
        ...(r.correspondence ? { correspondence: fmtDate(r.correspondence) } : {}),
        ...(r.lastOfMonth ? { note: "대응일이 없어 만료월 말일에 만료(민법 제160조 제3항)" } : {}),
        ...(r.rolled ? { rolledTo: fmtDate(r.rolled), rollReason: holidayName(r.expiry, extra) || (isNonBusinessDay(r.expiry, extra) ? "토·일" : "") } : {}),
        citations: citationsFor("deadline", a.unit),
      }];
      if (a.includeFirstDay) notes.push("초일 산입 옵션 적용. 민법 제157조 단서에 따르면 오전 0시부터 시작하는 기간은 초일을 산입합니다");
      if (r.rolled) warnings.push("기간 말일이 토요일 또는 공휴일이므로 민법 제161조에 따라 연장한 날짜를 rolledTo에 표시했습니다");
      return ok({ items, total: 1, warnings, notes });
    }

    if (a.mode === "days_between") {
      const end = parseDate(a.end || "");
      if (!end) throw invalid("days_between 은 end 필요");
      const r = calcDaysBetween(start, end, { includeFirstDay: !!a.includeFirstDay, businessOnly: !!a.businessOnly, extraHolidays: extra });
      if (!r) throw invalid("end 가 start 보다 앞섬");
      const items = [{
        start: fmtDate(start),
        end: fmtDate(end),
        includeFirstDay: !!a.includeFirstDay,
        calendarDays: r.calendar,
        ...(r.business != null ? { businessDays: r.business } : {}),
        citations: citationsFor("days_between"),
      }];
      return ok({ items, total: 1, warnings, notes });
    }

    // interest
    const end = parseDate(a.end || "");
    if (!end) throw invalid("interest 는 end 필요");
    if (!a.principal) throw invalid("interest 는 principal 필요");
    const rate = a.annualRatePct ?? 5;
    const basis = a.basis ?? 365;
    const r = calcInterest(a.principal, rate, start, end, { includeFirstDay: !!a.includeFirstDay, basis, extraHolidays: extra });
    if (!r) throw invalid("end 가 start 보다 앞섬");
    const items = [{
      start: fmtDate(start),
      end: fmtDate(end),
      principal: a.principal,
      annualRatePct: rate,
      rateSource: a.annualRatePct == null ? "민법 제379조의 연 5% 적용" : "사용자 지정",
      days: r.days,
      basis,
      interest: r.interest,
      formula: r.formula,
      citations: citationsFor("interest"),
    }];
    notes.push("민사 법정이율은 연 5%(민법 제379조), 상사 법정이율은 연 6%(상법 제54조)입니다. 개별 법령, 약정 및 판결에 따라 적용 이율이 달라집니다");
    if (rate > 20) warnings.push("입력 이율이 현행 금전대차 약정의 최고이자율 연 20%를 넘습니다. 계약 체결·갱신일과 적용 법령을 확인하세요");
    return ok({ items, total: 1, warnings, notes });
  },
});
