// article_get — 조문 원문(한 개·여러 개·목차), 기준일 판 선택, 전문·절단 없음 (SPEC §4.2).
import { defineTool, ok, z, S, asOfYmd } from "../tool.js";
import { pickLawSpec, resolveLawName } from "../resolver.js";
import { resolveLaw } from "../versions.js";
import { fetchArticle, fetchFullBody, buildArticle, tocUnits, splitArticleByParagraph } from "../articles.js";
import { getArticleIndex, rangeOf, nearestFromIndex } from "../article_index.js";
import { parseArticleRef, formatArticleRef, sameArticle } from "../jo.js";
import { LawError, invalid } from "../errors.js";
import { mergeCache, paginateByBytes } from "../envelope.js";
import { todayKst } from "../kst.js";

/** 공통: 법령 확정 + 판 선택 → 본문 접근 방법(useId: 현행 판을 ID 로 1왕복). */
export async function locate(args, D, { prefetch } = {}) {
  const spec = pickLawSpec(args);
  // 왕복 최소화: 기준일이 오늘이고 특정 판(mst)을 묻지 않았으면 법령ID 로 현행 본문을 판 목록과 **동시에** 받는다.
  let early = null;
  if (prefetch && !spec.mst && D === todayKst()) {
    const lawId = spec.lawId || (spec.name ? (await resolveLawName(spec.name)).lawId : null);
    if (lawId) early = { lawId, promise: prefetch({ lawId, useId: true }).catch(() => null) };
  }
  const r = await resolveLaw(spec, D);
  const useId = !spec.mst && r.law.status === "current" && D === todayKst();
  const access = { lawId: r.law.lawId, mst: r.chosen.mst, efYd: r.chosen.efYd, useId };
  const prefetched = early && useId && early.lawId === access.lawId ? await early.promise : null;
  return { ...r, access, prefetched };
}

/** 항·호·목 범위 선택(요청이 제8조제1항제2호 같으면 그 단위만 남기되 상위 제목 유지). */
export function narrowScope(item, ref) {
  if (!ref.paragraph && !ref.item && !ref.subitem) return item;
  const scope = formatArticleRef(ref);
  let paragraphs = item.paragraphs;
  if (ref.paragraph) paragraphs = paragraphs.filter((p, i) => (p.no && circledIndex(p.no) === ref.paragraph) || (!p.no && i + 1 === ref.paragraph));
  if (!paragraphs.length) throw new LawError("ARTICLE_NOT_FOUND", `${item.label}에 제${ref.paragraph}항 없음`, { retryable: false, data: { validRange: `제1항~제${item.paragraphs.length}항`, code: "PARAGRAPH_NOT_FOUND" } });
  if (ref.item) {
    paragraphs = paragraphs.map((p) => ({ ...p, items: (p.items || []).filter((it) => parseInt(it.no, 10) === ref.item) }));
    if (!paragraphs.some((p) => p.items?.length)) throw new LawError("ARTICLE_NOT_FOUND", `${scope} 호 없음`, { retryable: false, data: { code: "PARAGRAPH_NOT_FOUND" } });
    if (ref.subitem) {
      paragraphs = paragraphs.map((p) => ({ ...p, items: p.items.map((it) => ({ ...it, subitems: (it.subitems || []).filter((s) => s.no.startsWith(ref.subitem)) })) }));
      if (!paragraphs.some((p) => p.items.some((it) => it.subitems?.length))) throw new LawError("ARTICLE_NOT_FOUND", `${scope} 목 없음`, { retryable: false, data: { code: "PARAGRAPH_NOT_FOUND" } });
    }
  }
  const text = paragraphs.map((p) => [p.text, ...(p.items || []).flatMap((it) => [it.text, ...(it.subitems || []).map((s) => s.text)])].join("\n")).join("\n");
  return { ...item, scope, paragraphs, text };
}
const CIRC = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳㉑㉒㉓㉔㉕㉖㉗㉘㉙㉚㉛㉜㉝㉞㉟㊱㊲㊳㊴㊵㊶㊷㊸㊹㊺㊻㊼㊽㊾㊿";

/** 출력 모양: 같은 본문을 두 번(text + paragraphs) 싣지 않는다. structured = 트리 + 머리글(head), text = 평문만. */
export function shapeArticle(it, format) {
  if (format === "text") { const { paragraphs, items, ...rest } = it; return rest; }
  if (!it.paragraphs?.length && !it.items?.length) return it; // 항·호가 없는 조문(삭제·한 문장)은 text 만
  const { text, ...rest } = it;
  const head = String(text || "").split("\n")[0];
  return { ...rest, ...(head && !rest.scope ? { head } : {}) };
}
const circledIndex = (no) => { const i = CIRC.indexOf(String(no)[0]); return i >= 0 ? i + 1 : parseInt(no, 10); };

