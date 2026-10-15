// 도구 레지스트리 — 코어 12 + 카탈로그 12. tools/list 항목은 미리 만들어 둔다(서버 인스턴스 생성 비용 최소화).
import statute_find from "./tools/statute_find.js";
import article_get from "./tools/article_get.js";
import statute_outline from "./tools/statute_outline.js";
import annex_get from "./tools/annex_get.js";
import statute_history from "./tools/statute_history.js";
import source_search from "./tools/source_search.js";
import source_get from "./tools/source_get.js";
import citation_audit from "./tools/citation_audit.js";
import precedent_trace from "./tools/precedent_trace.js";
import contract_risk_scan from "./tools/contract_risk_scan.js";
import research_run from "./tools/research_run.js";
import toolbox, { setCoreNames } from "./tools/toolbox.js";
import { CATALOG_TOOLS } from "./tools/catalog.js";
import { zodToJsonSchema } from "./schema.js";
import { toMcp } from "./envelope.js";

export const CORE_TOOLS = [statute_find, article_get, statute_outline, annex_get, statute_history, source_search, source_get, citation_audit, precedent_trace, contract_risk_scan, research_run, toolbox];
export { CATALOG_TOOLS };
setCoreNames(CORE_TOOLS.map((t) => t.name));

/** 도구 제목(Claude 커넥터 리뷰 기준: title + readOnlyHint 필수). 모든 도구는 읽기 전용·외부(법제처) 조회다. */
const TITLES = { statute_find: "법령 찾기", article_get: "조문 보기", statute_outline: "법령 구조·체계도", annex_get: "별표·서식", statute_history: "법령 연혁·판", source_search: "판례·해석례 검색", source_get: "판례·해석례 본문", citation_audit: "인용 검증", precedent_trace: "판례 추적", contract_risk_scan: "계약서 위험 점검", research_run: "법령 리서치 묶음", toolbox: "보조 도구 12종" };
/** tools/list 에 실릴 항목(미리 계산). */
export const TOOL_LIST = CORE_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: zodToJsonSchema(t.zod), annotations: { title: TITLES[t.name] || t.name, readOnlyHint: true } }));
export const TOOL_LIST_BYTES = Buffer.byteLength(JSON.stringify({ tools: TOOL_LIST }), "utf8");

const byName = new Map(CORE_TOOLS.map((t) => [t.name, t]));
export function getTool(name) { return byName.get(name); }
export async function callTool(name, args) {
  const t = byName.get(name);
  if (!t) return toMcp({ ok: false, error: { code: "INVALID_INPUT", message: `알 수 없는 도구: ${name}`, retryable: false }, meta: {} });
  return toMcp(await t.invoke(args));
}
