// statute_find — 법령 찾기(이름·키워드·자동완성·일괄·기간 필터) (SPEC §4.1).
import { defineTool, ok, z, S, asOfYmd } from "../tool.js";
import { resolveLawName, sortCandidates, matchTypeOf } from "../resolver.js";
import { ensureDictionary, dictionary, normalizeName } from "../dictionary.js";
import { search, lawRow } from "../upstream.js";
import { listVersions, selectVersion } from "../versions.js";
import { lawLink } from "../links.js";
import { parseDate } from "../kst.js";
import { invalid, isLawError } from "../errors.js";
import { mergeCache } from "../envelope.js";

const KINDS_ORDER = ["법률", "대통령령", "총리령", "부령", "규칙"];

function item(l, matchType) {
  return { name: l.name, kind: l.kind, lawId: l.lawId, mst: l.mst, promulgationDate: l.promulgationDate, promulgationNo: l.promulgationNo, effectiveDate: l.effectiveDate, status: l.statusCode === "현행" ? "current" : l.statusCode === "시행예정" ? "upcoming" : "historical", department: l.department, matchType, upcoming: [], link: lawLink(l.name) };
}

async function withUpcoming(it, D) {
  try {
    const vl = await listVersions(it.lawId);
    const sel = selectVersion(vl.versions, D);
    it.upcoming = sel.upcoming.map((u) => ({ mst: u.mst, effectiveDate: u.effectiveDate }));
    if (!it.mst || it.status === "current") { it.mst = sel.chosen.mst; it.effectiveDate = sel.chosen.effectiveDate; it.promulgationDate = sel.chosen.promulgationDate; it.promulgationNo = sel.chosen.promulgationNo; }
  } catch { /* 보충 실패는 조용히 — 목록 자체는 유효 */ }
  return it;
}

