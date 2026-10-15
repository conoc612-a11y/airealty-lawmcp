// 법령명 사전 — 현행 법령 전체 이름·ID·MST·법종(약 5,600건)과 약칭. 하루 1회 디스크 캐시(키 없음), 지연 로드,
// 갱신은 백그라운드이며 실패해도 기존 사전을 유지한다(SPEC §6.1, §5.3).
import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { search, lawRow, str } from "./upstream.js";
import { TTL } from "./cache.js";
import { apiKey } from "./keys.js";

const DIR = process.env.LAWMCP_CACHE_DIR || join(homedir(), ".cache", "airealty-lawmcp");
const FILE = join(DIR, "law_dictionary.json");
const MAX_AGE = TTL.dictionary;

let state = { entries: [], abbreviations: [], loadedAt: 0, source: "none" };
let loading = null;

/** 이름 정규화: 공백·가운뎃점 변형·괄호 안 한자/공백 정리. 비교 전용(출력엔 원문 사용). */
export function normalizeName(s) {
  return String(s || "")
    .replace(/[「」『』]/g, "")
    .replace(/[·ㆍ‧•․]/g, "·")
    .replace(/\s+/g, "")
    .replace(/\([^)]*\)/g, (m) => (/[一-鿿]/.test(m) ? "" : m))
    .trim();
}

function readDisk() {
  try {
    const d = JSON.parse(readFileSync(FILE, "utf8"));
    if (Array.isArray(d.entries) && d.entries.length) return { entries: d.entries, abbreviations: d.abbreviations || [], loadedAt: d.loadedAt || statSync(FILE).mtimeMs, source: "disk" };
  } catch {}
  return null;
}

function writeDisk(d) {
  const text = JSON.stringify(d);
  const k = apiKey();
  if (k && k.length >= 4 && text.includes(k)) throw new Error("dictionary contains credential — refuse to write");
  try { mkdirSync(DIR, { recursive: true }); writeFileSync(FILE, text); } catch {}
}

/** 업스트림에서 전체 현행 법령 목록(100건씩)을 받는다. 저동시성(순차). */
async function fetchAll() {
  const entries = []; let total = null;
  for (let page = 1; page <= 200; page++) {
    const r = await search("eflaw", { nw: 3, display: 100, page, sort: "lasc" }, { ttl: 60_000, rowKeys: ["law"] });
    total = r.total;
    for (const row of r.rows) { const l = lawRow(row); if (l.name && l.lawId) entries.push({ n: l.name, k: l.kind, i: l.lawId, m: l.mst, e: l.effectiveDate, d: l.department || undefined, a: l.abbreviation || undefined }); }
    if (!r.rows.length || entries.length >= total) break;
  }
  if (total != null && entries.length < total * 0.95) throw new Error(`dictionary incomplete ${entries.length}/${total}`);
  const seen = new Set(); const uniq = [];
  for (const e of entries) { const key = e.i + ":" + e.n; if (!seen.has(key)) { seen.add(key); uniq.push(e); } }
  let abbreviations = [];
  try {
    const a = await search("lsAbrv", {}, { ttl: 60_000, rowKeys: ["law"], long: true });
    abbreviations = a.rows.map((r) => ({ abbr: str(r["법령약칭명"]), name: str(r["법령명한글"]), lawId: str(r["법령ID"]), current: str(r["현행연혁코드"]) === "현행" })).filter((x) => x.abbr && x.name);
  } catch {}
  return { entries: uniq, abbreviations, loadedAt: Date.now(), source: "upstream" };
}

/** 사전 보장: 디스크가 신선하면 그대로, 아니면 업스트림(실패 시 옛 사전 유지). 처음 호출 전엔 네트워크 없음. */
export async function ensureDictionary({ allowNetwork = true } = {}) {
  if (!state.entries.length) { const d = readDisk(); if (d) state = d; }
  const fresh = state.entries.length && Date.now() - state.loadedAt < MAX_AGE;
  if (fresh || !allowNetwork) return state;
  if (!loading) {
    loading = fetchAll().then((d) => { state = d; writeDisk(d); return d; }).catch(() => state).finally(() => { loading = null; });
  }
  // 기다리지 않는다 — 사전이 없으면 호출자는 업스트림 검색으로 대신하고, 사전은 뒤에서 채워진다
  return state;
}

export function dictionary() { return state; }
/** 동기 디스크 로드(네트워크 없음) — 인용 추출기처럼 동기 경로에서 사전이 필요할 때. */
export function loadDictionarySync() { if (!state.entries.length) { const d = readDisk(); if (d) state = d; } return state; }
export function _setDictionary(d) { state = { entries: d.entries || [], abbreviations: d.abbreviations || [], loadedAt: d.loadedAt ?? Date.now(), source: "test" }; }

/** 약칭 → 정식명(현행 우선). 없으면 null. */
export function expandAbbreviation(name) {
  const n = normalizeName(name);
  const hits = state.abbreviations.filter((a) => normalizeName(a.abbr) === n);
  const pick = hits.find((h) => h.current) || hits[0];
  return pick ? pick.name : null;
}

/** 사전의 전체 이름 집합(현행 + 약칭) — 인용 추출기가 쓴다. */
export function allNames() {
  const names = new Map();
  for (const e of state.entries) names.set(e.n, { name: e.n, lawId: e.i, kind: e.k });
  for (const a of state.abbreviations) if (!names.has(a.abbr)) names.set(a.abbr, { name: a.name, lawId: a.lawId, kind: "", abbr: true });
  return names;
}
