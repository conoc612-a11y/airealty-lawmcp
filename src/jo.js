// 조문 표기 ↔ 정규형 ↔ DRF 6자리 조문코드 (SPEC §3.3 · 카탈로그 jo_code).
// 정규형: {article, branch, paragraph?, item?, subitem?} — article/branch 숫자, paragraph/item 숫자, subitem '가'~'하'.

const CIRCLED = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳㉑㉒㉓㉔㉕㉖㉗㉘㉙㉚㉛㉜㉝㉞㉟㊱㊲㊳㊴㊵㊶㊷㊸㊹㊺㊻㊼㊽㊾㊿";
const MOK = "가나다라마바사아자차카타파하거너더러머버서어저처커터퍼허";

export function circledToNumber(ch) {
  const i = CIRCLED.indexOf(ch);
  return i >= 0 ? i + 1 : null;
}
export function numberToCircled(n) { return CIRCLED[n - 1] || `(${n})`; }
export function mokIndex(ch) { const i = MOK.indexOf(ch); return i >= 0 ? i + 1 : null; }

/**
 * "제15조" "15조" "15" "제155조의2" "155의2" "제8조제1항제2호가목" "제8조 제1항 제2호 가목" 등 → 정규형.
 * 못 읽으면 null.
 */
export function parseArticleRef(input) {
  if (input == null) return null;
  const s = String(input).replace(/\s+/g, "");
  if (!s) return null;
  const m = s.match(/^(?:제)?(\d{1,4})(?:조)?(?:의(\d{1,3}))?(?:제?(\d{1,3})항)?(?:제?(\d{1,3})호(?:의(\d{1,3}))?)?(?:([가-힣])목)?$/);
  if (!m) return null;
  const ref = { article: +m[1], branch: m[2] ? +m[2] : 0 };
  if (m[3]) ref.paragraph = +m[3];
  if (m[4]) { ref.item = +m[4]; if (m[5]) ref.itemBranch = +m[5]; }
  if (m[6]) { if (!mokIndex(m[6])) return null; ref.subitem = m[6]; }
  return ref;
}

/** 정규형 → "제15조", "제155조의2", "제8조제1항제2호가목". */
export function formatArticleRef(ref, { spaced = false } = {}) {
  if (!ref) return "";
  let s = `제${ref.article}조` + (ref.branch ? `의${ref.branch}` : "");
  const sp = spaced ? " " : "";
  if (ref.paragraph) s += `${sp}제${ref.paragraph}항`;
  if (ref.item) s += `${sp}제${ref.item}호` + (ref.itemBranch ? `의${ref.itemBranch}` : "");
  if (ref.subitem) s += `${sp}${ref.subitem}목`;
  return s;
}

/** 조 라벨만("제15조"/"제155조의2"). */
export function articleLabel(article, branch = 0) {
  return `제${article}조` + (branch ? `의${branch}` : "");
}

/** 정규형 → DRF JO 6자리(조 4자리 + 가지 2자리). 범위 밖이면 null. */
export function toJoCode(ref) {
  if (!ref || !(ref.article >= 1 && ref.article <= 9999) || !(ref.branch >= 0 && ref.branch <= 99)) return null;
  return String(ref.article).padStart(4, "0") + String(ref.branch).padStart(2, "0");
}

/** "001502" → {article:15, branch:2}. */
export function fromJoCode(code) {
  const m = String(code || "").match(/^(\d{4})(\d{2})$/);
  if (!m) return null;
  return { article: +m[1], branch: +m[2] };
}

/** 항·호 6자리 코드(HANG/HO 파라미터용). */
export function toSubCode(n, branch = 0) {
  if (!(n >= 1 && n <= 9999)) return null;
  return String(n).padStart(4, "0") + String(branch).padStart(2, "0");
}

/** 같은 조인가(가지번호까지). */
export function sameArticle(a, b) { return !!a && !!b && a.article === b.article && (a.branch || 0) === (b.branch || 0); }
