// 문서 위험 분석 엔진 (SPEC §5). API 호출 없음. 규칙 데이터(rules.json)의 판정 요소를 조항 단위로 찾는다.
// 탐지 방식은 자체 설계: 조항 분할 → 조항 안의 문장 묶음에서 "요소 용어 집합"의 AND(각 집합은 OR) + 제외 용어 + 수치 검사.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { lawLink } from "../links.js";

const RULES = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "rules.json"), "utf8"));
export const RULE_DATA = RULES;

// ── 조항 분할: "제N조(제목)" 머리, "N." 번호 머리, "[특약]" 류 머리, 빈 줄 ──
const CLAUSE_HEAD = /^(?:\s*)(제\s*\d{1,3}\s*조(?:의\s*\d{1,2})?\s*(?:\([^)]{0,40}\))?|[①-⑳]|\(?\d{1,2}[.)]\s|\[[^\]]{1,20}\]|특약\s*(?:사항)?\s*[:：]?|[가-힣]\.\s)/;
export function splitClauses(text) {
  const lines = text.split(/\r?\n/);
  const clauses = []; let cur = null; let pos = 0;
  const flush = () => { if (cur && cur.text.trim()) clauses.push({ ...cur, text: cur.text.trim(), span: [cur.start, cur.end] }); cur = null; };
  for (const raw of lines) {
    const start = pos; pos += raw.length + 1;
    const line = raw.trim();
    const head = line.match(CLAUSE_HEAD);
    if (!line) { continue; }
    if (head || !cur) {
      flush();
      const noMatch = line.match(/^제\s*(\d{1,3})\s*조(?:의\s*(\d{1,2}))?/);
      const no = noMatch ? `제${noMatch[1]}조${noMatch[2] ? `의${noMatch[2]}` : ""}` : (line.match(/^(\(?\d{1,2}|[①-⑳]|\[[^\]]+\]|[가-힣])/)?.[1] || "");
      const titleMatch = line.match(/^제\s*\d{1,3}\s*조(?:의\s*\d{1,2})?\s*\(([^)]{1,40})\)/);
      cur = { no: no || `#${clauses.length + 1}`, title: titleMatch ? titleMatch[1] : undefined, text: line, start, end: start + raw.length };
    } else { cur.text += "\n" + line; cur.end = start + raw.length; }
  }
  flush();
  if (!clauses.length) clauses.push({ no: "#1", text: text.trim(), span: [0, text.length] });
  return clauses;
}

// ── 문서 유형 판별 ──
export function detectDocType(text, override) {
  const types = RULES.docTypes; const scores = {}; const signals = {};
  for (const [k, def] of Object.entries(types)) {
    let s = 0; const hit = [];
    for (const [term, w] of def.signals) { const c = count(text, term); if (c) { s += w * Math.min(c, 5); hit.push(`${term}×${c}`); } }
    for (const [term, w] of def.exclude || []) { const c = count(text, term); if (c) s -= w * Math.min(c, 5); }
    scores[k] = Math.max(0, s); signals[k] = hit;
  }
  const sum = Object.values(scores).reduce((a, b) => a + b, 0) || 1;
  const [best, bestScore] = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  const value = override || (bestScore > 0 ? best : "other");
  return { value, confidence: override ? 1 : +(bestScore / sum).toFixed(2), signals: signals[value] || [], scores, basis: types[value]?.basis || [] };
}
function count(text, term) { let i = 0, c = 0; while ((i = text.indexOf(term, i)) >= 0) { c++; i += term.length; } return c; }

// ── 수치 추출 ──
const KOR_NUM = { "일": 1, "이": 2, "삼": 3, "사": 4, "오": 5, "육": 6, "칠": 7, "팔": 8, "구": 9, "십": 10, "백": 100, "천": 1000, "만": 10000, "억": 100000000 };
export function parseKoreanAmount(s) {
  // "1억 2천만원" "5,000만원" "3천500만원" "금 삼천만원" "500,000원" → 원 단위 정수
  const t = s.replace(/[,\s]/g, "").replace(/^금/, "");
  let total = 0, cur = 0, hadDigit = false;
  const m = t.match(/^((?:\d+(?:\.\d+)?|[일이삼사오육칠팔구십백천만억]+)+)원?$/);
  if (!m) return null;
  const tokens = m[1].match(/\d+(?:\.\d+)?|[일이삼사오육칠팔구십백천만억]/g) || [];
  let section = 0; // 만·억 사이의 소단위(천·백·십) 누적
  for (const tok of tokens) {
    if (/^\d/.test(tok)) { cur = parseFloat(tok); hadDigit = true; continue; }
    const v = KOR_NUM[tok];
    if (v >= 10000) { let mult = section + cur; if (mult === 0) mult = 1; total += mult * v; section = 0; cur = 0; hadDigit = false; }
    else if (v >= 10) { section += (cur || 1) * v; cur = 0; hadDigit = false; }
    else { cur = cur * 10 + v; hadDigit = true; }
  }
  total += section + cur;
  return Math.round(total);
}

