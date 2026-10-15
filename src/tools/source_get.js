// source_get — 법령 외 원천 본문 1건(섹션 선택·발췌·핵심어) (SPEC §4.7).
import { defineTool, ok, z, S } from "../tool.js";
import { SOURCES, SOURCE_NAMES } from "../sources.js";
import { service, search, str, asList } from "../upstream.js";
import { TTL } from "../cache.js";
import { fmtDate } from "../kst.js";
import { LawError, invalid } from "../errors.js";
import { paginateByBytes } from "../envelope.js";
import { extractCitations } from "../citations.js";
import { normalizeUpstreamLink } from "../links.js";
import { dictionary } from "../dictionary.js";

const sourceEnum = z.enum(SOURCE_NAMES);

/** 업스트림 본문 문자열 정리: <br/> → 줄바꿈, 태그 제거, 공백 정리. 절단 없음. */
export function cleanText(v) {
  const flat = (x) => (Array.isArray(x) ? x.map(flat).join("\n") : x && typeof x === "object" ? Object.values(x).map(flat).join("\n") : String(x ?? ""));
  return flat(v).replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/[ \t ]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

/** 문장 분할(원문 문장 그대로). */
export function sentences(text) {
  return String(text || "").split(/(?<=[.。!?]|다\.)\s+|\n+/).map((s) => s.trim()).filter((s) => s.length > 1);
}

export async function fetchSourceBody(source, id) {
  const def = SOURCES[source];
  if (!def?.body) throw new LawError("NOT_SUPPORTED", `${source} 는 본문 조회를 제공하지 않음(목록·링크만)`, { retryable: false });
  const params = { [def.body.idParam || "ID"]: id };
  const { data, hit } = await service(def.body.target, params, { ttl: TTL.sourceBody, long: true });
  const root = data && typeof data === "object" ? Object.values(data).find((v) => v && typeof v === "object") : null;
  if (!root || (def.body.idKey && !str(root[def.body.idKey]) && !root[def.body.sections?.[0]])) {
    throw new LawError("SOURCE_NOT_FOUND", `${source} ${id} 본문 없음`, { retryable: false });
  }
  return { root, hit };
}

/** 판례 사건번호 → ID (정확 일치만). 여러 건이면 AMBIGUOUS_NAME. */
export async function precedentIdByCaseNo(caseNo) {
  const r = await search("prec", { nb: caseNo, display: 20 }, { rowKeys: ["prec"], ttl: TTL.sourceBody });
  const exact = r.rows.filter((x) => str(x["사건번호"]) === caseNo);
  if (!exact.length) throw new LawError("SOURCE_NOT_FOUND", `사건번호 ${caseNo} 판례 없음`, { retryable: false });
  if (exact.length > 1) throw new LawError("AMBIGUOUS_NAME", `사건번호 ${caseNo} 에 여러 판례`, { candidates: exact.map((x) => ({ id: str(x["판례일련번호"]), court: str(x["법원명"]), date: fmtDate(x["선고일자"]), title: str(x["사건명"]) })) });
  return { id: str(exact[0]["판례일련번호"]), hit: r.hit, row: exact[0] };
}

export function buildSourceDoc(source, root, id, wantSections) {
  const b = SOURCES[source].body;
  const sectionsAll = b.sections || Object.keys(root).filter((k) => typeof root[k] === "string" && root[k].length > 80);
  const chosen = wantSections?.length ? sectionsAll.filter((s) => wantSections.includes(s)) : sectionsAll;
  const sections = {};
  for (const s of chosen) { const t = cleanText(root[s]); if (t) sections[s] = t; }
  const agency = typeof b.agency === "function" ? b.agency(root) : str(root[b.agency]);
  const doc = { source, id: str(root[b.idKey]) || id, title: b.title ? str(root[b.title]) : undefined, caseNo: b.caseNo ? str(root[b.caseNo]) || undefined : undefined, agency, date: fmtDate(str(root[b.date]).replace(/\D/g, "").slice(0, 8)), sections, availableSections: sectionsAll, link: b.link(id, root) || (b.linkKey ? normalizeUpstreamLink(str(root[b.linkKey])) : null) };
  for (const k of b.extra || []) if (str(root[k])) doc[k] = str(root[k]);
  return doc;
}

/** 참조조문·참조판례 문자열 → 구조화. */
export function buildRefs(root, source) {
  const refs = { articles: [], cases: [] };
  const artText = cleanText(root["참조조문"] || root["관련법령"] || root["심판대상조문"] || "");
  if (artText) {
    const seen = new Set();
    for (const c of extractCitations(artText).filter((c) => c.kind === "statute" && c.law && c.ref)) {
      const key = c.law + c.label; if (seen.has(key)) continue; seen.add(key);
      refs.articles.push({ law: c.law, label: c.label });
    }
  }
  const caseText = cleanText(root["참조판례"] || "");
  if (caseText) {
    const seen = new Set();
    for (const m of caseText.matchAll(/(\d{4}[가-힣]{1,3}\d{1,7})/g)) if (!seen.has(m[1])) { seen.add(m[1]); refs.cases.push(m[1]); }
  }
  return refs;
}

/** 본문 핵심어: 법령명(사전 일치)·법률용어(용어 사전 일치) 빈도 상위. 불용어 목록 없이 사전 일치만. */
export function keywordsOf(text, termList, topN = 15) {
  const names = [...dictionary().entries.map((e) => e.n)].filter((n) => n.length >= 2);
  const counts = new Map();
  const t = String(text || "");
  for (const n of names) { let i = 0, c = 0; while ((i = t.indexOf(n, i)) >= 0) { c++; i += n.length; } if (c) counts.set(n, { term: n, kind: "law", count: c }); }
  for (const term of termList || []) { let i = 0, c = 0; while ((i = t.indexOf(term, i)) >= 0) { c++; i += term.length; } if (c) counts.set(term, { term, kind: "term", count: c }); }
  return [...counts.values()].sort((a, b) => b.count - a.count || b.term.length - a.term.length).slice(0, topN);
}

export default defineTool({
  name: "source_get",
  description: "판례·결정례·해석례·심판례·행정규칙·자치법규·조약의 본문 1건을 섹션별 전문으로 가져온다(mode=digest 는 원문 문장 발췌, keywords 는 법령명·용어 빈도). 참조조문·참조판례를 구조화해 돌려준다.",
  schema: {
    source: sourceEnum,
    id: z.string().min(1).max(20).optional(),
    caseNo: z.string().min(3).max(40).optional().describe("판례 사건번호(정확 일치)"),
    sections: z.array(z.string().max(20)).max(12).optional(),
    mode: z.enum(["full", "digest", "keywords"]).default("full"),
    maxBytes: S.maxBytes, part: S.part,
  },
  async handler(a) {
    let id = a.id; const cacheStates = [];
    if (!id && a.caseNo) { if (a.source !== "precedent") throw invalid("caseNo 는 precedent 에서만"); const r = await precedentIdByCaseNo(a.caseNo.replace(/\s+/g, "")); id = r.id; cacheStates.push(r.hit ? "hit" : "miss"); }
    if (!id) throw invalid("id 또는 caseNo 필요");
    const { root, hit } = await fetchSourceBody(a.source, id); cacheStates.push(hit ? "hit" : "miss");
    const doc = buildSourceDoc(a.source, root, id, a.sections);
    doc.refs = buildRefs(root, a.source);
    const warnings = [], notes = [];
    if (a.mode === "digest") {
      const pick = ["판시사항", "판결요지", "결정요지", "재결요지", "주문", "회답", "질의요지", "판정요지", "결정요지"].filter((s) => doc.sections[s]);
      const digest = {};
      for (const s of pick) { const ss = sentences(doc.sections[s]); let acc = [], len = 0; for (const x of ss) { if (len + x.length > 1500 && acc.length) break; acc.push(x); len += x.length; } digest[s] = acc.join(" "); }
      doc.sections = digest; notes.push("digest: 요지·주문 섹션의 원문 문장을 그대로 발췌(생성 요약 아님), 문장 경계에서 끊음");
    } else if (a.mode === "keywords") {
      const text = Object.values(doc.sections).join("\n");
      doc.keywords = keywordsOf(text, []); doc.sections = {}; notes.push("keywords: 법령명 사전 일치 빈도 상위(불용어 목록 없음)");
    }
    // 섹션 경계 페이지: 섹션들을 단위로 예산 분할
    const units = Object.entries(doc.sections).map(([k, v]) => ({ section: k, text: v }));
    const pg = paginateByBytes(units, { maxBytes: a.maxBytes, part: a.part, splitUnit: (u, budget) => { const parts = []; let cur = ""; for (const s of sentences(u.text)) { if (cur && Buffer.byteLength(cur + s) > budget - 200) { parts.push(cur); cur = ""; } cur += (cur ? " " : "") + s; } if (cur) parts.push(cur); return parts.length > 1 ? parts.map((t, i) => ({ section: u.section, text: t, part: i + 1, parts: parts.length, note: `${u.section} 섹션이 길어 ${parts.length}개 부분으로 나눔` })) : [u]; } });
    warnings.push(...pg.warnings);
    const sections = {}; for (const u of pg.items) sections[u.section + (u.part ? `#${u.part}` : "")] = u.text;
    const item = { ...doc, sections };
    const next = [];
    if (pg.hasMore) next.push({ tool: "source_get", args: { source: a.source, id, sections: a.sections, mode: a.mode, maxBytes: a.maxBytes, part: pg.part + 1 }, why: "이어받기" });
    if (a.source === "precedent" && doc.caseNo) next.push({ tool: "precedent_trace", args: { caseNo: doc.caseNo }, why: "이 판례의 인용 관계·생존 신호" });
    if (doc.refs.articles[0]) next.push({ tool: "article_get", args: { name: doc.refs.articles[0].law, articles: [doc.refs.articles[0].label] }, why: "참조조문 원문" });
    return ok({ items: [item], total: 1, page: { no: pg.part, size: 1, hasMore: pg.hasMore }, warnings, notes, cacheState: cacheStates.every((c) => c === "hit") ? "hit" : cacheStates.some((c) => c === "hit") ? "partial" : "miss", next });
  },
});
