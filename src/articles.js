// 조문 본문 받기·구조화 (SPEC §4.2). 업스트림이 준 항·호·목 구조를 그대로 트리로, 원문 기호(①, 1., 가.) 보존.
import { service, asList, str, digits } from "./upstream.js";
import { TTL } from "./cache.js";
import { fmtDate } from "./kst.js";
import { articleLabel, toJoCode, circledToNumber } from "./jo.js";
import { lawLink } from "./links.js";
import { LawError } from "./errors.js";

const NOTE_RE = /\s*<(?:개정|신설|전문개정|본조신설|제목개정|종전|타법개정|삭제)[^<>]*>|\s*\[(?:본조신설|전문개정|종전|제목개정)[^\]]*\]/g;

export function extractNotes(text) {
  const notes = [];
  const cleaned = String(text || "").replace(NOTE_RE, (m) => { notes.push(m.trim()); return ""; });
  return { cleaned: cleaned.replace(/[ \t]+/g, " ").trim(), notes };
}

/** 조문단위 하나 → 조문 아이템. keepNotes=false 면 본문에서 <개정 …> 를 떼고 amendmentNotes 로. */
export function buildArticle(unit, { lawName, keepNotes = false, asOfYmd } = {}) {
  const article = parseInt(digits(unit["조문번호"]), 10);
  const branch = parseInt(digits(unit["조문가지번호"]) || "0", 10) || 0;
  const label = articleLabel(article, branch);
  const title = str(unit["조문제목"]);
  const headRaw = str(unit["조문내용"]);
  const effYmd = digits(unit["조문시행일자"]);
  const notes = [];
  const take = (t) => { if (keepNotes) return String(t || "").replace(/[ \t]+/g, " ").trim(); const r = extractNotes(t); notes.push(...r.notes); return r.cleaned; };
  const head = take(headRaw);
  const paragraphs = [];
  const lines = [head];
  const buildItems = (hos) => asList(hos).map((ho) => {
    const text = take(ho["호내용"]); lines.push(text);
    const subitems = asList(ho["목"]).map((mok) => { const t = take(mok["목내용"]); lines.push(t); return { no: str(mok["목번호"]) || t.slice(0, 2), text: t }; });
    return { no: str(ho["호번호"]) || text.split(/\s/)[0], text, ...(subitems.length ? { subitems } : {}) };
  });
  for (const h of asList(unit["항"])) {
    const text = take(h["항내용"]); lines.push(text);
    let no = str(h["항번호"]);
    // 업스트림은 21항 이상을 "<21>" 로 적는다 — 본문 첫 글자가 원문자(㉑…)면 그 기호를 쓴다
    if ((!no || /^<\d+>$/.test(no)) && text && circledToNumber(text[0])) no = text[0];
    const items = buildItems(h["호"]);
    paragraphs.push({ no, text, ...(items.length ? { items } : {}) });
  }
  const looseItems = buildItems(unit["호"]);
  const deleted = /^제\d+조(?:의\d+)?\s*삭제/.test(head);
  const status = deleted ? "deleted" : asOfYmd && effYmd && effYmd > asOfYmd ? "upcoming" : "current";
  return {
    label, article, branch, title, status, effectiveDate: fmtDate(effYmd),
    text: lines.filter(Boolean).join("\n"),
    paragraphs, ...(looseItems.length ? { items: looseItems } : {}),
    amendmentNotes: notes, link: lawLink(lawName, label),
  };
}

/** 본문 응답 → 조문 단위 배열(장·절 머리 제외). */
export function articleUnits(body) {
  return asList(body?.["법령"]?.["조문"]?.["조문단위"]).filter((u) => str(u["조문여부"]) === "조문");
}
/** 목차용: 편장절관 머리 + 조문 {label,title}. */
export function tocUnits(body) {
  return asList(body?.["법령"]?.["조문"]?.["조문단위"]).map((u) => {
    const isHead = str(u["조문여부"]) !== "조문";
    const article = parseInt(digits(u["조문번호"]), 10); const branch = parseInt(digits(u["조문가지번호"]) || "0", 10) || 0;
    if (isHead) return { heading: str(u["조문내용"]).replace(/\s+/g, " ") };
    const head = str(u["조문내용"]);
    return { label: articleLabel(article, branch), article, branch, title: str(u["조문제목"]), ...(/^제\d+조(?:의\d+)?\s*삭제/.test(head) ? { status: "deleted" } : {}) };
  });
}

