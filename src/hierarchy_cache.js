// 체계도(lsStmd, 업스트림 ~7초) 요약과 관련법령(lsRlt) 행의 디스크 캐시 — 7일, 만료 뒤엔 옛 값을 먼저 쓰고 뒤에서 갱신(stale-while-revalidate).
// 원본 JSON 이 아니라 statute_outline 이 쓰는 요약만 둔다(작고, 키 없음). 요약 규칙이 바뀌면 VERSION 을 올린다.
import { call } from "./drf.js";
import { service, search, asList, unwrapList } from "./upstream.js";
import { TTL } from "./cache.js";
import { readDisk, writeDisk } from "./diskcache.js";

export const HIERARCHY_TTL = 7 * 24 * 3600 * 1000;
const BUCKET = "hierarchy";
export const VERSION = 1;
const refreshing = new Map();

export function keyOf({ lawId, mst }) { return `${lawId || "x"}_${mst || "x"}`; }

/** 디스크에서 {tree, related, savedAt, stale} | null. */
export function readHierarchy({ lawId, mst }, now = Date.now()) {
  const d = readDisk(BUCKET, keyOf({ lawId, mst }), now);
  if (!d || d.value?.v !== VERSION) return null;
  return { tree: d.value.tree, related: d.value.related || [], savedAt: d.savedAt, stale: d.ageMs >= HIERARCHY_TTL };
}

export function writeHierarchy({ lawId, mst }, { tree, related }, now = Date.now()) {
  return writeDisk(BUCKET, keyOf({ lawId, mst }), { v: VERSION, tree: tree || null, related: related || [] }, now);
}

export function hasFreshHierarchy({ lawId, mst }, now = Date.now()) { const h = readHierarchy({ lawId, mst }, now); return !!(h && !h.stale && h.tree); }

/**
 * 업스트림에서 체계도·관련법령을 받아 요약하고 디스크에 쓴다. summarize(data) 는 statute_outline 의 요약 함수.
 * background=true 면 전경 요청에 양보한다(예열·SWR 갱신). 체계도가 실패해도 관련법령만으로 기록한다(tree:null).
 */
export function refreshHierarchy({ lawId, mst }, summarize, { background = false } = {}) {
  const key = keyOf({ lawId, mst });
  if (refreshing.has(key)) return refreshing.get(key);
  const p = (async () => {
    let stmd = null, related = [];
    if (background) {
      const [s, r] = await Promise.allSettled([
        call("lawService.do", { target: "lsStmd", MST: mst }, { long: true, background: true }),
        call("lawSearch.do", { target: "lsRlt", ID: lawId }, { background: true }),
      ]);
      if (s.status === "fulfilled") stmd = s.value;
      if (r.status === "fulfilled") related = relatedRows(unwrapList(r.value, ["법령"]).rows);
    } else {
      const [s, r] = await Promise.allSettled([
        service("lsStmd", { MST: mst }, { ttl: TTL.body, long: true }),
        search("lsRlt", { ID: lawId }, { rowKeys: ["법령"], ttl: TTL.body }),
      ]);
      if (s.status === "fulfilled") stmd = s.value.data;
      if (r.status === "fulfilled") related = relatedRows(r.value.rows);
    }
    const tree = stmd ? summarize(stmd) : null;
    if (tree || related.length) writeHierarchy({ lawId, mst }, { tree, related });
    return { tree, related };
  })().finally(() => refreshing.delete(key));
  refreshing.set(key, p);
  return p;
}

/** lsRlt 행 → [{name, lawId, relation, relationCode}] (statute_outline hierarchy·related 가 쓰는 최소 필드). */
export function relatedRows(rows) {
  const s = (v) => (v == null ? "" : typeof v === "object" ? (v.content ?? "") : String(v)).trim();
  return asList(rows?.[0]?.["관련법령"]).map((x) => ({ name: s(x["관련법령명"]), lawId: s(x["관련법령ID"]), relation: s(x["법령간관계"]), relationCode: s(x["법령간관계코드"]) })).filter((x) => x.name);
}
