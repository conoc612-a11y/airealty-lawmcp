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

/** {hit, stale} → 봉투 cache 값. 업스트림 실패 후 만료 캐시로 답한 호출은 "stale". */
export const cacheState = (r) => (r && r.stale ? "stale" : r && r.hit ? "hit" : "miss");

/** 캐시 상태 합성: 전부 hit → hit, 하나라도 stale(만료 캐시 폴백) → stale, 전부 miss → miss, 섞이면 partial. */
export function mergeCache(states) {
  const s = states.filter(Boolean);
  if (!s.length) return "miss";
  if (s.every((x) => x === "hit" || x === true)) return "hit";
  if (s.some((x) => x === "stale")) return "stale";
  if (s.every((x) => x === "miss" || x === false)) return "miss";
  return "partial";
}

/**
 * 단위 경계 분할: items 를 maxBytes 안에 들어가는 만큼만 part 번째 묶음으로 자른다. 하나의 단위가 예산보다 크면
 * splitUnit(unit) 로 더 작은 단위(항 등)로 나눈다. 반환 {items, part, parts, hasMore, warnings}.
 */
export function paginateByBytes(items, { maxBytes, part = 1, splitUnit, overheadBytes = 1500 }) {
  const budget = Math.max(2000, maxBytes - overheadBytes);
  const parts = [[]];
  const notes = new Set();
  let page = parts[0], used = 0;
  function append(unit, bytes) {
    if (page.length && used + bytes + 1 > budget) {
      page = [];
      parts.push(page);
      used = 0;
    }
    page.push(unit);
    used += bytes + 1;
    if (unit?.note) notes.add(unit.note);
  }
  for (const item of items) {
    const size = bytesOf(item);
    if (size > budget && splitUnit) {
      for (const piece of splitUnit(item, budget)) append(piece, bytesOf(piece));
    } else {
      append(item, size);
    }
  }
  const p = Math.min(Math.max(1, part), parts.length);
  const warnings = [...notes].map(note => `${note}(응답 예산 ${maxBytes}B)`);
  return { items: parts[p - 1], part: p, parts: parts.length, hasMore: p < parts.length, warnings };
}