export function lawMetaFromBody(body) {
  const b = body?.["법령"]?.["기본정보"] || {};
  return { name: str(b["법령명_한글"]), kind: str(b["법종구분"]), lawId: str(b["법령ID"]), effectiveDate: fmtDate(b["시행일자"]), promulgationDate: fmtDate(b["공포일자"]), promulgationNo: str(b["공포번호"]), articleEffectiveNote: str(b["조문시행일자문자열"]) };
}

/**
 * 조문 하나 받기. 현행 판(기준일=오늘이고 선택 판이 현행)이면 ID+JO 1왕복, 아니면 MST+efYd+JO.
 * 반환 {units, meta, hit}. 없는 조문이면 units=[].
 */
export async function fetchArticle({ lawId, mst, efYd, useId }, ref) {
  const JO = toJoCode(ref);
  if (!JO) throw new LawError("INVALID_INPUT", "조문 번호 범위 밖", { retryable: false });
  const params = useId ? { ID: lawId, JO } : { MST: mst, efYd, JO };
  const { data, hit } = await service("eflaw", params, { ttl: TTL.body });
  const units = articleUnits(data).filter((u) => parseInt(digits(u["조문번호"]), 10) === ref.article && (parseInt(digits(u["조문가지번호"]) || "0", 10) || 0) === (ref.branch || 0));
  return { units, meta: lawMetaFromBody(data), hit, raw: data };
}

/** 법령 전체 본문(목차·전체 조문·별표·부칙). 큰 응답이라 20초 타임아웃. */
export async function fetchFullBody({ lawId, mst, efYd, useId }) {
  const params = useId ? { ID: lawId } : { MST: mst, efYd };
  const { data, hit } = await service("eflaw", params, { ttl: TTL.body, long: true });
  return { body: data, hit };
}

/** 유효 조문 범위와 가까운 조문(없는 조문 안내용). */
export function validRange(units) {
  const nums = units.map((u) => ({ a: parseInt(digits(u["조문번호"]), 10), b: parseInt(digits(u["조문가지번호"]) || "0", 10) || 0 }));
  if (!nums.length) return { validRange: null, nearest: [] };
  const max = Math.max(...nums.map((n) => n.a));
  return { validRange: `제1조~제${max}조`, all: nums };
}
export function nearestLabels(all, ref, k = 3) {
  return all.map((n) => ({ n, d: Math.abs(n.a - ref.article) + (n.b ? 0.5 : 0) })).sort((x, y) => x.d - y.d).slice(0, k).map(({ n }) => articleLabel(n.a, n.b));
}

/** 긴 조문을 항 경계로 나눈다(크기 예산 초과 시). 각 부분은 같은 label 에 partNo 를 단다. */
export function splitArticleByParagraph(item, budgetBytes) {
  const parts = []; let cur = null;
  const base = { ...item, paragraphs: [], text: "" };
  const push = () => { if (cur) parts.push(cur); cur = null; };
  for (const p of item.paragraphs.length ? item.paragraphs : [{ no: "", text: item.text }]) {
    const b = Buffer.byteLength(JSON.stringify(p), "utf8");
    if (cur && cur._bytes + b > budgetBytes) push();
    if (!cur) cur = { ...base, paragraphs: [], text: "", _bytes: Buffer.byteLength(JSON.stringify(base), "utf8") };
    cur.paragraphs.push(p); cur.text += (cur.text ? "\n" : "") + p.text; cur._bytes += b;
  }
  push();
  if (parts.length <= 1) return [item];
  const head = item.text.split("\n")[0];
  return parts.map((p, i) => { delete p._bytes; if (i === 0 && head && !p.text.startsWith(head)) p.text = head + "\n" + p.text; return { ...p, part: i + 1, parts: parts.length, note: `${item.label}가 길어 ${parts.length}개 부분으로 나눔` }; });
}
