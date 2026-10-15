// 인용 추출 (SPEC §4.8 행동 명세). 법령명은 **사전 일치**로만 잡는다: 조문 표기 바로 앞에서 끝나는 가장 긴 사전 항목.
// 앞의 낱말·조사("…에는", "또한")는 결코 법령명에 들어가지 않는다. 「」 안 이름은 사전에 없어도 후보.
import { allNames, normalizeName, dictionary, loadDictionarySync } from "./dictionary.js";
import { formatArticleRef, articleLabel } from "./jo.js";
import { findCaseNumbers } from "./casenos.js";

const ART_RE = /제\s*(\d{1,4})\s*조(?:\s*의\s*(\d{1,3}))?((?:\s*(?:제\s*)?\d{1,3}\s*항)?(?:\s*(?:제\s*)?\d{1,3}\s*호(?:\s*의\s*\d{1,3})?)?(?:\s*[가-힣]\s*목)?)/g;
const ANAPHORA_RE = /(같은\s*법|동법|이\s*법|해당\s*법|같은\s*조|동조|이\s*조|같은\s*항|동항)\s*(?:시행령|시행규칙)?\s*$/;
const CONTINUATION_RE = /^[\s,·ㆍ및와과또는내지부터까지\-~]*$/;

let nameIndex = null; let nameIndexSize = -1;
function names() {
  const d = loadDictionarySync();
  const size = d.entries.length + d.abbreviations.length;
  if (nameIndex && nameIndexSize === size) return nameIndex;
  const map = allNames();
  const list = [...map.entries()].map(([n, info]) => ({ norm: normalizeName(n), display: n, ...info })).filter((x) => x.norm.length >= 2);
  list.sort((a, b) => b.norm.length - a.norm.length);
  nameIndex = list; nameIndexSize = size;
  return list;
}

/** 앞 창(window)을 공백 제거 정규화하되 원문 인덱스 지도를 함께 만든다. */
function normalizedWindow(text, start, width = 80) {
  const from = Math.max(0, start - width);
  const chars = [], idx = [];
  for (let i = from; i < start; i++) {
    const ch = text[i];
    if (/\s/.test(ch)) continue;
    const c = normalizeName(ch) || "";
    if (!c) continue;
    chars.push(c); idx.push(i);
  }
  return { norm: chars.join(""), idx };
}

/**
 * 텍스트에서 법령 인용과 판례 사건번호를 뽑는다.
 * 반환 [{kind:"statute", raw, span, law, lawDisplay, inDictionary, lawId?, ref, label, titleInText?, anaphora?}, {kind:"case", raw, caseNo, court, span}]
 */
