// DRF 응답을 캐시와 함께 쓰는 얇은 래퍼. 응답의 흔들림(배열/단일객체/없음)을 여기서 흡수한다.
import { call, requestKey } from "./drf.js";
import { cache, TTL } from "./cache.js";
import { fmtDate } from "./kst.js";

/** 값이 배열이면 그대로, 객체면 [객체], 없으면 []. */
export const asList = (v) => (Array.isArray(v) ? v : v == null || v === "" ? [] : [v]);
export const str = (v) => (v == null ? "" : typeof v === "object" ? (v.content ?? "") : String(v)).trim();
export const digits = (v) => str(v).replace(/\D/g, "");
export const toInt = (v) => { const n = parseInt(digits(v), 10); return Number.isFinite(n) ? n : null; };

/**
 * 목록 응답 {Root:{rows..., totalCnt, page}} → {rows, total, page}. root 키는 target 마다 다르므로 첫 객체값을 쓴다.
 */
export function unwrapList(data, rowKeys) {
  const root = data && typeof data === "object" ? Object.values(data).find((v) => v && typeof v === "object") : null;
  if (!root) return { rows: [], total: null, page: 1 };
  let rows = [];
  for (const k of rowKeys || []) if (root[k] != null) { rows = asList(root[k]); break; }
  if (!rows.length && !rowKeys) for (const v of Object.values(root)) if (Array.isArray(v)) { rows = v; break; }
  const total = toInt(root.totalCnt ?? root["검색결과개수"]);
  return { rows, total: total ?? (rows.length ? rows.length : 0), page: toInt(root.page) || 1 };
}

/** 캐시 거쳐 호출. meta.cache 를 호출자가 알 수 있게 {data, hit} 로. */
export async function cached(path, params, ttl, opts = {}) {
  const key = "drf:" + requestKey(path, params);
  const hit = cache.get(key);
  if (hit !== undefined) return { data: hit, hit: true };
  const data = await call(path, params, opts);
  cache.set(key, data, ttl);
  return { data, hit: false };
}

/** lawSearch.do 목록. */
export async function search(target, params, { ttl = TTL.list, rowKeys, long } = {}) {
  const { data, hit } = await cached("lawSearch.do", { target, ...params }, ttl, { long });
  return { ...unwrapList(data, rowKeys), hit, raw: data };
}

/** lawService.do 본문. */
export async function service(target, params, { ttl = TTL.body, long } = {}) {
  return cached("lawService.do", { target, ...params }, ttl, { long });
}

/** 목록 행의 공통 법령 메타 정리. */
export function lawRow(r) {
  return {
    name: str(r["법령명한글"] || r["법령명"]),
    kind: str(r["법령구분명"] || r["법종구분"]),
    lawId: str(r["법령ID"]),
    mst: str(r["법령일련번호"]),
    promulgationDate: fmtDate(r["공포일자"]),
    promulgationNo: str(r["공포번호"]),
    effectiveDate: fmtDate(r["시행일자"]),
    revision: str(r["제개정구분명"]),
    department: str(r["소관부처명"]),
    statusCode: str(r["현행연혁코드"]),
    abbreviation: str(r["법령약칭명"]),
  };
}
