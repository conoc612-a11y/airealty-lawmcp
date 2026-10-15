// 응답 봉투 (SPEC §3.1) 와 크기 예산 분할 (§3.2).
import { fmtDate, todayKst } from "./kst.js";
import { scrub } from "./keys.js";
import { coerce } from "./errors.js";

export const SOURCE = "법제처 DRF";

export function ok({ items = [], total = null, page, warnings = [], notes = [], next = [], asOf, cacheState = "miss", upstreamMs = 0, extra = {} }) {
  const body = {
    ok: true,
    total: total == null ? null : total,
    returned: Array.isArray(items) ? items.length : items ? 1 : 0,
    ...(page ? { page } : {}),
    items,
    warnings, notes, next,
    meta: { asOf: fmtDate(asOf || todayKst()), source: SOURCE, cache: cacheState, upstreamMs },
    ...extra,
  };
  return body;
}

export function fail(e, asOf) {
  const err = coerce(e);
  return { ok: false, error: err.toJSON(), meta: { asOf: fmtDate(asOf || todayKst()), source: SOURCE, cache: "miss", upstreamMs: 0 } };
}

/** 봉투 → MCP 결과. 들여쓰기 없이 직렬화, 인증값 최종 제거. */
export function toMcp(body) {
  const text = scrub(JSON.stringify(body));
  return { content: [{ type: "text", text }], ...(body.ok ? {} : { isError: true }) };
}

export const bytesOf = (v) => Buffer.byteLength(typeof v === "string" ? v : JSON.stringify(v), "utf8");

/** 캐시 상태 합성: 전부 hit → hit, 전부 miss → miss, 섞이면 partial. */
export function mergeCache(states) {
  const s = states.filter(Boolean);
  if (!s.length) return "miss";
  if (s.every((x) => x === "hit" || x === true)) return "hit";
  if (s.every((x) => x === "miss" || x === false)) return "miss";
  return "partial";
}

/**
 * 단위 경계 분할: items 를 maxBytes 안에 들어가는 만큼만 part 번째 묶음으로 자른다. 하나의 단위가 예산보다 크면
 * splitUnit(unit) 로 더 작은 단위(항 등)로 나눈다. 반환 {items, part, parts, hasMore, warnings}.
 */
export function paginateByBytes(items, { maxBytes, part = 1, splitUnit, overheadBytes = 1500 }) {
  const budget = Math.max(2000, maxBytes - overheadBytes);
  const units = [];
  for (const it of items) {
    if (bytesOf(it) <= budget || !splitUnit) { units.push(it); continue; }
    units.push(...splitUnit(it, budget));
  }
  const parts = []; let cur = []; let curBytes = 0;
  for (const u of units) {
    const b = bytesOf(u) + 1;
    if (cur.length && curBytes + b > budget) { parts.push(cur); cur = []; curBytes = 0; }
    cur.push(u); curBytes += b;
  }
  if (cur.length || !parts.length) parts.push(cur);
  const p = Math.min(Math.max(1, part), parts.length);
  const warnings = [];
  const splitNotes = [...new Set(units.map((u) => u && u.note).filter(Boolean))];
  if (splitNotes.length) warnings.push(...splitNotes.map((n) => `${n}(응답 예산 ${maxBytes}B)`));
  return { items: parts[p - 1], part: p, parts: parts.length, hasMore: p < parts.length, warnings };
}
