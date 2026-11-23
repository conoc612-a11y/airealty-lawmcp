// 월력요항과 관공서의 공휴일에 관한 규정 기준(2025~2027), 대체공휴일 포함.
// 임시공휴일·개정은 반영되지 않을 수 있으므로 계산 결과에 항상 재확인 노트를 단다(legal_calc notes).
// 형식: { "YYYY-MM-DD": 이름 }

const HOLIDAYS = {
  // 2025
  "2025-01-01": "신정",
  "2025-01-27": "임시공휴일",
  "2025-01-28": "설날 전날",
  "2025-01-29": "설날",
  "2025-01-30": "설날 다음 날",
  "2025-03-01": "삼일절",
  "2025-03-03": "대체공휴일(삼일절)",
  "2025-05-05": "어린이날·부처님오신날",
  "2025-05-06": "대체공휴일(부처님오신날)",
  "2025-06-03": "제21대 대통령 선거",
  "2025-06-06": "현충일",
  "2025-08-15": "광복절",
  "2025-10-03": "개천절",
  "2025-10-05": "추석 전날",
  "2025-10-06": "추석",
  "2025-10-07": "추석 다음 날",
  "2025-10-08": "대체공휴일(추석)",
  "2025-10-09": "한글날",
  "2025-12-25": "기독탄신일",
  // 2026
  "2026-01-01": "신정",
  "2026-02-16": "설날 전날",
  "2026-02-17": "설날",
  "2026-02-18": "설날 다음 날",
  "2026-03-01": "삼일절",
  "2026-03-02": "대체공휴일(삼일절)",
  "2026-05-01": "노동절",
  "2026-05-05": "어린이날",
  "2026-05-24": "부처님오신날",
  "2026-05-25": "대체공휴일(부처님오신날)",
  "2026-06-03": "전국동시지방선거",
  "2026-06-06": "현충일",
  "2026-07-17": "제헌절",
  "2026-08-15": "광복절",
  "2026-08-17": "대체공휴일(광복절)",
  "2026-09-24": "추석 전날",
  "2026-09-25": "추석",
  "2026-09-26": "추석 다음 날",
  "2026-10-03": "개천절",
  "2026-10-05": "대체공휴일(개천절)",
  "2026-10-09": "한글날",
  "2026-12-25": "기독탄신일",
  // 2027 (우주항공청 공고 제2026-0078호)
  "2027-01-01": "신정",
  "2027-02-06": "설날 전날",
  "2027-02-07": "설날",
  "2027-02-08": "설날 다음 날",
  "2027-02-09": "대체공휴일(설날)",
  "2027-03-01": "삼일절",
  "2027-05-01": "노동절",
  "2027-05-03": "대체공휴일(노동절)",
  "2027-05-05": "어린이날",
  "2027-05-13": "부처님오신날",
  "2027-06-06": "현충일",
  "2027-07-17": "제헌절",
  "2027-07-19": "대체공휴일(제헌절)",
  "2027-08-15": "광복절",
  "2027-08-16": "대체공휴일(광복절)",
  "2027-09-14": "추석 전날",
  "2027-09-15": "추석",
  "2027-09-16": "추석 다음 날",
  "2027-10-03": "개천절",
  "2027-10-04": "대체공휴일(개천절)",
  "2027-10-09": "한글날",
  "2027-10-11": "대체공휴일(한글날)",
  "2027-12-25": "기독탄신일",
  "2027-12-27": "대체공휴일(기독탄신일)",
};

const HOLIDAY_SET = new Set(Object.keys(HOLIDAYS));

/** "20260101" → "2026-01-01" */
function dashed(ymd) {
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
}

/** 공휴일이면 이름, 아니면 null. extraHolidays 는 "YYYY-MM-DD" 또는 "YYYYMMDD" 집합. */
export function holidayName(ymd, extraHolidays) {
  const d = dashed(ymd);
  if (HOLIDAY_SET.has(d)) return HOLIDAYS[d];
  if (extraHolidays?.has(d) || extraHolidays?.has(ymd)) return "사용자 지정 공휴일";
  return null;
}

function isWeekday(date) {
  const day = new Date(date + "T00:00:00Z").getUTCDay();
  return day >= 1 && day <= 5;
}

const WEEKDAY_HOLIDAYS = [...HOLIDAY_SET].filter(isWeekday);

/** 시작일·종료일을 포함해 평일에 해당하는 공휴일만 센다. */
export function countWeekdayHolidays(startYmd, endYmd, extraHolidays) {
  const start = dashed(startYmd), end = dashed(endYmd);
  const within = (date) => date >= start && date <= end;
  let total = 0;
  for (const date of WEEKDAY_HOLIDAYS) if (within(date)) total++;
  if (!extraHolidays?.size) return total;
  const counted = new Set();
  for (const input of extraHolidays) {
    const date = input.length === 8 ? dashed(input) : input;
    if (within(date) && !HOLIDAY_SET.has(date) && !counted.has(date) && isWeekday(date)) counted.add(date);
  }
  return total + counted.size;
}

/** 토요일 또는 공휴일인가(영업일 판정용). */
export function isNonBusinessDay(ymd, extraHolidays) {
  const t = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)));
  const dow = t.getUTCDay(); // 0=일 6=토
  return dow === 0 || dow === 6 || !!holidayName(ymd, extraHolidays);
}
