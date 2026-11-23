// 날짜·기간·이자 계산 엔진 — 업스트림 호출 0회(로컬 계산). 근거 조문을 결과에 함께 실는다.
import { parseDate, addDays, fmtDate } from "./kst.js";
import { countWeekdayHolidays, isNonBusinessDay } from "./holidays.js";

function lastDayOfMonth(y, m0) {
  // m0: 1-12
  const d = new Date(Date.UTC(y, m0, 0));
  return d.getUTCDate();
}

/** 대응일 전일 만료(민법 제160조 제2항). 대응일 없으면 만료월 말일(제3항). */
function addMonthsExpiry(startYmd, n) {
  const y = +startYmd.slice(0, 4), m0 = +startYmd.slice(4, 6), day = +startYmd.slice(6, 8);
  const total = (y * 12 + (m0 - 1)) + n;
  const ty = Math.floor(total / 12), tm = (total % 12) + 1;
  const last = lastDayOfMonth(ty, tm);
  const corr = Math.min(day, last); // 대응일(없으면 말일)
  if (corr < day) {
    // 대응일 없음 → 만료월 말일이 만료일
    return { expiry: `${ty}${String(tm).padStart(2, "0")}${String(last).padStart(2, "0")}`, correspondence: null, lastOfMonth: true };
  }
  const corrYmd = `${ty}${String(tm).padStart(2, "0")}${String(corr).padStart(2, "0")}`;
  return { expiry: addDays(corrYmd, -1), correspondence: corrYmd, lastOfMonth: false };
}

/** 만료일이 토·일·공휴일이면 다음 영업일로 민다. */
function rollToBusiness(ymd, extraHolidays) {
  let cur = ymd, hops = 0;
  while (isNonBusinessDay(cur, extraHolidays) && hops < 30) {
    cur = addDays(cur, 1);
    hops++;
  }
  return { rolled: hops > 0, to: cur };
}

/**
 * 기간 만료일 계산.
 * opts: {unit:"days"|"weeks"|"months"|"years", value, includeFirstDay, rollHoliday, extraHolidays}
 */
export function calcDeadline(startYmd, { unit, value, includeFirstDay = false, rollHoliday = false, extraHolidays }) {
  let expiry, correspondence = null, lastOfMonth = false;
  if (unit === "days") expiry = addDays(startYmd, includeFirstDay ? value - 1 : value);
  else if (unit === "weeks") expiry = addDays(startYmd, includeFirstDay ? value * 7 - 1 : value * 7);
  else if (unit === "months" || unit === "years") {
    const n = unit === "years" ? value * 12 : value;
    const firstDay = includeFirstDay ? startYmd : addDays(startYmd, 1);
    const r = addMonthsExpiry(firstDay, n);
    expiry = r.expiry; correspondence = r.correspondence; lastOfMonth = r.lastOfMonth;
    if (unit === "years") correspondence = null; // 년 단위는 대응일만으로 충분
  } else throw new Error("INVALID_UNIT");
  let rolled = null;
  if (rollHoliday) {
    const r = rollToBusiness(expiry, extraHolidays);
    if (r.rolled) rolled = r.to;
  }
  return { expiry, correspondence, lastOfMonth, rolled };
}

/** 기간 일수: 초일 산입 여부 + 영업일 옵션. */
export function calcDaysBetween(startYmd, endYmd, { includeFirstDay = false, businessOnly = false, extraHolidays }) {
  const s = new Date(Date.UTC(+startYmd.slice(0, 4), +startYmd.slice(4, 6) - 1, +startYmd.slice(6, 8)));
  const e = new Date(Date.UTC(+endYmd.slice(0, 4), +endYmd.slice(4, 6) - 1, +endYmd.slice(6, 8)));
  if (e < s) return null;
  const calendar = (e - s) / 86400000 + (includeFirstDay ? 1 : 0);
  if (!businessOnly) return { calendar, business: null };
  if (!calendar) return { calendar, business: 0 };
  const startWeekday = (s.getUTCDay() + (includeFirstDay ? 0 : 1)) % 7;
  let business = Math.floor(calendar / 7) * 5;
  for (let i = 0; i < calendar % 7; i++) {
    const weekday = (startWeekday + i) % 7;
    if (weekday !== 0 && weekday !== 6) business++;
  }
  const firstDay = includeFirstDay ? startYmd : addDays(startYmd, 1);
  business -= countWeekdayHolidays(firstDay, endYmd, extraHolidays);
  return { calendar, business };
}

/** 지연손해금: 원본×이율×일수/기준일수. formula 를 문자열로 함께 돌려준다. */
export function calcInterest(principal, annualRatePct, startYmd, endYmd, { includeFirstDay = false, basis = 365, extraHolidays }) {
  const days = calcDaysBetween(startYmd, endYmd, { includeFirstDay, businessOnly: false });
  if (!days) return null;
  const interest = Math.round(principal * (annualRatePct / 100) * days.calendar / basis);
  const formula = `${principal.toLocaleString("ko-KR")}원 × ${annualRatePct}% ÷ 100 × ${days.calendar}일 ÷ ${basis}일 = ${interest.toLocaleString("ko-KR")}원`;
  return { days: days.calendar, interest, formula, basis };
}

/** 근거 조문 목록(계산 방식별). */
export function citationsFor(mode, unit) {
  const base = [{ law: "민법", article: "제157조", title: "기간의 기산점" }];
  if (mode === "deadline") {
    base.push({ law: "민법", article: "제159조", title: "기간의 만료점" });
    if (unit !== "days") base.push({ law: "민법", article: "제160조", title: "역에 의한 계산" });
    base.push({ law: "민법", article: "제161조", title: "공휴일 등과 기간의 만료점" },
      { law: "민사소송법", article: "제170조", title: "기간의 계산" });
  }
  if (mode === "interest") {
    base.push({ law: "민법", article: "제379조", title: "법정이율" },
      { law: "민법", article: "제397조", title: "금전채무불이행에 대한 특칙" },
      { law: "상법", article: "제54조", title: "상사법정이율" },
      { law: "이자제한법", article: "제2조", title: "이자의 최고한도" });
  }
  return base;
}

export { fmtDate, parseDate };
