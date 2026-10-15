// citation_audit — 글 속 법령·판례 인용을 뽑아 실존·제목·내용 일치 판정 (SPEC §4.8). 1순위: 실존 조문을 환각으로 판정하지 않기.
import { defineTool, ok, z, S, asOfYmd } from "../tool.js";
import { extractCitations, matchClaim } from "../citations.js";
import { ensureDictionary } from "../dictionary.js";
import { resolveLawName } from "../resolver.js";
import { resolveLaw } from "../versions.js";
import { fetchArticle, buildArticle } from "../articles.js";
import { getArticleIndex, rangeOf } from "../article_index.js";
import { parseArticleRef, formatArticleRef, articleLabel, sameArticle } from "../jo.js";
import { search, str, digits } from "../upstream.js";
import { TTL } from "../cache.js";
import { fmtDate, todayKst } from "../kst.js";
import { lawLink, precedentLink } from "../links.js";
import { isLawError, invalid } from "../errors.js";
import { mergeCache } from "../envelope.js";
import { isCaseNo } from "../casenos.js";

const SUSPICIOUS = new Set(["ARTICLE_NOT_FOUND", "PARAGRAPH_NOT_FOUND", "LAW_NOT_FOUND", "CASE_NOT_FOUND", "CONTENT_MISMATCH", "TITLE_MISMATCH"]);
const circled = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳㉑㉒㉓㉔㉕㉖㉗㉘㉙㉚㉛㉜㉝㉞㉟㊱㊲㊳㊴㊵㊶㊷㊸㊹㊺㊻㊼㊽㊾㊿";
const paraIndex = (p, i) => { const k = circled.indexOf(String(p.no || "")[0]); return k >= 0 ? k + 1 : i + 1; };

