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
// Workers: 디스크 대신 원격 저장소(KV). 요청 경로는 읽기만 하고, 업스트림 전체 갱신은 cron(refreshDictionaryStep)만 한다.
let remote = null; let remoteNextAt = 0; let remoteLoading = null;
/** @param {{get():Promise<object|null>, put(d:object):Promise<void>}} s */
export function useRemoteStore(s) { remote = s; }

/** 이름 정규화: 공백·가운뎃점 변형·괄호 안 한자/공백 정리. 비교 전용(출력엔 원문 사용). */
// 사전 5,600건을 요청마다 다시 정규화하지 않게 기억해 둔다(CPU — Workers 무료 10ms). 상한을 넘으면 비운다.
const NORM = new Map();
export function normalizeName(s) {
  const key = String(s || "");
  let v = NORM.get(key);
  if (v === undefined) { if (NORM.size > 20_000) NORM.clear(); v = normalizeRaw(key); NORM.set(key, v); }
  return v;
}
function normalizeRaw(s) {
  return s
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

const DICT_PAGE = (page) => search("eflaw", { nw: 3, display: 100, page, sort: "lasc" }, { ttl: 60_000, rowKeys: ["law"] });
function toEntries(rows) { const out = []; for (const row of rows) { const l = lawRow(row); if (l.name && l.lawId) out.push({ n: l.name, k: l.kind, i: l.lawId, m: l.mst, e: l.effectiveDate, d: l.department || undefined, a: l.abbreviation || undefined }); } return out; }
async function fetchAbbreviations() {
  try {
    const a = await search("lsAbrv", {}, { ttl: 60_000, rowKeys: ["law"], long: true });
    return a.rows.map((r) => ({ abbr: str(r["법령약칭명"]), name: str(r["법령명한글"]), lawId: str(r["법령ID"]), current: str(r["현행연혁코드"]) === "현행" })).filter((x) => x.abbr && x.name);
  } catch { return []; }
}
/** 받은 목록 → 사전. 95% 미만이면 던진다(덜 받은 사전은 저장하지 않는다). */
function finish(entries, total, abbreviations) {
  if (total != null && entries.length < total * 0.95) throw new Error(`dictionary incomplete ${entries.length}/${total}`);
  const seen = new Set(); const uniq = [];
  for (const e of entries) { const key = e.i + ":" + e.n; if (!seen.has(key)) { seen.add(key); uniq.push(e); } }
  return { entries: uniq, abbreviations, loadedAt: Date.now(), source: "upstream" };
}

/** 업스트림에서 전체 현행 법령 목록(100건씩)을 받는다. 저동시성(순차). */
async function fetchAll() {
  const entries = []; let total = null;
  for (let page = 1; page <= 200; page++) {
    const r = await DICT_PAGE(page);
    total = r.total; entries.push(...toEntries(r.rows));
    if (!r.rows.length || entries.length >= total) break;
  }
  return finish(entries, total, await fetchAbbreviations());
}

/** 사전 보장: 디스크가 신선하면 그대로, 아니면 업스트림(실패 시 옛 사전 유지). 처음 호출 전엔 네트워크 없음. */
export async function ensureDictionary({ allowNetwork = true } = {}) {
  if (!state.entries.length) { const d = readDisk(); if (d) state = d; }
  const fresh = state.entries.length && Date.now() - state.loadedAt < MAX_AGE;
  if (remote) {
    // 비었거나 오래됐을 때만 읽는다 — 동시 요청은 같은 읽기를 기다리고, 성공하면 10분·실패(빈 값)면 30초 뒤 다시
    if (!fresh && Date.now() >= remoteNextAt) {
      remoteLoading ||= remote.get().then(
        (d) => { const ok = !!d?.entries?.length; if (ok) state = { ...d, source: "remote" }; remoteNextAt = Date.now() + (ok ? 600_000 : 30_000); },
        () => { remoteNextAt = Date.now() + 30_000; },
      ).finally(() => { remoteLoading = null; });
      await remoteLoading;
    }
    return state;
  }
  if (fresh || !allowNetwork) return state;
  if (!loading) {
    loading = fetchAll().then((d) => { state = d; writeDisk(d); return d; }).catch(() => state).finally(() => { loading = null; });
  }
  // 기다리지 않는다 — 사전이 없으면 호출자는 업스트림 검색으로 대신하고, 사전은 뒤에서 채워진다
  return state;
}

/**
 * cron 한 회차(Workers 무료: 외부 하위 요청 50/호출). 목록을 pages 쪽씩 받아 진행분을 progress 저장소에 두고,
 * 다 받으면 약칭까지 받아 완성본을 remote 에 쓴다. 완성본이 maxAgeMs 안이면 아무것도 안 한다.
 * @param {{get():Promise<object|null>, put(p:object|null):Promise<void>}} progress
 */
export async function refreshDictionaryStep(progress, { pages = 20, maxAgeMs = 20 * 3600_000, staleBuildMs = 6 * 3600_000, now = Date.now() } = {}) {
  let p = await progress.get();
  if (p && now - p.startedAt > staleBuildMs) p = null; // 오래 멈춘 빌드는 처음부터
  if (!p) {
    const cur = await remote?.get().catch(() => null);
    if (cur?.entries?.length && now - (cur.loadedAt || 0) < maxAgeMs) return { skipped: true, entries: cur.entries.length };
    p = { next: 1, total: null, entries: [], startedAt: now };
  }
  let done = false;
  try {
    for (let i = 0; i < pages && !done; i++) {
      const r = await DICT_PAGE(p.next);
      p.total = r.total; p.entries.push(...toEntries(r.rows)); p.next++;
      done = !r.rows.length || p.entries.length >= p.total || p.next > 200;
    }
  } finally {
    if (!done) await progress.put(p); // 실패해도 받은 데까지 남겨 다음 회차가 잇는다
  }
  if (!done) return { done: false, next: p.next, entries: p.entries.length };
  let d;
  try { d = finish(p.entries, p.total, await fetchAbbreviations()); } catch (e) { await progress.put(null); throw e; }
  state = d; if (remote) await remote.put(d);
  await progress.put(null);
  return { done: true, entries: d.entries.length, abbreviations: d.abbreviations.length };
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
