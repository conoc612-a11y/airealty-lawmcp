// toolbox — 카탈로그 도구 목록·설명·실행 (SPEC §2.4). 카탈로그 정의는 정적(시작 시 네트워크 없음).
import { defineTool, ok, z } from "../tool.js";
import { CATALOG_TOOLS } from "./catalog.js";
import { invalid } from "../errors.js";
import { zodToJsonSchema } from "../schema.js";

const byName = new Map(CATALOG_TOOLS.map((t) => [t.name, t]));
let coreNames = new Set();
export function setCoreNames(names) { coreNames = new Set(names); }

function score(t, q) {
  const words = q.toLowerCase().split(/[\s,]+/).filter(Boolean);
  const hay = [t.name, t.catalog.summary, ...(t.catalog.tags || []), t.description].join(" ").toLowerCase();
  let s = 0;
  for (const w of words) { if (t.name.includes(w)) s += 3; if ((t.catalog.tags || []).some((g) => g.toLowerCase().includes(w))) s += 2; if (hay.includes(w)) s += 1; }
  return s;
}

export default defineTool({
  name: "toolbox",
  description: "보조 도구 카탈로그(법령용어·약칭·개정피드·조문코드·조문참조·링크·유사판례·자치법규연계·행정규칙신구·의미검색·영문법령·조문+판례)를 찾고(list/describe) 실행한다(call).",
  schema: {
    action: z.enum(["list", "describe", "call"]),
    query: z.string().max(100).optional().describe("list 용 키워드"),
    name: z.string().max(40).optional().describe("describe/call 대상 도구 이름"),
    args: z.record(z.any()).optional().describe("call 인자"),
  },
  async handler(a) {
    if (a.action === "list") {
      let list = CATALOG_TOOLS.map((t) => ({ name: t.name, summary: t.catalog.summary.slice(0, 80), tags: t.catalog.tags }));
      if (a.query) { const scored = CATALOG_TOOLS.map((t) => ({ t, s: score(t, a.query) })).filter((x) => x.s > 0).sort((x, y) => y.s - x.s).slice(0, 10); list = scored.map(({ t, s }) => ({ name: t.name, summary: t.catalog.summary.slice(0, 80), tags: t.catalog.tags, score: s })); }
      return ok({ items: list, total: CATALOG_TOOLS.length, notes: ["describe 로 입력 스키마를, call 로 실행"], next: list[0] ? [{ tool: "toolbox", args: { action: "describe", name: list[0].name }, why: "입력 스키마" }] : [] });
    }
    if (!a.name) throw invalid("name 필요");
    const t = byName.get(a.name);
    if (!t) { if (coreNames.has(a.name)) throw invalid(`${a.name} 은 코어 도구 — 직접 부르세요`); throw invalid(`카탈로그에 없는 도구: ${a.name}`, "toolbox list 로 이름을 확인"); }
    if (a.action === "describe") {
      return ok({ items: [{ name: t.name, description: t.description, summary: t.catalog.summary, tags: t.catalog.tags, inputSchema: zodToJsonSchema(t.zod), example: { tool: "toolbox", args: { action: "call", name: t.name, args: t.catalog.example } } }], total: 1 });
    }
    return t.invoke(a.args || {});
  },
});
