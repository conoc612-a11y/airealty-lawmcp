// research_run — 시나리오형 다단 조사 (SPEC §4.11). 단계는 다른 도구의 내부 함수 호출(MCP 왕복 없음), 실패 격리, 업스트림 상한.
// 시나리오는 airealty 상담(supabase/functions/chat law_lookup)에 실제로 들어오는 질문 유형에서 도출했다:
// 임대차 분쟁 · 청약 자격 · 정비사업 절차 · 중개 보수·의무 · 용도지역·건축 제한 · 양도·취득 세금 근거 · 계약서 점검 · 행위시 법령 · 법체계 · 개정 추적.
import { defineTool, ok, z, S, asOfYmd } from "../tool.js";
import statute_find from "./statute_find.js";
import article_get from "./article_get.js";
import statute_outline from "./statute_outline.js";
import annex_get from "./annex_get.js";
import statute_history from "./statute_history.js";
import source_search from "./source_search.js";
import contract_risk_scan from "./contract_risk_scan.js";
import { semantic_article_search, ordinance_link } from "./catalog.js";
import { extractCitations } from "../citations.js";
import { ensureDictionary, dictionary, normalizeName } from "../dictionary.js";
import { stats } from "../drf.js";
import { bytesOf } from "../envelope.js";
import { invalid } from "../errors.js";

export const SCENARIOS = ["rent_dispute", "housing_subscription", "redevelopment_procedure", "brokerage_duty", "zoning_check", "tax_on_transfer", "contract_check", "version_at", "statute_map", "amendment_watch"];

/** 분야 시나리오의 기본 법령(사전 정식명)과 선례 원천. 질문에 다른 법령이 보이면 그것을 앞에 둔다. */
const DOMAIN = {
  rent_dispute: { laws: ["주택임대차보호법", "상가건물 임대차보호법"], sources: ["precedent", "interpretation"], annex: null },
  housing_subscription: { laws: ["주택공급에 관한 규칙", "주택법"], sources: ["interpretation"], annex: "주택공급에 관한 규칙" },
  redevelopment_procedure: { laws: ["도시 및 주거환경정비법"], sources: ["precedent", "interpretation", "admin_appeal"], annex: null, delegation: true },
  brokerage_duty: { laws: ["공인중개사법", "공인중개사법 시행규칙"], sources: ["interpretation", "precedent"], annex: "공인중개사법 시행규칙" },
  zoning_check: { laws: ["국토의 계획 및 이용에 관한 법률", "건축법"], sources: ["interpretation", "admin_appeal"], annex: null, ordinances: true },
  tax_on_transfer: { laws: ["소득세법", "지방세법"], sources: ["tax_tribunal", "tax_ruling", "interpretation"], annex: null },
};

/** 질문에 등장한 법령명(사전 일치)의 소관부처 → 전문기관 원천. 키워드 표가 아니라 사전의 소관부처 필드로 라우팅한다. */
export function routeSources(lawNames) {
  const d = dictionary();
  const depts = new Set();
  for (const n of lawNames) { const e = d.entries.find((x) => normalizeName(x.n) === normalizeName(n)); if (e?.d) depts.add(e.d); }
  const out = new Set(["precedent", "interpretation", "admin_appeal"]);
  for (const dep of depts) {
    if (/재정경제부|국세청|기획재정부/.test(dep)) { out.add("tax_tribunal"); out.add("tax_ruling"); }
    if (/관세청/.test(dep)) out.add("customs_ruling");
    if (/고용노동부/.test(dep)) out.add("nlrc");
    if (/공정거래위원회/.test(dep)) out.add("ftc");
    if (/개인정보보호위원회/.test(dep)) out.add("pipc");
    if (/인사혁신처/.test(dep)) out.add("civil_service_appeal");
  }
  return [...out];
}