export function extractFigures(text) {
  const amounts = [], periods = [], dates = [];
  const amtRe = /((?<![가-힣])금\s*)?((?<![\d,.])(?:\d[\d,]*(?:\.\d+)?|[일이삼사오육칠팔구십백천만억]+)(?:\s*(?:억|천만|백만|십만|만|천|백)\s*(?:\d[\d,]*)?)*)\s*원(?:정)?/g;
  for (const m of text.matchAll(amtRe)) {
    const value = parseKoreanAmount(m[0].replace(/원정?$/, "").replace(/^금\s*/, "") + "원");
    if (value == null || value < 1000) continue;
    const before = text.slice(Math.max(0, m.index - 30), m.index);
    const label = RULES.figures.amountLabels.filter((l) => before.includes(l)).sort((a, b) => before.lastIndexOf(b) - before.lastIndexOf(a))[0] || "금액";
    amounts.push({ label, value, unit: "원", raw: m[0].trim(), span: [m.index, m.index + m[0].length] });
  }
  for (const m of text.matchAll(/(?<![\d])(\d{1,3})\s*(년|개월|달|월|주|일)(?![\d])/g)) {
    if (m[2] === "월" && /^\d{1,2}$/.test(m[1]) && /\d{4}\s*년\s*$/.test(text.slice(Math.max(0, m.index - 8), m.index))) continue; // 날짜의 '월'
    if (m[2] === "일" && /\d{1,2}\s*월\s*$/.test(text.slice(Math.max(0, m.index - 6), m.index))) continue; // 날짜의 '일'
    const before = text.slice(Math.max(0, m.index - 25), m.index + m[0].length + 10);
    const label = RULES.figures.periodLabels.filter((l) => before.includes(l)).sort((a, b) => b.length - a.length)[0] || "기간";
    const unit = m[2] === "달" ? "개월" : m[2] === "월" ? "개월" : m[2];
    periods.push({ label, value: +m[1], unit, raw: m[0], span: [m.index, m.index + m[0].length] });
  }
  for (const m of text.matchAll(/(\d{4})\s*[.년]\s*(\d{1,2})\s*[.월]\s*(\d{1,2})\s*일?\.?/g)) dates.push({ value: `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`, raw: m[0].trim(), span: [m.index, m.index + m[0].length] });
  return { amounts, periods, dates };
}

const toMonths = (p) => (p.unit === "년" ? p.value * 12 : p.unit === "개월" ? p.value : p.unit === "주" ? p.value / 4 : p.value / 30);

