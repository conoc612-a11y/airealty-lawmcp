// caseno_verify — 사건번호 형식 검증 + 법제처 판례 DB로 1차 존재 확인.
// 사건번호 형식(연도+사건부호+일련번호)은 casenos.js 의 직접 작성 체계로 검사하고,
// 존재 확인은 법제처 precSearch(제목 검색)에서 같은 사건번호가 나오는지로 1차 선별한다.
// 대법원 사법정보공개포털은 캡차가 있어 서버 자동 확인이 불가 → notes 로 사용자 확인을 유도한다.
import { defineTool, ok, z } from "../tool.js";
import { invalid } from "../errors.js";
import { isCaseNo, findCaseNumbers } from "../casenos.js";
import { searchSource } from "./source_search.js";

const normalize = (s) => String(s || "").replace(/\s+/g, "");

export default defineTool({
  name: "caseno_verify",
  description:
    "사건번호 형식 검증(연도+사건부호+일련번호)과 법제처 판례 DB 1차 존재 확인을 한다. 텍스트를 주면 사건번호를 추출해 각각 확인한다. " +
    "판시 내용 대조와 최종 진위 확인은 1차 선별 이후 담당 변호사가 해야 한다(대법원 사법정보공개포털은 캡차 있음).",
  catalog: { summary: "사건번호 형식 검증 + 판례 DB 1차 존재 확인", tags: ["사건번호", "검증", "판례"], example: { caseNo: "2023다12345" } },
  schema: {
    caseNo: z.string().max(40).optional().describe("사건번호(예: 2023다12345, 2023다123456 형식)"),
    text: z.string().max(20000).optional().describe("사건번호를 추출할 텍스트(판결문 인용문 등) — caseNo 대신 사용"),
  },
  async handler(a) {
    if (!a.caseNo && !a.text) throw invalid("caseNo 또는 text 중 하나는 필수");
    const targets = [];
    if (a.caseNo) targets.push({ caseNo: normalize(a.caseNo), from: "input" });
    if (a.text) for (const f of findCaseNumbers(a.text)) targets.push({ caseNo: f.caseNo, from: "text", court: f.court });
    if (!targets.length) throw invalid("텍스트에서 사건번호를 찾지 못했습니다(연도+사건부호+일련번호 형식)");

    const items = [];
    const seen = new Set();
    for (const t of targets) {
      if (seen.has(t.caseNo)) continue;
      seen.add(t.caseNo);
      const validFormat = isCaseNo(t.caseNo);
      let foundInPrecedentDb = false;
      let matches = [];
      let partial = 0;
      const notes = [];
      if (validFormat) {
        try {
          const r = await searchSource("precedent", { query: t.caseNo, field: "title", sort: "relevance", page: 1, size: 10 });
          // 엄격 매칭: 업스트림 사건번호 필드(대시 포함 표기)에서 대시·공백을 제거한 뒤 입력 사건번호와 비교한다.
          // 부분 일치(번호 뒷자리만 같은 다른 부호 사건)를 거짓 양성으로 세지 않기 위함이다(실측 2026-11-22: '2024다22068' 검색에 '부산고등법원-2024-누-22068'이 걸림).
          const exact = (v) => normalize(v || "").replace(/-/g, "").includes(t.caseNo);
          matches = r.items.filter((it) => exact(it.caseNo)).map((it) => ({ id: it.id, title: it.title, caseNo: it.caseNo, date: it.date, court: it.court, link: it.link }));
          partial = r.items.length - matches.length;
          foundInPrecedentDb = matches.length > 0;
          if (!foundInPrecedentDb) notes.push("판례 DB(법제처 precSearch)에서 같은 사건번호를 찾지 못함 — 미공개·비송·신청·집행 사건은 판례 DB에 없을 수 있음");
          if (partial > 0) notes.push(`번호 일부만 같은 다른 사건 ${partial}건은 제외(엄격 비교)`);
        } catch {
          notes.push("판례 DB 조회 실패 — 형식 검증만 제공");
        }
      } else {
        notes.push("형식이 사건번호 체계와 맞지 않음(연도 4자리 + 사건부호 1~4자 + 일련번호)");
      }
      notes.push("1차 선별일 뿐 — 판시 내용은 판결문 전문으로 대조하고, 최종 진위는 대법원 사법정보공개포털(e-소송 사건검색)에서 직접 확인하세요");
      items.push({
        caseNo: t.caseNo,
        from: t.from,
        courtHint: t.court,
        validFormat,
        foundInPrecedentDb,
        matches,
        notes: [...new Set(notes)],
      });
    }
    return ok({ items, total: items.length, warnings: ["존재 확인은 1차 선별(법제처 판례 DB 제목 검색) — 최종 확인은 대법원 사법정보공개포털"] });
  },
});