export default defineTool({
  name: "statute_find",
  description: "법령을 이름·키워드로 찾거나(자동완성·여러 이름 일괄 포함) 공포일 기간으로 거른다. 법령ID·MST·법종·시행일·시행예정 판과 다음 호출 예를 돌려준다.",
  schema: {
    query: z.string().min(1).max(100).optional().describe("법령명·키워드(예: 주택법)"),
    names: z.array(z.string().min(1).max(100)).min(1).max(50).optional().describe("여러 법령명 일괄 해석"),
    mode: z.enum(["search", "suggest"]).default("search"),
    scope: z.enum(["current", "all", "upcoming"]).default("current"),
    kinds: z.array(z.string()).max(10).optional().describe("법종 필터(예: 법률)"),
    promulgatedFrom: z.string().optional(), promulgatedTo: z.string().optional(),
    match: z.enum(["all", "any"]).default("all"),
    page: S.page, size: S.size(20),
  },
  async handler(a) {
    const D = asOfYmd(undefined);
    if (!a.query && !a.names) throw invalid("query 또는 names 중 하나 필수");
    const notes = [], warnings = [];
    // ── names 일괄 ──
    if (a.names) {
      const rows = await Promise.all(a.names.map(async (input) => {
        try { const r = await resolveLawName(input); const { cache, inputName, expandedFrom, ...res } = r; return { input, resolved: { ...res, link: lawLink(res.name) } }; }
        catch (e) { return { input, resolved: null, error: isLawError(e) ? e.toJSON() : { code: "UPSTREAM_UNAVAILABLE", message: "확인 실패", retryable: true } }; }
      }));
      return ok({ items: rows, total: rows.length, notes, warnings, next: rows.filter((r) => r.resolved).slice(0, 2).map((r) => ({ tool: "article_get", args: { lawId: r.resolved.lawId }, why: `${r.resolved.name} 목차` })) });
    }
    const q = a.query.trim();
    // ── suggest: 사전(접두·포함) 먼저, 업스트림으로 보충 ──
    if (a.mode === "suggest") {
      if (q.length < 2) throw invalid("suggest 는 query 2자 이상");
      await ensureDictionary();
      const norm = normalizeName(q);
      let cands = dictionary().entries.map((e) => ({ name: e.n, kind: e.k, lawId: e.i, mst: e.m, effectiveDate: e.e, statusCode: "현행" }));
      let cacheState = "hit";
      if (!cands.length) { const r = await search("eflaw", { query: q, nw: 3, display: 100 }, { rowKeys: ["law"] }); cands = r.rows.map(lawRow); cacheState = r.hit ? "hit" : "miss"; }
      let ranked = sortCandidates(norm, cands);
      if (a.kinds?.length) ranked = ranked.filter((c) => a.kinds.includes(c.kind));
      const total = ranked.length;
      const pageRows = ranked.slice((a.page - 1) * a.size, a.page * a.size);
      const items = pageRows.map((c) => ({ name: c.name, kind: c.kind, lawId: c.lawId, mst: c.mst, effectiveDate: c.effectiveDate, status: "current", matchType: matchTypeOf(c.tier), link: lawLink(c.name) }));
      notes.push("정렬: 정확 > 접두 > 포함, 같은 등급은 법종 상위·짧은 이름 우선(법령명 사전 기준)");
      return ok({ items, total, page: { no: a.page, size: a.size, hasMore: a.page * a.size < total }, notes, warnings, cacheState, next: items[0] ? [{ tool: "article_get", args: { lawId: items[0].lawId }, why: `${items[0].name} 목차` }] : [] });
    }
    // ── search ──
    const nw = a.scope === "current" ? "3" : a.scope === "upcoming" ? "2,3" : "1,2,3";
    const params = { query: q, nw, display: 100, page: 1 };
    const pf = a.promulgatedFrom ? parseDate(a.promulgatedFrom) : null, pt = a.promulgatedTo ? parseDate(a.promulgatedTo) : null;
    if ((a.promulgatedFrom && !pf) || (a.promulgatedTo && !pt)) throw invalid("기간 날짜 형식 오류");
    if (pf || pt) params.ancYd = `${pf || "19000101"}~${pt || "29991231"}`;
    const terms = q.split(/\s+/).filter(Boolean);
    // 사전에 정확 일치가 있으면 시행예정 판 조회(판 목록)를 검색과 동시에 시작한다(왕복 직렬화 방지)
    await ensureDictionary();
    const exactEntry = dictionary().entries.find((e) => normalizeName(e.n) === normalizeName(q));
    if (exactEntry && a.scope === "current") listVersions(exactEntry.i).catch(() => {});
    const r = await search("eflaw", params, { rowKeys: ["law"] });
    let rows = r.rows.map(lawRow);
    const norm = normalizeName(q);
    if (a.match === "any" && terms.length > 1) {
      const extra = await Promise.all(terms.slice(1).map((t) => search("eflaw", { ...params, query: t }, { rowKeys: ["law"] }).catch(() => ({ rows: [] }))));
      const seen = new Set(rows.map((x) => x.mst + x.effectiveDate));
      for (const e of extra) for (const x of e.rows.map(lawRow)) if (!seen.has(x.mst + x.effectiveDate)) { seen.add(x.mst + x.effectiveDate); rows.push(x); }
      notes.push("match=any: 낱말별 검색 결과를 합침(업스트림은 AND 만 지원)");
    } else if (terms.length > 1) notes.push("match=all: 공백으로 나눈 낱말을 모두 포함하는 법령명(업스트림 기본)");
    if (a.kinds?.length) rows = rows.filter((x) => a.kinds.includes(x.kind));
    // 순위: 정확 > 접두 > 포함 > 키워드(이름에 질의가 통째로 들어있지 않음)
    const tier = (x) => { const n = normalizeName(x.name); return n === norm ? 0 : n.startsWith(norm) ? 1 : n.includes(norm) ? 2 : 3; };
    const kindRank = (k) => { const i = KINDS_ORDER.findIndex((p) => k.includes(p)); return i < 0 ? 9 : i; };
    rows.sort((x, y) => tier(x) - tier(y) || kindRank(x.kind) - kindRank(y.kind) || x.name.length - y.name.length || (y.effectiveDate || "").localeCompare(x.effectiveDate || ""));
    const total = r.total ?? rows.length;
    const pageRows = rows.slice((a.page - 1) * a.size, a.page * a.size);
    const items = pageRows.map((x) => item(x, ["exact", "prefix", "contains", "keyword"][tier(x)]));
    // 1순위(정확 일치)엔 시행예정 판을 붙인다
    if (items[0] && a.scope === "current") await withUpcoming(items[0], D);
    if (r.total != null && r.total > r.rows.length) notes.push(`업스트림 전체 ${r.total}건 중 상위 ${r.rows.length}건을 순위 매김`);
    const next = items[0] ? [
      { tool: "article_get", args: { lawId: items[0].lawId }, why: `${items[0].name} 목차(조문 번호·제목)` },
      { tool: "statute_outline", args: { lawId: items[0].lawId, view: "hierarchy" }, why: "상하위 법령 구조" },
    ] : [];
    return ok({ items, total, page: { no: a.page, size: a.size, hasMore: a.page * a.size < rows.length }, notes, warnings, cacheState: r.hit ? "hit" : "miss", next });
  },
});