// ── 수치 검사 ──
function numericCheck(rule, clause, figures) {
  const c = rule.check; if (!c) return null;
  const t = clause.text;
  if (c.kind === "term_months") {
    // "임대차기간은 … 1년으로 한다" 꼴만(통지 기간의 '6개월 전' 같은 것은 제외)
    const re = new RegExp(`(${c.labels.join("|")})[^.。\\n]{0,30}?(?<![\\d])(\\d{1,3})\\s*(년|개월|달)[^.。\\n]{0,8}?(으로|로)\\s*(한다|정한다|함|정함)`);
    const m = t.match(re);
    if (!m) return { hit: false };
    const months = m[3] === "년" ? +m[2] * 12 : +m[2];
    return months > 0 && months < c.lt ? { hit: true, detail: `${m[1]} ${m[2]}${m[3]} (< ${c.lt}개월)`, value: `${m[2]}${m[3]}` } : { hit: false };
  }
  if (c.kind === "increase_rate") {
    const m = [...t.matchAll(/(\d{1,2}(?:\.\d+)?)\s*(?:%|퍼센트|프로)/g)].map((x) => ({ v: parseFloat(x[1]), i: x.index }));
    const near = m.filter((x) => /증액|인상|상향|올/.test(t.slice(Math.max(0, x.i - 40), x.i + 20)));
    const hit = near.find((x) => x.v > c.gt);
    return hit ? { hit: true, detail: `증액 비율 ${hit.v}% (> ${c.gt}%)`, value: `${hit.v}%` } : { hit: false };
  }
  if (c.kind === "conversion_rate") {
    if (!/전환|월세로|월차임으로|환산/.test(t)) return { hit: false };
    const m = [...t.matchAll(/(?:연|年)?\s*(\d{1,2}(?:\.\d+)?)\s*(?:%|퍼센트|프로|할)/g)].map((x) => ({ v: /할/.test(x[0]) ? parseFloat(x[1]) * 10 : parseFloat(x[1]) }));
    const hit = m.find((x) => x.v > c.gt);
    if (hit) return { hit: true, detail: `전환율 연 ${hit.v}% (> ${c.gt}%)`, value: `${hit.v}%` };
    const warn = m.find((x) => x.v > c.warnAbove);
    return warn ? { hit: true, soft: true, detail: `전환율 연 ${warn.v}% — 기준금리 연동 상한(기준금리+2% 또는 ×4.5)과 대조 필요`, value: `${warn.v}%` } : { hit: false };
  }
  if (c.kind === "broker_fee_rate") {
    if (!/중개보수|중개 보수|중개수수료|중개 수수료|복비/.test(t)) return { hit: false };
    const m = [...t.matchAll(/(\d{1,2}(?:\.\d+)?)\s*(?:%|퍼센트|프로)/g)].map((x) => parseFloat(x[1]));
    const hit = m.find((v) => v > c.gt);
    return hit ? { hit: true, detail: `중개보수 요율 ${hit}% (> ${c.gt}%)`, value: `${hit}%` } : { hit: false };
  }
  if (c.kind === "penalty_ratio") {
    const pct = [...t.matchAll(/(\d{1,3})\s*(?:%|퍼센트|프로)/g)].map((x) => parseFloat(x[1])).find((v) => v > c.gtPercent);
    const mul = [...t.matchAll(/(\d{1,2})\s*배/g)].map((x) => parseFloat(x[1])).find((v) => v > 2);
    const months = [...t.matchAll(/(\d{1,2})\s*개월\s*분/g)].map((x) => parseFloat(x[1])).find((v) => v > c.gtMonths);
    if (pct) return { hit: true, detail: `위약금·배상 비율 ${pct}%`, value: `${pct}%` };
    if (mul) return { hit: true, detail: `위약금·배상 ${mul}배`, value: `${mul}배` };
    if (months) return { hit: true, detail: `위약금·배상 ${months}개월분`, value: `${months}개월분` };
    return { hit: false };
  }
  return null;
}

function signalMatch(sig, text) {
  if (!sig) return { hit: false, terms: [] };
  const terms = [];
  for (const group of sig.all || []) { const t = group.find((g) => text.includes(g)); if (!t) return { hit: false, terms }; terms.push(t); }
  for (const g of sig.none || []) if (text.includes(g)) return { hit: false, terms, excluded: g };
  return { hit: true, terms };
}

/** 문장 경계 발췌: 일치 용어 주변 1~2문장. */
function excerptAround(text, terms, max = 220) {
  const sents = text.split(/(?<=[.。!?])\s+|\n/).filter(Boolean);
  const idx = sents.findIndex((s) => terms.every((t) => s.includes(t))) >= 0 ? sents.findIndex((s) => terms.every((t) => s.includes(t))) : sents.findIndex((s) => terms.some((t) => s.includes(t)));
  const pick = idx >= 0 ? sents.slice(Math.max(0, idx), idx + 2) : sents.slice(0, 2);
  let out = pick.join(" ");
  if (out.length > max) { const cut = out.slice(0, max); const last = Math.max(cut.lastIndexOf("."), cut.lastIndexOf("다")); out = cut.slice(0, last > 60 ? last + 1 : max); }
  return out;
}