export default defineTool({
  name: "article_get",
  description: "법령 조문 원문을 전문으로 가져온다(여러 조 가능, articles 를 비우면 조문 번호·제목 목차만). 기준일(asOf)에 시행 중인 판을 고르고 항·호·목 구조와 개정 표시를 돌려준다.",
  schema: {
    ...S.lawSpec,
    articles: z.array(z.string().min(1).max(40)).max(100).optional().describe("조문 표기 배열(예: [\"제15조\"]); 비우면 목차"),
    asOf: S.asOf,
    include: z.array(z.enum(["history_notes", "structure"])).default(["structure"]),
    format: z.enum(["structured", "text"]).default("structured").describe("트리+head | 평문"),
    maxBytes: S.maxBytes, part: S.part,
  },
  async handler(a) {
    const D = asOfYmd(a.asOf);
    const refs0 = (a.articles || []).map((s) => { const r = parseArticleRef(s); if (!r) throw invalid(`조문 표기를 읽을 수 없음: ${s}`); return r; });
    const uniq0 = []; for (const r of refs0) if (!uniq0.some((u) => sameArticle(u, r))) uniq0.push(r);
    const loc = await locate(a, D, { prefetch: (acc) => (uniq0.length ? Promise.all(uniq0.map((ref) => fetchArticle(acc, ref))) : fetchFullBody(acc)) });
    const { law, access } = loc;
    const warnings = [...loc.warnings], notes = [];
    const cacheStates = [...loc.cacheStates];
    const keepNotes = a.include.includes("history_notes");
    if (law.upcoming.length) warnings.push(`시행예정 개정 있음: 시행일 ${[...new Set(law.upcoming.map((u) => u.effectiveDate))].join(", ")} — 이 조문 변경 여부는 statute_history(article_changes) 로 확인`);
    // ── 목차 모드 ──
    if (!a.articles || !a.articles.length) {
      const { body, hit } = loc.prefetched || await fetchFullBody(access);
      cacheStates.push(hit ? "hit" : "miss");
      const toc = tocUnits(body);
      const pg = paginateByBytes(toc, { maxBytes: a.maxBytes, part: a.part });
      return ok({ items: pg.items, total: toc.length, page: { no: pg.part, size: pg.items.length, hasMore: pg.hasMore }, warnings, notes: ["목차 모드: 본문 없음. 조문 본문은 articles 에 표기를 넣어 다시 부르세요"], cacheState: mergeCache(cacheStates), asOf: D,
        next: [{ tool: "article_get", args: { lawId: law.lawId, articles: [toc.find((t) => t.label)?.label || "제1조"] }, why: "첫 조문 본문" }, ...(pg.hasMore ? [{ tool: "article_get", args: { lawId: law.lawId, part: pg.part + 1 }, why: "목차 이어받기" }] : [])],
        extra: { law } });
    }
    // ── 조문 모드 ──
    const refs = refs0, uniq = uniq0;
    const items = []; let allUnits = null;
    const results = loc.prefetched || await Promise.all(uniq.map((ref) => fetchArticle(access, ref)));
    for (const r of results) cacheStates.push(r.hit ? "hit" : "miss");
    for (let i = 0; i < uniq.length; i++) {
      const ref = uniq[i]; const r = results[i];
      if (!r.units.length) {
        // 없는 조문: 범위·가까운 조문은 조문 번호 색인(디스크 24h)에서 — 전체 본문은 색인이 없을 때 한 번만
        if (!allUnits) { const ix = await getArticleIndex(access, { mst: access.mst, efYd: access.efYd }); cacheStates.push(ix.hit ? "hit" : "miss"); allUnits = ix.index; }
        const vr = rangeOf(allUnits);
        throw new LawError("ARTICLE_NOT_FOUND", `${law.name}에 ${formatArticleRef(ref)} 없음`, { retryable: false, data: { validRange: vr.validRange, nearest: vr.all.length ? nearestFromIndex(allUnits, ref) : [] } });
      }
      for (const u of r.units) {
        let it = buildArticle(u, { lawName: law.name, keepNotes, asOfYmd: D });
        for (const want of refs.filter((x) => sameArticle(x, ref))) items.push(narrowScope(it, want));
      }
    }
    const pg = paginateByBytes(items, { maxBytes: a.maxBytes, part: a.part, splitUnit: (it, budget) => splitArticleByParagraph(it, budget) });
    warnings.push(...pg.warnings);
    pg.items = pg.items.map((it) => shapeArticle(it, a.format));
    const next = [];
    if (pg.hasMore) next.push({ tool: "article_get", args: { lawId: law.lawId, articles: a.articles, asOf: a.asOf, part: pg.part + 1, maxBytes: a.maxBytes }, why: "이어받기" });
    if (law.upcoming.length) next.push({ tool: "statute_history", args: { lawId: law.lawId, mode: "article_changes", article: items[0]?.label }, why: "이 조문의 개정 이력" });
    return ok({ items: pg.items, total: items.length, page: { no: pg.part, size: pg.items.length, hasMore: pg.hasMore }, warnings, notes, cacheState: mergeCache(cacheStates), asOf: D, next, extra: { law } });
  },
});
