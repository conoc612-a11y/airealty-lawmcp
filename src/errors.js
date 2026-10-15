// 오류 코드(닫힌 목록, SPEC §3.1). 업스트림 원문·키 값은 메시지에 싣지 않는다.
export const CODES = new Set([
  "INVALID_INPUT", "AMBIGUOUS_NAME", "LAW_NOT_FOUND", "ARTICLE_NOT_FOUND", "SOURCE_NOT_FOUND",
  "UPSTREAM_AUTH", "UPSTREAM_FORMAT", "UPSTREAM_UNAVAILABLE", "RATE_LIMITED", "TIMEOUT", "NOT_SUPPORTED", "OUTPUT_PAGED",
]);
const RETRYABLE = new Set(["UPSTREAM_FORMAT", "UPSTREAM_UNAVAILABLE", "RATE_LIMITED", "TIMEOUT"]);

export class LawError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    if (!CODES.has(code)) throw new Error(`unknown error code ${code}`);
    this.code = code;
    this.retryable = extra.retryable ?? RETRYABLE.has(code);
    this.hint = extra.hint;
    this.candidates = extra.candidates;
    this.data = extra.data;
  }
  toJSON() {
    const o = { code: this.code, message: this.message, retryable: this.retryable };
    if (this.hint) o.hint = this.hint;
    if (this.candidates) o.candidates = this.candidates;
    if (this.data) Object.assign(o, this.data);
    return o;
  }
}

export const invalid = (message, hint) => new LawError("INVALID_INPUT", message, { hint });
export const isLawError = (e) => e instanceof LawError;
/** 알 수 없는 예외 → 코드화. 메시지는 짧게, 내부 경로·키 없음. */
export function coerce(e) {
  if (isLawError(e)) return e;
  const msg = String(e?.message || e || "");
  if (/abort|timeout/i.test(msg)) return new LawError("TIMEOUT", "업스트림 응답 시간 초과");
  return new LawError("UPSTREAM_UNAVAILABLE", "업스트림 호출 실패");
}
