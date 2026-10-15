// 법령 외 원천 20종 — 열거형 → 업스트림 target·행 키·필드 매핑 (SPEC §4.6, §4.7). 공개 가이드에서 확인한 값만.
import { str, digits } from "./upstream.js";
import { fmtDate } from "./kst.js";
import { precedentLink, interpretationLink, constitutionalLink, adminAppealLink, adminRuleLink, ordinanceLink, treatyLink, normalizeUpstreamLink } from "./links.js";

const D = (v) => fmtDate(digits(v).slice(0, 8));

/**
 * 각 원천: list{target,rowKeys,supports:{body,sort,date,court,org}}, body{target,idParam,sections[],title,date,agency,caseNo}
 * row(r) → 공통 코어 {id,title,caseNo,court/agency,date,kind,result,link,+extra≤3}
 */
export const SOURCES = {
  precedent: {
    label: "판례", list: { target: "prec", rowKeys: ["prec"], supports: { body: true, sort: { relevance: "", date_desc: "ddes", date_asc: "dasc" }, court: "curt", org: "org", date: "prncYd", caseNo: "nb" } },
    row: (r) => ({ id: str(r["판례일련번호"]), title: str(r["사건명"]), caseNo: str(r["사건번호"]), court: str(r["법원명"]), date: D(r["선고일자"]), kind: str(r["판결유형"]) || str(r["사건종류명"]), result: null, link: precedentLink(str(r["판례일련번호"])), dataSource: str(r["데이터출처명"]) || undefined }),
    body: { target: "prec", rootKey: "PrecService", idKey: "판례정보일련번호", title: "사건명", caseNo: "사건번호", agency: "법원명", date: "선고일자", sections: ["판시사항", "판결요지", "참조조문", "참조판례", "판례내용"], link: (id) => precedentLink(id) },
  },
  constitutional: {
    label: "헌재결정례", list: { target: "detc", rowKeys: ["Detc", "detc"], supports: { body: true, sort: { relevance: "", date_desc: "ddes", date_asc: "dasc" }, date: "edYd", caseNo: "nb" } },
    row: (r) => ({ id: str(r["헌재결정례일련번호"]), title: str(r["사건명"]), caseNo: str(r["사건번호"]), court: "헌법재판소", date: D(r["종국일자"]), kind: "결정", link: constitutionalLink(str(r["헌재결정례일련번호"])) }),
    body: { target: "detc", rootKey: "DetcService", idKey: "헌재결정례일련번호", title: "사건명", caseNo: "사건번호", agency: () => "헌법재판소", date: "종국일자", sections: ["판시사항", "결정요지", "심판대상조문", "참조조문", "참조판례", "전문"], link: (id) => constitutionalLink(id) },
  },
  tax_tribunal: {
    label: "조세심판례", list: { target: "ttSpecialDecc", rowKeys: ["decc"], supports: { body: true, sort: { relevance: "", date_desc: "ddes", date_asc: "dasc" }, date: "rslYd" } },
    row: (r) => ({ id: str(r["특별행정심판재결례일련번호"]), title: str(r["사건명"]), caseNo: str(r["청구번호"]) || str(r["사건번호"]), agency: str(r["재결청"]) || "조세심판원", date: D(r["의결일자"]), kind: "재결", result: resultFromTitle(str(r["사건명"])), link: null, claimNo: str(r["청구번호"]) || undefined, taxType: str(r["재결구분명"]) || undefined }),
    body: { target: "ttSpecialDecc", rootKey: "SpecialDeccService", idKey: "특별행정심판재결례일련번호", title: "사건명", caseNo: "청구번호", agency: "재결청", date: "의결일자", sections: ["재결요지", "주문", "청구취지", "이유", "관련법령", "따른결정", "참조결정"], link: () => null, extra: ["세목"] },
  },
  admin_appeal: {
    label: "행정심판례", list: { target: "decc", rowKeys: ["decc"], supports: { body: true, sort: { relevance: "", date_desc: "ddes", date_asc: "dasc" }, date: "rslYd" } },
    row: (r) => ({ id: str(r["행정심판재결례일련번호"]), title: str(r["사건명"]), caseNo: str(r["사건번호"]), agency: str(r["재결청"]), date: D(r["의결일자"]), kind: str(r["재결구분명"]) || "재결", link: adminAppealLink(str(r["행정심판재결례일련번호"])), disposer: str(r["처분청"]) || undefined }),
    body: { target: "decc", rootKey: "DeccService", idKey: "행정심판례일련번호", title: "사건명", caseNo: "사건번호", agency: "재결청", date: "의결일자", sections: ["재결요지", "주문", "청구취지", "이유"], link: (id) => adminAppealLink(id) },
  },
  interpretation: {
    label: "법령해석례(법제처)", list: { target: "expc", rowKeys: ["expc"], supports: { body: true, sort: { relevance: "", date_desc: "ddes", date_asc: "dasc" }, date: "explYd" } },
    row: (r) => ({ id: str(r["법령해석례일련번호"]), title: str(r["안건명"]), caseNo: str(r["안건번호"]), agency: str(r["회신기관명"]) || "법제처", date: D(r["회신일자"]), kind: "해석례", link: interpretationLink(str(r["법령해석례일련번호"])), inquirer: str(r["질의기관명"]) || undefined }),
    body: { target: "expc", rootKey: "ExpcService", idKey: "법령해석례일련번호", title: "안건명", caseNo: "안건번호", agency: "해석기관명", date: "해석일자", sections: ["질의요지", "회답", "이유"], link: (id) => interpretationLink(id) },
  },
  tax_ruling: {
    label: "국세청 해석", list: { target: "ntsCgmExpc", rowKeys: ["cgmExpc"], supports: { body: false, sort: { relevance: "", date_desc: "ddes", date_asc: "dasc" }, date: "explYd" } },
    row: (r) => ({ id: str(r["법령해석일련번호"]), title: str(r["안건명"]), caseNo: str(r["안건번호"]), agency: str(r["해석기관명"]) || "국세청", date: D(r["해석일자"]), kind: "해석", link: normalizeUpstreamLink(str(r["법령해석상세링크"])) }),
    body: null,
  },
  customs_ruling: {
    label: "관세청 해석", list: { target: "kcsCgmExpc", rowKeys: ["cgmExpc"], supports: { body: true, sort: { relevance: "", date_desc: "ddes", date_asc: "dasc" }, date: "explYd" } },
    row: (r) => ({ id: str(r["법령해석일련번호"]), title: str(r["안건명"]), caseNo: str(r["안건번호"]) || undefined, agency: str(r["해석기관명"]) || "관세청", date: D(r["해석일자"]), kind: "해석", link: null }),
    body: { target: "kcsCgmExpc", rootKey: "CgmExpcService", idKey: "법령해석일련번호", title: "안건명", caseNo: null, agency: "해석기관명", date: "해석일자", sections: ["질의요지", "회답", "이유", "관련법령"], link: () => null, linkKey: "관세법령정보포털원문링크" },
  },
  ftc: committee("ftc", "공정거래위원회 결정문", "Ftc", (r) => ({ id: str(r["결정문일련번호"]), title: str(r["사건명"]), caseNo: str(r["사건번호"]), agency: "공정거래위원회", date: D(r["결정일자"]), kind: str(r["문서유형"]) || "의결", decisionNo: str(r["결정번호"]).replace(/\s+/g, " ") || undefined }), ["주문", "결정요지", "이유", "신청취지", "의결문", "적용법조", "법위반내용", "시정권고사항"], { title: "사건명", caseNo: "사건번호", date: "의결일자" }),
  pipc: committee("ppc", "개인정보보호위원회 결정문", "Ppc", (r) => ({ id: str(r["결정문일련번호"]), title: str(r["안건명"]), caseNo: str(r["의안번호"]), agency: "개인정보보호위원회", date: D(r["의결일"]), kind: str(r["결정구분"]) || "의결" }), ["결정요지", "주문", "이유", "주요내용", "배경"], { title: "안건명", caseNo: "안건번호", date: "의결일자" }),
  nlrc: committee("nlrc", "노동위원회 결정문", "Nlrc", (r) => ({ id: str(r["결정문일련번호"]), title: str(r["제목"]), caseNo: str(r["사건번호"]), agency: "노동위원회", date: D(r["등록일"]), kind: "판정" }), ["판정요지", "판정사항", "판정결과", "내용"], { title: "제목", caseNo: "사건번호", date: "등록일" }),
  acr: committee("acr", "국민권익위원회 결정문", "Acr", (r) => ({ id: str(r["결정문일련번호"]), title: str(r["제목"]), caseNo: str(r["의안번호"]), agency: "국민권익위원회", date: D(r["의결일"]), kind: str(r["결정구분"]).replace(/\s+/g, "") || "의결" }), ["결정요지", "주문", "이유", "의결문"], { title: "제목", caseNo: "의안번호", date: "의결일" }),
  acr_adjudication: { // DRF target acrSpecialDecc(국민권익위원회 특별행정심판 재결례)
    label: "권익위 특별행정심판", list: { target: "acrSpecialDecc", rowKeys: ["decc"], supports: { body: true, sort: { relevance: "", date_desc: "ddes", date_asc: "dasc" }, date: "rslYd" } },
    row: (r) => ({ id: str(r["특별행정심판재결례일련번호"]), title: str(r["사건명"]), caseNo: str(r["사건번호"]), agency: str(r["재결청"]), date: D(r["의결일자"]), kind: "재결", link: null }),
    body: { target: "acrSpecialDecc", rootKey: "SpecialDeccService", idKey: "특별행정심판재결례일련번호", title: "사건명", caseNo: "사건번호", agency: "재결청", date: "의결일자", sections: ["재결요지", "주문", "청구취지", "이유", "관계법령"], link: () => null },
  },
  civil_service_appeal: { // DRF target adapSpecialDecc(소청심사위원회 결정)
    label: "소청심사 결정", list: { target: "adapSpecialDecc", rowKeys: ["decc"], supports: { body: true, sort: { relevance: "", date_desc: "ddes", date_asc: "dasc" }, date: "rslYd" } },
    row: (r) => ({ id: str(r["특별행정심판재결례일련번호"]), title: str(r["사건명"]), caseNo: str(r["사건번호"]), agency: str(r["재결청"]) || "소청심사위원회", date: D(r["의결일자"]), kind: "결정", link: null }),
    body: { target: "adapSpecialDecc", rootKey: "SpecialDeccService", idKey: "특별행정심판재결례일련번호", title: "사건명", caseNo: "사건번호", agency: "재결청", date: "의결일자", sections: ["재결요지", "처분요지", "소청이유", "주문", "이유"], link: () => null },
  },
  admin_rule: {
    label: "행정규칙", list: { target: "admrul", rowKeys: ["admrul"], supports: { body: true, sort: { relevance: "", date_desc: "ddes", date_asc: "dasc" }, org: "org", date: "prmlYd", allowEmptyQuery: true } },
    row: (r) => ({ id: str(r["행정규칙일련번호"]), title: str(r["행정규칙명"]), caseNo: str(r["발령번호"]) || undefined, agency: str(r["소관부처명"]), date: D(r["발령일자"]), kind: str(r["행정규칙종류"]), link: adminRuleLink(str(r["행정규칙명"])), ruleId: str(r["행정규칙ID"]) || undefined, effectiveDate: D(r["시행일자"]) || undefined, status: str(r["현행연혁구분"]) || undefined }),
    body: { target: "admrul", rootKey: "AdmRulService", idKey: "행정규칙일련번호", title: "행정규칙명", caseNo: "발령번호", agency: "소관부처명", date: "발령일자", sections: ["조문내용", "부칙", "별표", "개정문내용", "제개정이유내용"], link: (id, b) => adminRuleLink(str(b?.["행정규칙명"])) },
  },
  ordinance: {
    label: "자치법규", list: { target: "ordin", rowKeys: ["law"], supports: { body: true, sort: { relevance: "", date_desc: "ddes", date_asc: "dasc" }, region: "org", date: "ancYd", allowEmptyQuery: true } },
    row: (r) => ({ id: str(r["자치법규일련번호"]), title: str(r["자치법규명"]), caseNo: str(r["공포번호"]) || undefined, agency: str(r["지자체기관명"]), date: D(r["공포일자"]), kind: str(r["자치법규종류"]), link: ordinanceLink(str(r["자치법규명"])), ordinanceId: str(r["자치법규ID"]) || undefined, effectiveDate: D(r["시행일자"]) || undefined }),
    body: { target: "ordin", rootKey: "LawService", idKey: "자치법규일련번호", idParam: "MST", title: "자치법규명", caseNo: "공포번호", agency: "지자체기관명", date: "공포일자", sections: ["조문", "부칙", "별표", "개정문내용", "제개정이유내용"], link: (id, b) => ordinanceLink(str(b?.["자치법규명"])) },
  },
  treaty: {
    label: "조약", list: { target: "trty", rowKeys: ["Trty", "trty"], supports: { body: true, sort: { relevance: "", date_desc: "ddes", date_asc: "dasc" }, date: "eftYd" } },
    row: (r) => ({ id: str(r["조약일련번호"]), title: str(r["조약명"]), caseNo: str(r["조약번호"]) || undefined, agency: "외교부", date: D(r["발효일자"]), kind: str(r["조약구분명"]), link: treatyLink(str(r["조약일련번호"])), signedDate: D(r["서명일자"]) || undefined }),
    body: { target: "trty", rootKey: "TrtyService", idKey: "조약일련번호", title: "조약명_한글", caseNo: "조약번호", agency: () => "외교부", date: "발효일자", sections: ["조약내용", "비고", "추가정보"], link: (id) => treatyLink(id) },
  },
  school_rule: schoolLike("school", "학칙"),
  public_corp_rule: schoolLike("public", "지방공사·공단 규정"),
  public_inst_rule: schoolLike("pi", "공공기관 규정"),
  english: {
    label: "영문법령", list: { target: "elaw", rowKeys: ["law"], supports: { body: true, sort: { relevance: "", date_desc: "ddes", date_asc: "dasc" }, date: "ancYd", allowEmptyQuery: true } },
    row: (r) => ({ id: str(r["법령일련번호"]), title: str(r["법령명영문"]).replace(/<[^>]+>/g, ""), caseNo: str(r["공포번호"]) || undefined, agency: str(r["소관부처명"]).split(",")[0], date: D(r["시행일자"]), kind: str(r["법령구분명"]), link: null, koreanName: str(r["법령명한글"]), lawId: str(r["법령ID"]) || undefined }),
    body: { target: "elaw", rootKey: null, idKey: null, idParam: "MST", title: null, sections: null, link: () => null },
  },
};