/** 한 법령에 대해 여러 인용을 1회 본문(조문별 1회)으로 확인. */
async function auditLawGroup(lawName, cits, D, threshold, cacheStates) {
  let resolved;
  try { resolved = await resolveLawName(lawName); cacheStates.push(resolved.cache); }
  catch (e) {
    const code = isLawError(e) ? e.code : "UPSTREAM";
    for (const c of cits) c.status = code === "LAW_NOT_FOUND" ? "LAW_NOT_FOUND" : code === "AMBIGUOUS_NAME" ? "AMBIGUOUS" : "UNCHECKED";
    if (code === "AMBIGUOUS_NAME") for (const c of cits) c.candidates = e.candidates;
    return;
  }
  let lawInfo, access;
  if (D === todayKst()) {
    // 오늘 기준: 판 목록 없이 법령ID 로 현행 본문을 바로 받는다(1왕복). 시행일은 본문 기본정보에서.
    lawInfo = { law: { name: resolved.name, lawId: resolved.lawId, status: "current", effectiveDate: resolved.effectiveDate }, chosen: { mst: resolved.mst, efYd: "" } };
    access = { lawId: resolved.lawId, useId: true };
  } else {
    try { lawInfo = await resolveLaw({ lawId: resolved.lawId }, D); cacheStates.push(...lawInfo.cacheStates); }
    catch (e) { for (const c of cits) c.status = isLawError(e) && e.code === "LAW_NOT_FOUND" ? "NOT_IN_FORCE" : "UNCHECKED"; return; }
    access = { lawId: lawInfo.law.lawId, mst: lawInfo.chosen.mst, efYd: lawInfo.chosen.efYd, useId: false };
  }
  const uniqRefs = []; for (const c of cits) if (!uniqRefs.some((u) => sameArticle(u, c.ref))) uniqRefs.push(c.ref);
  const fetched = new Map();
  await Promise.all(uniqRefs.map(async (ref) => { try { const r = await fetchArticle(access, ref); cacheStates.push(r.hit ? "hit" : "miss"); fetched.set(articleLabel(ref.article, ref.branch), r); } catch (e) { fetched.set(articleLabel(ref.article, ref.branch), { error: e }); } }));
  let range = null;
  for (const c of cits) {
    const r = fetched.get(c.label);
    c.law = lawInfo.law.name; c.lawId = lawInfo.law.lawId; c.link = lawLink(lawInfo.law.name, c.label);
    if (!r || r.error) { c.status = "UNCHECKED"; continue; }
    if (!r.units.length) {
      // 없는 조문: 유효 범위는 조문 번호 색인(디스크 24h, 없으면 이때 한 번 만든다)에서 — 전체 본문 왕복 없음
      if (!range) { try { const ix = await getArticleIndex(access, { mst: lawInfo.chosen.mst, efYd: lawInfo.chosen.efYd || digits(lawInfo.law.effectiveDate) }); cacheStates.push(ix.hit ? "hit" : "miss"); range = rangeOf(ix.index); } catch { range = { validRange: null }; } }
      c.status = "ARTICLE_NOT_FOUND"; c.validRange = range.validRange; continue;
    }
    const art = buildArticle(r.units[0], { lawName: lawInfo.law.name, asOfYmd: D });
    c.actual = { law: lawInfo.law.name, mst: lawInfo.chosen.mst, label: art.label, title: art.title, effectiveDate: art.effectiveDate || r.meta?.effectiveDate || lawInfo.law.effectiveDate };
    if (art.status === "deleted") { c.status = "NOT_IN_FORCE"; c.note = "기준일 판에서 삭제된 조문"; continue; }
    if (art.status === "upcoming") { c.status = "NOT_IN_FORCE"; c.note = `기준일 이후 시행(${art.effectiveDate})`; continue; }
    // 항·호·목 존재
    if (c.ref.paragraph) {
      const p = art.paragraphs.find((x, i) => paraIndex(x, i) === c.ref.paragraph);
      if (!p) { c.status = "PARAGRAPH_NOT_FOUND"; c.validRange = `제1항~제${art.paragraphs.length}항`; continue; }
      if (c.ref.item && !(p.items || []).some((it) => parseInt(it.no, 10) === c.ref.item)) { c.status = "PARAGRAPH_NOT_FOUND"; c.validRange = `${c.label} 제${c.ref.paragraph}항 호 ${p.items?.length || 0}개`; continue; }
    } else if (c.ref.item && !(art.paragraphs.flatMap((p) => p.items || []).concat(art.items || [])).some((it) => parseInt(it.no, 10) === c.ref.item)) { c.status = "PARAGRAPH_NOT_FOUND"; continue; }
    // 제목
    const titleGiven = c.title || c.titleInText;
    if (titleGiven && art.title && titleGiven.replace(/\s+/g, "") !== art.title.replace(/\s+/g, "")) { c.status = "TITLE_MISMATCH"; continue; }
    // 내용
    if (c.claim && c.checkContent !== false) {
      const m = matchClaim(c.claim, art.text, art.paragraphs, threshold);
      c.similarity = m.similarity; if (m.nearest) c.nearest = m.nearest;
      if (!m.ok) { c.status = "CONTENT_MISMATCH"; continue; }
    }
    c.status = "VERIFIED";
  }
}

async function auditCase(c, cacheStates) {
  try {
    const r = await search("prec", { nb: c.caseNo, display: 20 }, { rowKeys: ["prec"], ttl: TTL.sourceBody }); cacheStates.push(r.hit ? "hit" : "miss");
    const exact = r.rows.filter((x) => str(x["사건번호"]) === c.caseNo);
    if (!exact.length) { c.status = "CASE_NOT_FOUND"; return; }
    const row = exact[0];
    c.actual = { id: str(row["판례일련번호"]), court: str(row["법원명"]), date: fmtDate(row["선고일자"]), title: str(row["사건명"]) };
    c.link = precedentLink(c.actual.id);
    if (c.court && c.actual.court && c.court !== c.actual.court) c.note = `법원 불일치: 인용 ${c.court}, 실제 ${c.actual.court}`;
    c.status = "CASE_VERIFIED";
  } catch { c.status = "UNCHECKED"; }
}

