// source_search — 판례·결정례·해석례·심판례·행정규칙·자치법규·조약 등 법령 외 원천 검색 단일 창구 (SPEC §4.6).
import { defineTool, ok, z, S } from "../tool.js";
import { SOURCES, SOURCE_NAMES } from "../sources.js";
import { search } from "../upstream.js";
import { parseDate } from "../kst.js";
import { invalid, isLawError } from "../errors.js";
import { mergeCache } from "../envelope.js";

const sourceEnum = z.enum(SOURCE_NAMES);

/** 한 원천 검색. 반환 {source, total, items, hit, notes[]} 또는 throw. */
export async function searchSource(source, a) {
  const def = SOURCES[source];
  const sup = def.list.supports;
  const notes = [];
  const params = { display: a.size, page: a.page };
  if (a.query) params.query = a.query; else if (!sup.allowEmptyQuery) throw invalid(`${source} 는 query 가 필요합니다`);
  if (a.field === "body") { if (sup.body) params.search = 2; else notes.push(`${source}: 본문 검색 미지원 — 제목 검색으로 대신`); }
  const sortCode = sup.sort?.[a.sort];
  // 세무 해석·조세심판은 업스트림 기본 순서가 제목순(1980~90년대가 앞)이라 relevance 요청도 최신순으로 받는다(실호출 2026-10-13: sort=ddes 지원)
  const dateDefault = a.sort === "relevance" && (source === "tax_ruling" || source === "tax_tribunal") && sup.sort?.date_desc;
  if (dateDefault) { params.sort = sup.sort.date_desc; notes.push(`${source}: 기본 정렬 최신순(날짜 내림차순)`); }
  else if (a.sort !== "relevance") { if (sortCode) params.sort = sortCode; else notes.push(`${source}: 정렬 ${a.sort} 미지원 — 무시됨`); }
  if (a.court) { if (sup.court) params[sup.court] = a.court; else notes.push(`${source}: court 필터 미지원 — 무시됨`); }
  if (a.org) { if (sup.org) params[sup.org] = a.org; else notes.push(`${source}: org 필터 미지원 — 무시됨`); }
  if (a.region) { if (sup.region) params[sup.region] = a.region; else notes.push(`${source}: region 필터 미지원 — 무시됨`); }
  if (a.dateFrom || a.dateTo) {
    const f = a.dateFrom ? parseDate(a.dateFrom) : null, t = a.dateTo ? parseDate(a.dateTo) : null;
    if ((a.dateFrom && !f) || (a.dateTo && !t)) throw invalid("dateFrom/dateTo 형식 오류");
    if (sup.date) params[sup.date] = `${f || "19000101"}~${t || "29991231"}`; else notes.push(`${source}: 날짜 필터 미지원 — 무시됨`);
  }
  if (source === "precedent") notes.push("kind 생략 = 판결");
  const r = await search(def.list.target, params, { rowKeys: def.list.rowKeys });
  let items = r.rows.map((row) => ({ source, ...def.row(row) }));
  // relevance: 업스트림 기본 순서 + 제목 정확 포함 가산(안정 정렬)
  if (a.sort === "relevance" && a.query && !dateDefault) {
    const q = a.query.replace(/\s+/g, "");
    items = items.map((it, i) => ({ it, i, s: (it.title || "").replace(/\s+/g, "").includes(q) ? 1 : 0 })).sort((x, y) => y.s - x.s || x.i - y.i).map((x) => x.it);
  }
  for (const it of items) {
    if (it.dataSource && (it.dataSource === it.court || it.dataSource === "대법원")) delete it.dataSource;
    if (source === "precedent" && it.kind === "판결") delete it.kind; // 기본값 생략(notes 에 명시)
    for (const k of Object.keys(it)) if (it[k] === undefined || it[k] === "" || it[k] === null) delete it[k];
  }
  return { source, total: r.total, items, hit: r.hit, notes };
}

export default defineTool({
  name: "source_search",
  description: "판례·헌재결정·조세심판·행정심판·법령해석(법제처·국세청·관세청)·위원회 결정문·행정규칙·자치법규·조약·영문법령 등 법령 외 원천을 검색해 전체 건수·ID·사건번호·일자·링크를 돌려준다.",
  schema: {
    source: z.union([sourceEnum, z.array(sourceEnum).min(1).max(4)]).describe("원천(배열이면 최대 4개 병렬)"),
    query: z.string().min(1).max(200).optional(),
    field: z.enum(["title", "body"]).default("title"),
    court: z.string().max(40).optional(), org: z.string().max(40).optional(), region: z.string().max(40).optional(),
    dateFrom: z.string().max(12).optional(), dateTo: z.string().max(12).optional(),
    sort: z.enum(["relevance", "date_desc", "date_asc"]).default("relevance"),
    page: S.page, size: S.size(20),
  },
  async handler(a) {
    const sources = Array.isArray(a.source) ? [...new Set(a.source)] : [a.source];
    const warnings = [], notes = [];
    const results = await Promise.all(sources.map((s) => searchSource(s, a).then((r) => r, (e) => ({ source: s, error: e }))));
    const nextFor = (it) => (SOURCES[it.source].body ? { tool: "source_get", args: { source: it.source, id: it.id }, why: `${it.title?.slice(0, 40) || it.id} 본문` } : null);
    if (sources.length === 1) {
      const r = results[0];
      if (r.error) throw r.error;
      notes.push(...r.notes);
      const hasMore = r.total != null ? a.page * a.size < r.total : r.items.length === a.size;
      const next = [];
      if (r.items[0] && nextFor(r.items[0])) next.push(nextFor(r.items[0]));
      if (hasMore) next.push({ tool: "source_search", args: { source: r.source, query: a.query, page: a.page + 1, size: a.size, field: a.field, sort: a.sort }, why: "다음 페이지" });
      const items = r.items.map(({ source, ...rest }) => rest); // 단일 원천: 항목마다 source 를 반복하지 않고 봉투에 한 번
      return ok({ items, total: r.total, page: { no: a.page, size: a.size, hasMore }, warnings, notes, cacheState: r.hit ? "hit" : "miss", next, extra: { source: r.source } });
    }
    const groups = results.map((r) => {
      if (r.error) { const e = isLawError(r.error) ? r.error.toJSON() : { code: "UPSTREAM_UNAVAILABLE", message: "검색 실패", retryable: true }; warnings.push(`${r.source}: ${e.code} ${e.message}`); return { source: r.source, total: null, items: [], error: e }; }
      notes.push(...r.notes);
      return { source: r.source, total: r.total, items: r.items, page: { no: a.page, size: a.size, hasMore: r.total != null ? a.page * a.size < r.total : r.items.length === a.size } };
    });
    // 병합 목록: 각 원천 상위 k 교차(날짜순 아님)
    const merged = []; const maxLen = Math.max(...groups.map((g) => g.items.length));
    for (let i = 0; i < maxLen; i++) for (const g of groups) if (g.items[i]) merged.push(g.items[i]);
    notes.push("병합 방식: 각 원천의 순위를 유지한 채 상위부터 교차로 섞음(날짜순 아님)");
    const next = merged.slice(0, 1).map(nextFor).filter(Boolean);
    return ok({ items: groups, total: groups.reduce((s, g) => s + (g.total || 0), 0), warnings, notes, cacheState: mergeCache(results.map((r) => (r.error ? null : r.hit ? "hit" : "miss"))), next, extra: { merged } });
  },
});