function committee(target, label, rootKey, row, sections, keys) {
  return {
    label, list: { target, rowKeys: [target], supports: { body: true, sort: { relevance: "", date_desc: "ddes", date_asc: "dasc" } } },
    row: (r) => ({ ...row(r), link: null }),
    body: { target, rootKey: rootKey + "Service", idKey: "결정문일련번호", title: keys.title, caseNo: keys.caseNo, agency: "기관명", date: keys.date, sections, link: () => null },
  };
}
function schoolLike(target, label) {
  return {
    label, list: { target, rowKeys: ["admrul"], supports: { body: true, sort: { relevance: "", date_desc: "ddes", date_asc: "dasc" }, date: "prmlYd" } },
    row: (r) => ({ id: str(r["행정규칙일련번호"]), title: str(r["행정규칙명"]), caseNo: str(r["발령번호"]) || undefined, agency: str(r["소관부처명"]), date: D(r["발령일자"]), kind: str(r["행정규칙종류"]), link: null, ruleId: str(r["행정규칙ID"]) || undefined }),
    body: { target, rootKey: "AdmRulService", idKey: "행정규칙일련번호", title: "행정규칙명", caseNo: "발령번호", agency: "소관부처명", date: "발령일자", sections: ["조문내용", "부칙내용", "개정문내용", "제개정이유내용"], link: () => null },
  };
}
function resultFromTitle(t) { const m = t.match(/\((인용|기각|각하|취소|일부인용|경정|재조사)\)\s*$/); return m ? m[1] : null; }

export const SOURCE_NAMES = Object.keys(SOURCES);
