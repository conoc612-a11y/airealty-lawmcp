// 날짜 — 입력 4형식 허용, 내부는 YYYYMMDD 문자열, 출력은 YYYY-MM-DD. 기준일 기본값은 KST 오늘(SPEC §3.3).
const KST_OFFSET_MS = 9 * 3600 * 1000;

/** KST 기준 오늘 YYYYMMDD. 서버 시간대와 무관. */
export function todayKst(now = Date.now()) {
  const d = new Date(now + KST_OFFSET_MS);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** 다음 KST 자정까지 남은 ms(이름 해석 캐시 만료용). */
export function msUntilKstMidnight(now = Date.now()) {
  const d = new Date(now + KST_OFFSET_MS);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return next - (now + KST_OFFSET_MS);
}

/** "20260101" | "2026-01-01" | "2026.01.01" | "2026. 1. 1." → "20260101". 아니면 null. */
export function parseDate(input) {
  if (input == null || input === "") return null;
  const s = String(input).trim();
  let m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!m) m = s.match(/^(\d{4})\s*[-.\/]\s*(\d{1,2})\s*[-.\/]\s*(\d{1,2})\s*\.?$/);
  if (!m) return null;
  const y = +m[1], mo = +m[2], da = +m[3];
  if (mo < 1 || mo > 12 || da < 1 || da > 31) return null;
  const chk = new Date(Date.UTC(y, mo - 1, da));
  if (chk.getUTCMonth() !== mo - 1 || chk.getUTCDate() !== da) return null;
  return `${y}${String(mo).padStart(2, "0")}${String(da).padStart(2, "0")}`;
}

/** YYYYMMDD(또는 다른 허용 형식) → "YYYY-MM-DD". 빈 값은 null. */
export function fmtDate(v) {
  const d = parseDate(v);
  return d ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : null;
}

/** 기준일 인자 처리: 없으면 오늘(KST), 있으면 검증. 잘못되면 null 반환(호출자가 INVALID_INPUT). */
export function asOf(input) {
  if (input == null || input === "") return todayKst();
  return parseDate(input);
}

/** YYYYMMDD 에 일수를 더한다. */
export function addDays(ymd, n) {
  const d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8) + n));
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
}