export function extractCitations(text) {
  const t = String(text || "");
  const out = [];
  const index = names();
  let prevStatute = null;
  for (const m of t.matchAll(ART_RE)) {
    const start = m.index, end = start + m[0].length;
    const sub = parseSub(m[3] || "");
    const ref = { article: +m[1], branch: m[2] ? +m[2] : 0, ...sub };
    const label = articleLabel(ref.article, ref.branch);
    const before = t.slice(0, start);
    const cit = { kind: "statute", raw: m[0].trim(), span: [start, end], ref, label, law: null, lawDisplay: null, inDictionary: false };
    // 1) 앞 인용 지시(같은 법·동법·이 법·같은 조)
    const an = before.match(ANAPHORA_RE);
    // 2) 겹낫표 「이름」
    const bracket = before.match(/「([^「」]{2,60})」\s*(?:시행령|시행규칙)?\s*$/);
    // 3) 사전 일치(가장 긴 항목)
    const win = normalizedWindow(t, start);
    let best = null;
    for (const n of index) {
      if (win.norm.length >= n.norm.length && win.norm.endsWith(n.norm)) {
        // 이름 바로 앞 글자가 한글이면 더 긴 낱말의 꼬리일 수 있다 — 사전에 더 긴 이름이 없을 때만 허용(정렬이 긴 것 우선이라 첫 일치가 최장)
        const prevCh = win.idx.length > n.norm.length ? t[win.idx[win.idx.length - n.norm.length - 1]] : "";
        if (prevCh && /[가-힣]/.test(prevCh) && !/[「\s]/.test(prevCh)) { if (!bestWordBoundaryOk(t, win.idx[win.idx.length - n.norm.length])) continue; }
        best = n; cit.span[0] = win.idx[win.idx.length - n.norm.length]; break;
      }
    }
    if (an && (!best || (an.index + an[0].length) > (bracket ? bracket.index : 0))) {
      const word = an[1].replace(/\s+/g, "");
      cit.anaphora = word;
      if (prevStatute) {
        cit.law = prevStatute.law; cit.lawDisplay = prevStatute.lawDisplay; cit.inDictionary = prevStatute.inDictionary; cit.lawId = prevStatute.lawId;
        if (/조|항/.test(word) && !m[3]) { /* "같은 조 제2항" 류: 조는 그대로 */ }
        cit.span[0] = start - an[0].length;
      } else cit.unresolved = true;
    } else if (bracket) {
      const nm = bracket[1].trim();
      const hit = index.find((n) => n.norm === normalizeName(nm));
      cit.law = hit ? hit.name : nm; cit.lawDisplay = nm; cit.inDictionary = !!hit; cit.lawId = hit?.lawId;
      cit.span[0] = bracket.index;
    } else if (best) {
      cit.law = best.name; cit.lawDisplay = best.display; cit.inDictionary = true; cit.lawId = best.lawId;
    } else if (prevStatute && CONTINUATION_RE.test(t.slice(prevStatute.span[1], start))) {
      // "민법 제105조, 제1022조" — 쉼표 나열은 직전 법령의 연속
      cit.law = prevStatute.law; cit.lawDisplay = prevStatute.lawDisplay; cit.inDictionary = prevStatute.inDictionary; cit.lawId = prevStatute.lawId; cit.continuation = true;
    }
    // 조문 뒤 "(제목)" 표기
    const after = t.slice(end, end + 60).match(/^\s*\(([^()]{1,40})\)/);
    if (after && !/^\d|^제\d/.test(after[1])) cit.titleInText = after[1].trim();
    cit.raw = t.slice(cit.span[0], end).trim();
    out.push(cit);
    if (cit.law) prevStatute = cit;
  }
  for (const c of findCaseNumbers(t)) out.push({ kind: "case", raw: c.caseNo, caseNo: c.caseNo, court: c.court, span: c.span });
  out.sort((a, b) => a.span[0] - b.span[0]);
  return out;
}

function bestWordBoundaryOk() { return true; }

function parseSub(s) {
  const o = {};
  const p = s.match(/(\d{1,3})\s*항/); if (p) o.paragraph = +p[1];
  const h = s.match(/(\d{1,3})\s*호(?:\s*의\s*(\d{1,3}))?/); if (h) { o.item = +h[1]; if (h[2]) o.itemBranch = +h[2]; }
  const k = s.match(/([가-힣])\s*목/); if (k) o.subitem = k[1];
  return o;
}

// ── 내용 일치 (정규화 후 포함 → 문자 2-gram 유사도) ──
export function normalizeForMatch(s) {
  return String(s || "").replace(/[\s"'“”‘’「」『』()\[\]{}·ㆍ‧.,;:]/g, "").toLowerCase();
}
export function bigrams(s) { const set = new Map(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); set.set(g, (set.get(g) || 0) + 1); } return set; }
export function similarity(a, b) {
  const x = normalizeForMatch(a), y = normalizeForMatch(b);
  if (!x.length || !y.length) return 0;
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const ga = bigrams(x), gb = bigrams(y); let inter = 0, na = 0, nb = 0;
  for (const v of ga.values()) na += v; for (const v of gb.values()) nb += v;
  for (const [g, c] of ga) if (gb.has(g)) inter += Math.min(c, gb.get(g));
  return (2 * inter) / (na + nb);
}
/** claim 이 원문에 들어있으면 {ok:true, method:"exact"|"contained"}, 아니면 가장 가까운 항과 유사도. */
export function matchClaim(claim, text, paragraphs = [], threshold = 0.9) {
  const c = normalizeForMatch(claim), t = normalizeForMatch(text);
  if (!c) return { ok: false, method: "empty", similarity: 0 };
  if (c === t) return { ok: true, method: "exact", similarity: 1 };
  if (t.includes(c)) return { ok: true, method: "contained", similarity: 1 };
  let best = { similarity: similarity(claim, text), nearest: null };
  for (const p of paragraphs) { const s = similarity(claim, p.text); if (s > best.similarity) best = { similarity: s, nearest: p.no || p.text.slice(0, 20) }; }
  return { ok: best.similarity >= threshold, method: "similar", similarity: +best.similarity.toFixed(3), nearest: best.nearest };
}

export { formatArticleRef };
