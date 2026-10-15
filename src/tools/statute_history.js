// statute_history — 판 이력·조문 개정 이력·신구 대조·두 시점 비교·폐지/후속 (SPEC §4.5).
import { defineTool, ok, z, S, asOfYmd } from "../tool.js";
import { pickLawSpec, resolveLawName } from "../resolver.js";
import { resolveLaw, listVersions, selectVersion, statusOf } from "../versions.js";
import { fetchArticle, buildArticle } from "../articles.js";
import { service, search, asList, str, digits, lawRow } from "../upstream.js";
import { TTL } from "../cache.js";
import { fmtDate, parseDate, todayKst } from "../kst.js";
import { parseArticleRef, toJoCode, formatArticleRef } from "../jo.js";
import { diffSentences } from "../diff.js";
import { lawLink } from "../links.js";
import { normalizeName } from "../dictionary.js";
import { mergeCache } from "../envelope.js";
import { LawError, invalid } from "../errors.js";

export default defineTool({
  name: "statute_history",
  description: "법령의 시간 축: 판 목록(versions), 한 조문의 개정 이력(article_changes), 신구 대조(old_new), 두 날짜의 조문 문장 비교(compare_dates), 폐지·제명변경 추적(lineage). 기준일 판 선택 규칙으로 시행예정 판을 구분한다.",
  schema: { ...S.lawSpec, mode: z.enum(["versions", "article_changes", "old_new", "compare_dates", "lineage"]).default("versions"), article: z.string().max(40).optional(), from: z.string().max(12).optional(), to: z.string().max(12).optional(), dateA: z.string().max(12).optional(), dateB: z.string().max(12).optional(), asOf: S.asOf, page: S.page, size: S.size(50) },
  async handler(a) {
    const D = asOfYmd(a.asOf);
    const warnings = [], notes = [], cacheStates = [];
    if (a.mode === "lineage") {
      if (!a.name) throw invalid("lineage 는 name 필요");
      // 연혁 포함 검색: 폐지된 판을 찾고 현행 후속 후보(이름 포함·약칭)를 근거와 함께
      const r = await search("eflaw", { query: a.name, nw: "1,2,3", display: 100 }, { rowKeys: ["law"] }); cacheStates.push(r.hit ? "hit" : "miss");
      const rows = r.rows.map(lawRow);
      const norm = normalizeName(a.name);
      const exact = rows.filter((x) => normalizeName(x.name) === norm);
      const byId = new Map();
      for (const x of exact) { const g = byId.get(x.lawId) || { lawId: x.lawId, name: x.name, kind: x.kind, versions: [] }; g.versions.push({ mst: x.mst, effectiveDate: x.effectiveDate, promulgationDate: x.promulgationDate, revision: x.revision, status: x.statusCode }); byId.set(x.lawId, g); }
      const items = [];
      for (const g of byId.values()) {
        const abolished = g.versions.find((v) => /폐지/.test(v.revision));
        const current = g.versions.find((v) => v.status === "현행");
        items.push({ ...g, status: current ? "current" : abolished ? "abolished" : "historical", abolishedAt: abolished?.promulgationDate, link: lawLink(g.name) });
      }
      const successors = rows.filter((x) => x.statusCode === "현행" && normalizeName(x.name) !== norm).map((x) => ({ name: x.name, kind: x.kind, lawId: x.lawId, mst: x.mst, effectiveDate: x.effectiveDate, basis: normalizeName(x.name).includes(norm) ? "이름 포함(제명 변경·통폐합 후보)" : "검색 결과 현행 법령", link: lawLink(x.name) }));
      if (!items.length) throw new LawError("LAW_NOT_FOUND", `연혁 포함 검색에도 '${a.name}' 정확 일치 없음`, { retryable: false, candidates: successors.slice(0, 5) });
      notes.push("후속 법령 후보는 이름 포함 여부로 고른 것이며 확정이 아닙니다 — 폐지 판 부칙의 '다른 법령과의 관계'를 article_get 으로 확인하세요");
      return ok({ items, total: items.length, warnings, notes, cacheState: mergeCache(cacheStates), asOf: D, extra: { successors: successors.slice(0, 10) }, next: items[0]?.versions?.[0] ? [{ tool: "statute_history", args: { lawId: items[0].lawId, mode: "versions" }, why: "판 목록 전체" }] : [] });
    }
    const spec = pickLawSpec(a);
    const r = await resolveLaw(spec, D); cacheStates.push(...r.cacheStates); warnings.push(...r.warnings);
    const law = r.law;
    if (a.mode === "versions") {
      const f = a.from ? parseDate(a.from) : null, t = a.to ? parseDate(a.to) : null;
      if ((a.from && !f) || (a.to && !t)) throw invalid("from/to 날짜 형식 오류");
      let vs = r.versions.filter((v) => (!f || v.efYd >= f) && (!t || v.efYd <= t));
      const items = vs.map((v) => ({ mst: v.mst, effectiveDate: v.effectiveDate, promulgationDate: v.promulgationDate, promulgationNo: v.promulgationNo, revision: v.revision, status: v.mst === r.chosen.mst && v.efYd === r.chosen.efYd ? "current" : statusOf(v, D) === "upcoming" ? "upcoming" : "historical" }));
      const total = items.length; const pageItems = items.slice((a.page - 1) * a.size, a.page * a.size);
      notes.push("status: current = 기준일 적용 판, upcoming = 기준일 이후 시행, historical = 그 이전 판. 같은 MST 가 시행일별로 여러 판일 수 있음(분할 시행)");
      return ok({ items: pageItems, total, page: { no: a.page, size: a.size, hasMore: a.page * a.size < total }, warnings, notes, cacheState: mergeCache(cacheStates), asOf: D, extra: { law }, next: [{ tool: "statute_history", args: { lawId: law.lawId, mode: "old_new" }, why: "가장 최근 개정의 신구 대조" }] });
    }
    if (a.mode === "article_changes") {
      const ref = a.article ? parseArticleRef(a.article) : null; if (!ref) throw invalid("article_changes 는 article 필요");
      const { data, hit } = await service("lsJoHstInf", { ID: law.lawId, JO: toJoCode(ref), display: 100 }, { ttl: TTL.resolve }); cacheStates.push(hit ? "hit" : "miss");
      const rows = asList(data?.["LawService"]?.["law"] ?? Object.values(data || {})[0]?.["law"]);
      const items = rows.map((x) => { const j = x["조문정보"] || {}; const l = x["법령정보"] || {}; return { date: fmtDate(j["조문변경일"]), reason: str(j["변경사유"]), mst: str(l["법령일련번호"]), effectiveDate: fmtDate(l["시행일자"]), promulgationDate: fmtDate(l["공포일자"]), promulgationNo: str(l["공포번호"]), revision: str(l["제개정구분명"]) }; }).sort((x, y) => (y.date || "").localeCompare(x.date || ""));
      const total = items.length; const pageItems = items.slice((a.page - 1) * a.size, a.page * a.size);
      const next = [];
      if (items[0]?.mst && items[1]?.mst) next.push({ tool: "statute_history", args: { lawId: law.lawId, mode: "compare_dates", article: formatArticleRef(ref), dateA: items[1].effectiveDate, dateB: items[0].effectiveDate }, why: "최근 두 판의 문장 차이" });
      return ok({ items: pageItems, total, page: { no: a.page, size: a.size, hasMore: a.page * a.size < total }, warnings, notes, cacheState: mergeCache(cacheStates), asOf: D, extra: { law, article: formatArticleRef(ref) }, next });
    }
    if (a.mode === "old_new") {
      const params = spec.mst ? { MST: spec.mst } : { ID: law.lawId };
      const { data, hit } = await service("oldAndNew", params, { ttl: TTL.body, long: true }); cacheStates.push(hit ? "hit" : "miss");
      const root = data && typeof data === "object" ? Object.values(data).find((v) => v && typeof v === "object") : null;
      if (!root || str(root["신구법존재여부"]) === "N") return ok({ items: [], total: 0, warnings, notes: ["신구 대조 자료 없음"], cacheState: mergeCache(cacheStates), asOf: D, extra: { law } });
      const meta = (k) => { const b = root[k] || {}; return { mst: str(b["법령일련번호"]), effectiveDate: fmtDate(b["시행일자"]), promulgationDate: fmtDate(b["공포일자"]), promulgationNo: str(b["공포번호"]), revision: str(b["제개정구분명"]), current: str(b["현행여부"]) === "Y" }; };
      const texts = (k) => asList(root[k]?.["조문"]).map((x) => str(x?.content ?? x)).filter(Boolean);
      const oldT = texts("구조문목록"), newT = texts("신조문목록");
      const pairs = []; const n = Math.max(oldT.length, newT.length);
      for (let i = 0; i < n; i++) { const o = oldT[i] || "", w = newT[i] || ""; if (o === w) continue; pairs.push({ index: i + 1, old: o, new: w, diff: diffSentences(o, w).filter((d) => d.op !== "equal") }); }
      const total = pairs.length; const pageItems = pairs.slice((a.page - 1) * a.size, a.page * a.size);
      notes.push(`업스트림 신구 대조: 구 ${oldT.length}줄 · 신 ${newT.length}줄 중 달라진 ${total}줄만 표시`);
      return ok({ items: pageItems, total, page: { no: a.page, size: a.size, hasMore: a.page * a.size < total }, warnings, notes, cacheState: mergeCache(cacheStates), asOf: D, extra: { law, old: meta("구조문_기본정보"), new: meta("신조문_기본정보") } });
    }
    // compare_dates
    const ref = a.article ? parseArticleRef(a.article) : null; if (!ref) throw invalid("compare_dates 는 article 필요");
    const dA = parseDate(a.dateA), dB = parseDate(a.dateB); if (!dA || !dB) throw invalid("dateA/dateB 필요(YYYY-MM-DD)");
    const pick = (d) => { const sel = selectVersion(r.versions, d); return sel.chosen; };
    const vA = pick(dA), vB = pick(dB);
    const get = async (v) => { const x = await fetchArticle({ lawId: law.lawId, mst: v.mst, efYd: v.efYd, useId: false }, ref); cacheStates.push(x.hit ? "hit" : "miss"); return x.units[0] ? buildArticle(x.units[0], { lawName: law.name }) : null; };
    const [artA, artB] = await Promise.all([get(vA), get(vB)]);
    const same = vA.mst === vB.mst && vA.efYd === vB.efYd;
    const textA = artA?.text || "", textB = artB?.text || "";
    const diff = same ? [] : diffSentences(textA, textB).map((d) => ({ op: d.op === "equal" ? "same" : d.op, text: d.text }));
    const changed = !same && diff.some((d) => d.op !== "same");
    const item = { a: { date: fmtDate(dA), mst: vA.mst, effectiveDate: vA.effectiveDate, exists: !!artA }, b: { date: fmtDate(dB), mst: vB.mst, effectiveDate: vB.effectiveDate, exists: !!artB }, changed, diff: changed ? diff : [], article: formatArticleRef(ref) };
    if (same) notes.push("두 날짜의 적용 판이 같아 차이 없음");
    return ok({ items: [item], total: 1, warnings, notes, cacheState: mergeCache(cacheStates), asOf: D, extra: { law }, next: [{ tool: "article_get", args: { lawId: law.lawId, articles: [formatArticleRef(ref)], asOf: fmtDate(dB) }, why: `${fmtDate(dB)} 기준 원문` }] });
  },
});
