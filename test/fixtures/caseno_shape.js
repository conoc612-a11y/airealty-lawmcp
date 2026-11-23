// 사건번호 형식 규칙의 불변 표본 — casenos.js 의 CASE_CODES 체계를 직접 참조하지 않는 블랙박스 검사용.
import { isCaseNo, findCaseNumbers } from "../../src/casenos.js";

export const casenoShape = {
  accepted: ["2023다12345", "2022가단4567", "2024고합123", "2025헌나8", "2021타경909090"],
  rejected: ["2026년 5월", "다12345", "2023다", "123456", "2023-다-12345"],
  extract: {
    text: "대법원 2023다12345 선고와 서울고등법원 2022라99 그리고 2026년 5월에 걸친 사건",
    expect: ["2023다12345", "2022라99"],
  },
  selfcheck: () => {
    for (const s of casenoShape.accepted) if (!isCaseNo(s)) return `accepted 실패: ${s}`;
    for (const s of casenoShape.rejected) if (isCaseNo(s)) return `rejected 실패: ${s}`;
    const f = findCaseNumbers(casenoShape.extract.text, new Date("2026-06-01T00:00:00Z"));
    const nos = f.map((x) => x.caseNo);
    for (const s of casenoShape.extract.expect) if (!nos.includes(s)) return `extract 실패: ${s}`;
    if (nos.length !== casenoShape.extract.expect.length) return `extract 과잉/과소: ${nos.join(",")}`;
    return null;
  },
};