export function analyze(text, { docType: override, maxFindings = 20 } = {}) {
  const docType = detectDocType(text, override);
  const clauses = splitClauses(text);
  const figures = extractFigures(text);
  const findings = [];
  for (const rule of RULES.rules) {
    if (docType.value !== "other" && !rule.docTypes.includes(docType.value)) continue;
    for (const cl of clauses) {
      const sig = signalMatch(rule.signals, cl.text);
      const num = numericCheck(rule, cl, figures);
      let hit = false, terms = sig.terms, detail = null, soft = false;
      if (rule.check && rule.signals) { if (num?.hit && sig.hit) { hit = true; detail = num.detail; soft = !!num.soft; } else if (num?.hit && !rule.signals.all?.length) { hit = true; detail = num.detail; } }
      else if (rule.check) { if (num?.hit) { hit = true; detail = num.detail; soft = !!num.soft; terms = [num.value]; } }
      else if (sig.hit) hit = true;
      if (!hit) continue;
      const severity = soft ? (rule.severity === "high" ? "medium" : "low") : rule.severity;
      findings.push({
        id: `${rule.id}@${cl.no}`, rule: rule.id, category: rule.category, severity, clause: cl.no, clauseTitle: cl.title,
        excerpt: excerptAround(cl.text, terms.filter(Boolean)),
        why: (detail ? `${detail}. ` : "") + rule.elements,
        basis: rule.basis.map((b) => ({ law: b.law, label: b.label, effectiveDate: rule.basisEffectiveDate, link: lawLink(b.law, b.label) })),
        confidence: +(rule.check ? (soft ? 0.5 : 0.8) : Math.min(0.9, 0.5 + 0.15 * terms.length)).toFixed(2),
        matched: terms,
      });
      if (docType.value === "other") break; // 유형 미상이면 규칙당 1건만
    }
  }
  const order = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || b.confidence - a.confidence);
  const conflicts = findConflicts(figures, clauses, findings);
  const limited = findings.slice(0, maxFindings);
  const score = findings.reduce((s, f) => s + (f.severity === "high" ? 3 : f.severity === "medium" ? 2 : 1), 0);
  const grade = { value: score === 0 ? "A" : score <= 2 ? "B" : score <= 5 ? "C" : score <= 9 ? "D" : "E", score, rationale: `high ${findings.filter((f) => f.severity === "high").length}건×3 + medium ${findings.filter((f) => f.severity === "medium").length}건×2 + low ${findings.filter((f) => f.severity === "low").length}건×1 = ${score} (A 0 · B 1~2 · C 3~5 · D 6~9 · E 10+). 위법 판정이 아니라 검토 필요 신호의 합계입니다.` };
  return { docType: { value: docType.value, label: RULES.docTypes[docType.value]?.label || "기타", confidence: docType.confidence, signals: docType.signals.slice(0, 8), basis: docType.basis }, clauses: clauses.map((c) => ({ no: c.no, title: c.title, span: c.span })), findings: limited, findingsTotal: findings.length, figures, conflicts, grade };
}

function findConflicts(figures, clauses, findings) {
  const out = [];
  const byLabel = new Map();
  for (const a of figures.amounts) { if (a.label === "금액") continue; const arr = byLabel.get(a.label) || []; arr.push(a); byLabel.set(a.label, arr); }
  for (const [label, arr] of byLabel) { const vals = [...new Set(arr.map((a) => a.value))]; if (vals.length > 1) { const [x, y] = [arr[0], arr.find((a) => a.value !== arr[0].value)]; out.push({ kind: "amount_mismatch", label, a: locate(x, clauses), b: locate(y, clauses), why: `같은 라벨 '${label}'에 서로 다른 금액(${x.raw} / ${y.raw})` }); } }
  const term = figures.periods.find((p) => /임대차기간|계약기간|존속기간/.test(p.label));
  const notice = figures.periods.find((p) => /통지|통고|해지/.test(p.label));
  if (term && notice && toMonths(notice) >= toMonths(term)) out.push({ kind: "notice_exceeds_term", a: locate(term, clauses), b: locate(notice, clauses), why: `해지 통지기간(${notice.raw})이 계약기간(${term.raw}) 이상` });
  return out;
}
function locate(fig, clauses) { const c = clauses.find((cl) => fig.span[0] >= cl.span[0] && fig.span[1] <= cl.span[1]); return { clause: c?.no || "?", excerpt: fig.raw }; }