/** 도구 호출 1단계: 봉투를 요약 행으로 줄인다(원문 제외). */
function summarize(body, limit = 8) {
  if (!body?.ok) return { ok: false, error: body?.error };
  const strip = (it) => { if (!it || typeof it !== "object") return it; const { text, head, paragraphs, sections, amendmentNotes, children, ...rest } = it; if (rest.article && typeof rest.article === "object") { const { text: t2, paragraphs: p2, ...a2 } = rest.article; rest.article = a2; } return rest; };
  const items = Array.isArray(body.items) ? body.items.slice(0, limit).map(strip) : body.items;
  return { ok: true, total: body.total, items, ...(body.law ? { law: { name: body.law.name, lawId: body.law.lawId, mst: body.law.mst, effectiveDate: body.law.effectiveDate, upcoming: body.law.upcoming } } : {}), ...(body.summary ? { summary: body.summary } : {}), warnings: body.warnings?.length ? body.warnings : undefined };
}

export default defineTool({
  name: "research_run",
  description: "상담 질문 유형별 다단 조사(임대차·청약·정비사업·중개·용도지역·세금·계약서·행위시법·법체계·개정)를 묶어 단계 요약과 다음 호출을 준다.",
  schema: { scenario: z.enum(SCENARIOS), query: z.string().min(1).max(500), law: z.string().max(100).optional(), article: z.string().max(40).optional(), date: z.string().max(12).optional(), text: z.string().max(100000).optional(), budget: z.enum(["quick", "standard"]).default("quick") },
  async handler(a) {
    const limit = a.budget === "quick" ? 6 : 15;
    const startReq = stats.requests;
    const steps = []; const warnings = []; const next = [];
    const over = () => stats.requests - startReq >= limit;
    const run = async (name, tool, args, lim) => {
      if (over()) { steps.push({ name, ok: false, skipped: true, error: { code: "BUDGET", message: `업스트림 호출 상한(${limit}) 도달` } }); return null; }
      const body = await tool.invoke(args);
      const s = summarize(body, lim);
      steps.push({ name, ...s, args });
      if (!body.ok) warnings.push(`${name}: ${body.error?.code}`);
      return body.ok ? body : null;
    };
    await ensureDictionary();
    const D = asOfYmd(a.date);
    const cited = extractCitations(a.query + " " + (a.law || "")).filter((c) => c.kind === "statute" && c.law);
    const lawNames = [...new Set([...(a.law ? [a.law] : []), ...cited.map((c) => c.law), ...dictionary().entries.map((e) => e.n).filter((n) => n.length >= 3 && a.query.includes(n))])];
    const firstLaw = lawNames[0];
    const firstArticle = a.article || (cited[0] ? cited[0].label : undefined);
    const sc = a.scenario;
    const lawRef = () => (firstLaw ? { name: firstLaw } : null);
    const q50 = a.query.slice(0, 50);

    if (DOMAIN[sc]) {
      // 분야 시나리오 공통 틀: 근거 조문(의미검색 → 원문) → 분야별 보조 자료 → 선례·해석
      const dom = DOMAIN[sc];
      const domainLaws = [...new Set([...lawNames, ...dom.laws])];
      const s = await run("관련 조문 의미검색", semantic_article_search, { query: a.query, size: 5 }, 5);
      const hits = s?.items || [];
      const hit = hits.find((h) => h.label && domainLaws.some((n) => normalizeName(n) === normalizeName(h.law))) || hits.find((h) => h.label);
      const basisLaw = firstLaw && firstArticle ? firstLaw : hit?.law;
      const basisLabel = firstLaw && firstArticle ? firstArticle : hit?.label;
      if (basisLaw && basisLabel) { await run("근거 조문 원문", article_get, { name: basisLaw, articles: [basisLabel], maxBytes: 12000, format: "text" }, 1); next.push({ tool: "article_get", args: { name: basisLaw, articles: [basisLabel] }, why: "근거 조문 전문(항·호 구조)" }); }
      if (dom.delegation && basisLaw && basisLabel) await run("위임 하위 조문", statute_outline, { name: basisLaw, view: "delegation", article: basisLabel, size: 5 }, 5);
      if (dom.annex) await run("별표·서식(기준표)", annex_get, { name: dom.annex, size: 10 }, 10);
      if (dom.ordinances && basisLaw && basisLabel) {
        const o = await run("연계 자치법규 조문", ordinance_link, { name: basisLaw, mode: "articles", article: basisLabel, size: 10 }, 10);
        if (o?.items?.length) steps.push({ name: "안내", ok: true, items: [{ note: "용도지역·건폐율·용적률의 실제 수치는 해당 지자체 도시계획 조례가 정한다 — 연계 조례 조문을 source_get(ordinance) 으로 확인" }] });
      }
      const sources = [...new Set([...dom.sources, ...routeSources(domainLaws).filter((x) => dom.sources.includes(x))])].slice(0, 4);
      await run("선례·해석", source_search, { source: sources, query: q50, size: 5 }, 5);
      if (sc === "tax_on_transfer") steps.push({ name: "안내", ok: true, items: [{ note: "세율·공제 등 기준 숫자는 airealty 세금 계산기 규칙표(tax_rules)로 확인 — 여기서는 근거 조문과 선례만 묶었습니다" }] });
      if (sc === "rent_dispute") steps.push({ name: "안내", ok: true, items: [{ note: "유리/불리 판단 없이 자료만 묶었습니다. 사실관계(계약일·전입·확정일자·통지일)가 다르면 결론도 다릅니다." }] });
    } else if (sc === "contract_check") {
      if (!a.text) throw invalid("contract_check 는 text(계약서 전문) 필요");
      const r = await run("위험 신호", contract_risk_scan, { text: a.text, asOf: a.date, maxFindings: 10 }, 10);
      const findings = r?.items?.[0]?.findings || [];
      const basis = []; for (const f of findings) for (const b of f.basis || []) if (!basis.some((x) => x.law === b.law && x.label === b.label)) basis.push(b);
      for (const b of basis.slice(0, 3)) await run(`근거 ${b.law} ${b.label}`, article_get, { name: b.law, articles: [b.label], maxBytes: 12000, format: "text" }, 1);
      if (findings[0]) await run("관련 판례", source_search, { source: "precedent", query: (findings[0].basis?.[0]?.title || a.query).slice(0, 40), size: 3 }, 3);
    } else if (sc === "version_at") {
      if (!a.date) throw invalid("version_at 은 date 필요");
      const cands = lawNames.length ? lawNames : (await run("후보 법령", statute_find, { query: q50, size: 3 }, 3))?.items?.map((x) => x.name) || [];
      for (const n of cands.slice(0, 2)) { await run(`${n} 적용 판(${a.date})`, statute_history, { name: n, mode: "versions", asOf: a.date, size: 3 }, 3); if (firstArticle) await run(`${n} ${firstArticle} 당시 원문`, article_get, { name: n, articles: [firstArticle], asOf: a.date, maxBytes: 12000, format: "text" }, 1); }
      steps.push({ name: "경과규정 안내", ok: true, items: [{ note: "부칙의 경과규정은 article_get 목차 모드에서 부칙 항목을 확인하거나 statute_history old_new 로 보세요" }] });
    } else if (sc === "statute_map") {
      const f = await run("법령 확정", statute_find, { query: a.law || a.query, size: 5 }, 5);
      const top = f?.items?.[0]; const ref = top ? { lawId: top.lawId } : lawRef();
      if (ref) { await run("계층", statute_outline, { ...ref, view: "hierarchy" }, 1); await run("위임 요약", statute_outline, { ...ref, view: "delegation", size: 8 }, 8); await run("핵심 조문 목차", article_get, { ...ref, maxBytes: 20000 }, 30); await run("별표 목록", annex_get, { ...ref, size: 10 }, 10); next.push({ tool: "article_get", args: { ...ref, articles: ["제1조", "제2조"] }, why: "목적·정의 조문 원문" }); }
    } else if (sc === "amendment_watch") {
      const ref = lawRef(); if (!ref) throw invalid("법령명이 필요합니다(query 또는 law)");
      await run("시행예정 판", statute_history, { ...ref, mode: "versions", size: 5 }, 5);
      await run("최근 개정 신구 대조", statute_history, { ...ref, mode: "old_new", size: 5 }, 5);
      if (firstArticle) await run("조문 이력", statute_history, { ...ref, mode: "article_changes", article: firstArticle, size: 5 }, 5);
    }
    const body = ok({ items: [{ scenario: sc, steps }], total: steps.length, warnings, notes: [`업스트림 호출 ${stats.requests - startReq}/${limit}`], next, asOf: D });
    if (bytesOf(body) > 30000) { for (const s of steps) if (Array.isArray(s.items)) s.items = s.items.slice(0, 3); body.notes.push("크기 예산(30KB)으로 단계별 항목을 3개로 줄임"); }
    return body;
  },
});