export default defineTool({
  name: "citation_audit",
  description: "글 속 법령 조문·판례 인용을 뽑아 실제로 존재하는지(기준일 판), 제목·내용이 맞는지 판정한다. 법령명은 사전 일치로만 잡고, 업스트림 장애는 UNCHECKED(환각 판정 아님).",
  schema: {
    text: z.string().max(50000).optional(),
    citations: z.array(z.object({ law: z.string().max(100).optional(), article: z.string().max(40).optional(), title: z.string().max(60).optional(), claim: z.string().max(2000).optional(), caseNo: z.string().max(40).optional() }).strict()).max(100).optional(),
    asOf: S.asOf,
    checkContent: z.boolean().optional(),
    threshold: z.number().min(0.5).max(1).default(0.9),
  },
  async handler(a) {
    const D = asOfYmd(a.asOf);
    if (!a.text && !a.citations) throw invalid("text 또는 citations 필요");
    await ensureDictionary();
    const cacheStates = []; const warnings = [], notes = [];
    let items = [];
    if (a.text) {
      for (const c of extractCitations(a.text)) {
        if (c.kind === "case") items.push({ raw: c.raw, span: c.span, caseNo: c.caseNo, court: c.court, kind: "case" });
        else items.push({ raw: c.raw, span: c.span, law: c.law, article: formatArticleRef(c.ref), label: c.label, ref: c.ref, titleInText: c.titleInText, inDictionary: c.inDictionary, anaphora: c.anaphora, unresolved: c.unresolved, kind: "statute" });
      }
    }
    for (const c of a.citations || []) {
      if (c.caseNo) { items.push({ raw: c.caseNo, caseNo: c.caseNo.replace(/\s+/g, ""), kind: "case", claim: c.claim }); continue; }
      if (!c.law || !c.article) throw invalid("citations 항목은 {law, article} 또는 {caseNo}");
      const ref = parseArticleRef(c.article); if (!ref) throw invalid(`조문 표기를 읽을 수 없음: ${c.article}`);
      items.push({ raw: `${c.law} ${c.article}`, law: c.law, article: formatArticleRef(ref), label: articleLabel(ref.article, ref.branch), ref, title: c.title, claim: c.claim, kind: "statute", checkContent: a.checkContent });
    }
    for (const it of items) if (it.kind === "statute" && a.checkContent === false) it.checkContent = false;
    // 법령별 묶음(서로 다른 법령은 병렬, 같은 법령은 조문당 1회)
    const groups = new Map();
    for (const it of items) {
      if (it.kind !== "statute") continue;
      if (it.unresolved || !it.law) { it.status = it.anaphora ? "UNRESOLVED" : "LAW_NOT_FOUND"; continue; }
      const k = it.law; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(it);
    }
    await Promise.all([
      ...[...groups.entries()].map(([law, cits]) => auditLawGroup(law, cits, D, a.threshold, cacheStates)),
      ...items.filter((it) => it.kind === "case").map((it) => (isCaseNo(it.caseNo) ? auditCase(it, cacheStates) : Promise.resolve((it.status = "CASE_NOT_FOUND")))),
    ]);
    const out = items.map((it) => { const o = { raw: it.raw, ...(it.span ? { span: it.span } : {}), status: it.status }; if (it.kind === "statute") { o.law = it.law; o.article = it.article; } else { o.caseNo = it.caseNo; if (it.court) o.court = it.court; } for (const k of ["actual", "validRange", "similarity", "nearest", "candidates", "note", "link"]) if (it[k] != null) o[k] = it[k]; return o; });
    const summary = { checked: out.length, verified: out.filter((x) => x.status === "VERIFIED" || x.status === "CASE_VERIFIED").length, suspicious: out.filter((x) => SUSPICIOUS.has(x.status)).length, unchecked: out.filter((x) => x.status === "UNCHECKED").length };
    if (summary.unchecked) warnings.push(`${summary.unchecked}건은 업스트림 장애로 확인하지 못했습니다(UNCHECKED — 환각 판정 아님, 다시 시도)`);
    notes.push("판정: VERIFIED/CASE_VERIFIED 실존, ARTICLE_NOT_FOUND·PARAGRAPH_NOT_FOUND·LAW_NOT_FOUND·CASE_NOT_FOUND·TITLE_MISMATCH·CONTENT_MISMATCH 는 의심(suspicious), NOT_IN_FORCE 는 기준일에 없음, UNCHECKED 는 미확인");
    const next = out.filter((x) => x.status === "VERIFIED").slice(0, 1).map((x) => ({ tool: "article_get", args: { name: x.law, articles: [x.article] }, why: "원문 전문" }));
    return ok({ items: out, total: out.length, warnings, notes, cacheState: mergeCache(cacheStates), asOf: D, next, extra: { summary } });
  },
});
