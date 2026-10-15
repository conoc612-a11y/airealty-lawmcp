// contract_risk_scan — 계약서·약관의 조항별 위험 신호를 근거 조문과 함께 (SPEC §5). API 호출 없음.
import { defineTool, ok, z, S, asOfYmd } from "../tool.js";
import { analyze, RULE_DATA } from "../risk/engine.js";
import { invalid } from "../errors.js";

export default defineTool({
  name: "contract_risk_scan",
  description: "계약서·약관 전문(200자 이상)을 조항별로 훑어 기간·갱신·증액·대항력·해지·위약금·수선·권리금·면책·중개·신고의 검토 신호를 근거 조문(법령·조문·시행일)과 수치·충돌·등급으로 돌려준다(위법 판정 아님).",
  schema: { text: z.string().max(100000), docType: z.enum(Object.keys(RULE_DATA.docTypes)).optional(), asOf: S.asOf, maxFindings: z.number().int().min(1).max(100).default(20) },
  async handler(a) {
    const D = asOfYmd(a.asOf);
    if (a.text.trim().length < 200) throw invalid("계약서·약관 전문 필요(200자 이상)");
    const r = analyze(a.text, { docType: a.docType, maxFindings: a.maxFindings });
    const notes = ["출력은 '검토 필요 신호'이며 위법 판정이 아닙니다. 각 finding 의 basis 조문 원문은 article_get 으로 확인하세요", "규칙 수치(증액 상한·전환율·보수 요율)는 basis 의 effectiveDate 기준 현행 조문에서 가져온 값입니다"];
    const warnings = [];
    if (r.docType.value === "other") warnings.push("문서 유형을 판별하지 못해 모든 규칙을 느슨하게 적용했습니다(docType 로 지정 가능)");
    if (r.findingsTotal > r.findings.length) warnings.push(`신호 ${r.findingsTotal}건 중 상위 ${r.findings.length}건만 표시(maxFindings)`);
    const next = [];
    const firstBasis = r.findings[0]?.basis?.[0];
    if (firstBasis) next.push({ tool: "article_get", args: { name: firstBasis.law, articles: [firstBasis.label] }, why: `${r.findings[0].rule} 근거 조문 원문` });
    next.push({ tool: "research_run", args: { scenario: "contract_check", query: r.docType.label, text: a.text.slice(0, 100000) }, why: "위험 항목별 근거 조문 원문 + 판례" });
    return ok({ items: [r], total: r.findings.length, warnings, notes, asOf: D, next, cacheState: "hit" });
  },
});
