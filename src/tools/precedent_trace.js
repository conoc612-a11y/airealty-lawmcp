// precedent_trace — 판례의 나가는 참조·들어오는 인용·헌재 관련 → 생존 신호 (SPEC §4.9). 같은 블록을 두 번 내지 않는다.
import { defineTool, ok, z, S } from "../tool.js";
import { fetchSourceBody, precedentIdByCaseNo, buildRefs, cleanText } from "./source_get.js";
import { search, str } from "../upstream.js";
import { TTL } from "../cache.js";
import { cache } from "../cache.js";
import { fmtDate } from "../kst.js";
import { lawLink, precedentLink, constitutionalLink } from "../links.js";
import { invalid } from "../errors.js";
import { mergeCache } from "../envelope.js";

const OVERRULE_HINT = /(변경|폐기)(하기로|한다|하였다|함)|견해를\s*변경|판례를\s*변경|더 이상 유지|유지될 수 없/;

export default defineTool({
  name: "precedent_trace",
  description: "판례 한 건의 인용 관계를 본다: 참조조문·참조판례(나가는 참조), 그 사건번호를 본문에 담은 후속 판례(들어오는 인용), 관련 헌재결정, 그리고 '후속 인용 없음/인용됨/변경 가능성' 신호와 근거.",
  schema: { id: z.string().max(20).optional(), caseNo: z.string().max(40).optional(), depth: z.literal(1).default(1), include: z.array(z.enum(["outgoing", "incoming", "constitutional"])).default(["outgoing", "incoming", "constitutional"]) },
  async handler(a) {
    const cacheStates = []; const warnings = [], notes = [];
    let id = a.id;
    if (!id) { if (!a.caseNo) throw invalid("id 또는 caseNo 필요"); const r = await precedentIdByCaseNo(a.caseNo.replace(/\s+/g, "")); id = r.id; cacheStates.push(r.hit ? "hit" : "miss"); }
    const { root, hit } = await fetchSourceBody("precedent", id); cacheStates.push(hit ? "hit" : "miss");
    const caseNo = str(root["사건번호"]);
    const holding = cleanText(root["판시사항"] || "");
    const item = { case: { id, caseNo, title: str(root["사건명"]), court: str(root["법원명"]), date: fmtDate(str(root["선고일자"]).replace(/\D/g, "").slice(0, 8)), link: precedentLink(id), ...(holding ? { holding: holding.length > 300 ? holding.slice(0, 300) + "…" : holding } : {}) } };
    if (holding.length > 300) notes.push("case.holding 은 판시사항 앞 300자 — 전문은 source_get(sections:[\"판시사항\"])");
    if (a.include.includes("outgoing")) {
      const refs = buildRefs(root, "precedent");
      const caseText = cleanText(root["참조판례"] || "");
      const cases = [];
      for (const m of caseText.matchAll(/(대법원|헌법재판소|[가-힣]+법원)?\s*((?:\d{4}\.\s*\d{1,2}\.\s*\d{1,2}\.)?)\s*(?:선고|자)?\s*(\d{4}[가-힣]{1,4}\d{1,7})(?:[,\s]*(\d{1,7}))*\s*(전원합의체\s*)?(판결|결정)?(?:\(([^)]*)\))?/g)) {
        if (cases.some((c) => c.caseNo === m[3])) continue;
        cases.push({ caseNo: m[3], court: m[1] || undefined, date: m[2] ? fmtDate(m[2]) || undefined : undefined, kind: m[6] || undefined, enBanc: !!m[5] || undefined, reporter: m[7] || undefined });
      }
      item.outgoing = { articles: refs.articles.map((x) => ({ ...x, link: lawLink(x.law, x.label) })), cases };
    }
    if (a.include.includes("incoming") && caseNo) {
      const key = "incoming:" + caseNo; let inc = cache.get(key);
      if (!inc) {
        const r = await search("prec", { search: 2, query: caseNo, display: 50 }, { rowKeys: ["prec"], ttl: TTL.incoming }); cacheStates.push(r.hit ? "hit" : "miss");
        const rows = r.rows.filter((x) => str(x["판례일련번호"]) !== id && str(x["사건번호"]) !== caseNo);
        // 본문에 실제로 사건번호가 있는지 확인(검색 잡음 제외) — 상위 10건만 본문 확인
        const checked = [];
        for (const x of rows.slice(0, 10)) {
          try { const b = await fetchSourceBody("precedent", str(x["판례일련번호"])); const full = cleanText([b.root["판시사항"], b.root["판결요지"], b.root["참조판례"], b.root["판례내용"]].join("\n")); if (full.includes(caseNo)) { const snippet = sentenceAround(full, caseNo); checked.push({ id: str(x["판례일련번호"]), caseNo: str(x["사건번호"]), court: str(x["법원명"]), date: fmtDate(x["선고일자"]), link: precedentLink(str(x["판례일련번호"])), overruleHint: OVERRULE_HINT.test(snippet) ? snippet : undefined }); } } catch {}
        }
        inc = { total: checked.length, items: checked, searched: rows.length };
        cache.set(key, inc, TTL.incoming);
      } else cacheStates.push("hit");
      item.incoming = { total: inc.total, items: inc.items.map(({ overruleHint, ...x }) => x) };
      if (inc.searched > 10) notes.push(`본문검색 ${inc.searched}건 중 상위 10건만 본문을 확인`);
      const over = inc.items.find((x) => x.overruleHint);
      item.signal = over ? { label: "possibly_overruled", basis: `후속 판례 ${over.caseNo} 본문에 이 사건번호와 변경 취지 표현이 함께 있음: "${over.overruleHint.slice(0, 160)}"` } : inc.total ? { label: "cited_later", basis: `본문에 이 사건번호를 담은 후속 판례 ${inc.total}건(변경 취지 표현 없음)` } : { label: "no_later_citation", basis: "법제처 판례 본문검색에서 이 사건번호를 담은 다른 판례 없음(수록 범위 한정)" };
    } else item.signal = { label: "unknown", basis: "들어오는 인용을 확인하지 않음" };
    if (a.include.includes("constitutional")) {
      const q = item.outgoing?.articles?.[0] ? `${item.outgoing.articles[0].law} ${item.outgoing.articles[0].label}` : null;
      item.constitutional = [];
      if (q) { try { const r = await search("detc", { search: 2, query: q, display: 5 }, { rowKeys: ["Detc", "detc"] }); cacheStates.push(r.hit ? "hit" : "miss"); item.constitutional = r.rows.map((x) => ({ id: str(x["헌재결정례일련번호"]), caseNo: str(x["사건번호"]), title: str(x["사건명"]), date: fmtDate(x["종국일자"]), link: constitutionalLink(str(x["헌재결정례일련번호"])) })); notes.push(`헌재결정례는 첫 참조조문(${q})을 본문검색한 상위 5건`); } catch { warnings.push("헌재결정례 검색 실패"); } }
    }
    const next = [{ tool: "source_get", args: { source: "precedent", id }, why: "이 판례 전문" }];
    if (item.outgoing?.cases?.[0]) next.push({ tool: "precedent_trace", args: { caseNo: item.outgoing.cases[0].caseNo }, why: "참조판례의 인용 관계" });
    return ok({ items: [item], total: 1, warnings, notes, cacheState: mergeCache(cacheStates), next });
  },
});

function sentenceAround(text, needle) {
  const i = text.indexOf(needle); if (i < 0) return "";
  const s = Math.max(0, text.lastIndexOf(".", i) + 1); const e = text.indexOf(".", i + needle.length);
  return text.slice(s, e < 0 ? i + 200 : e + 1).trim();
}
