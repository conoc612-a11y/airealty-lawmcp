// 판(버전) 목록과 기준일 판 선택 (SPEC §3.5). 한 MST 가 시행일이 다른 여러 판(분할 시행)으로 나올 수 있어 키는 (mst, efYd).
import { getDocumentStore, search, service, lawRow, digits, str, asList } from "./upstream.js";
import { cache, TTL } from "./cache.js";
import { fmtDate, todayKst, msUntilKstMidnight } from "./kst.js";
import { requestKey } from "./drf.js";
import { LawError, invalid } from "./errors.js";
import { resolveLawName } from "./resolver.js";
import { cacheState } from "./envelope.js";
import { normalizeName } from "./dictionary.js";
import { cacheDir, readDisk, writeDisk } from "./diskcache.js";

// 이름 검색의 선행 조회와 후속 보강이 같은 목록을 기다리도록 한다.
const pendingVersionLists = new Map();
const versionListKey = lawId => "version-list:v1:" + lawId;
const RECENT_PAGE_SIZE = 12;
const pageParams = (lawId, page, display = 100) => ({ LID: lawId, nw: "1,2,3", display, page, sort: "efdes" });
export function versionDocumentKeys(lawId, display = 100) {
  const firstPage = "drf:" + requestKey("lawSearch.do", { target: "eflaw", ...pageParams(lawId, 1, display) });
  return [versionListKey(lawId), firstPage];
}

/** 시행일 내림차순 판 목록. selectionDate를 지정하면 해당 날짜의 적용 판과 예정 판을 선택하는 데 충분한 범위만 돌려줄 수 있다. */
export async function listVersions(lawId, selectionDate) {
  const now = Date.now();
  const key = `versions:${lawId}`;
  const directory = cacheDir();
  const warm = cache.get(key, now);
  if (warm?.directory === directory) return { ...warm.value, hit: true, expiresAt: cache.expiresAt(key) };
  if (selectionDate) {
    const recentKey = key + ":" + selectionDate;
    const recent = cache.get(recentKey, now);
    if (recent?.directory === directory) return { ...recent.value, hit: true, expiresAt: cache.expiresAt(recentKey) };
  }
  const dk = readDisk("versions", lawId, now);
  const ttl = Math.min(TTL.resolve, msUntilKstMidnight(now));
  if (dk && dk.ageMs < TTL.resolve && todayKst(dk.savedAt) === todayKst(now) && Array.isArray(dk.value?.versions) && dk.value.versions.length) {
    cache.set(key, { directory, value: dk.value }, Math.min(ttl, TTL.resolve - dk.ageMs), now);
    return { ...dk.value, hit: true, expiresAt: cache.expiresAt(key) };
  }
  const store = getDocumentStore();
  const pendingKey = JSON.stringify([directory, lawId, selectionDate]);
  if (!pendingVersionLists.has(pendingKey)) {
    const load = store ? readVersionList(store, lawId, key, directory, now, ttl, selectionDate)
      : fetchVersions(lawId, key, directory, now, ttl, selectionDate);
    pendingVersionLists.set(pendingKey, load.finally(() => pendingVersionLists.delete(pendingKey)));
  }
  return pendingVersionLists.get(pendingKey);
}
async function readVersionList(store, lawId, key, directory, started, ttl, selectionDate) {
  const [sharedKey, firstPageKey] = versionDocumentKeys(lawId, selectionDate ? RECENT_PAGE_SIZE : 100);
  const row = await store.get(sharedKey, firstPageKey);
  const expiresAt = Math.min(row?.expiresAt ?? 0, started + ttl);
  const now = Date.now();
  if (expiresAt > now && Array.isArray(row.data?.versions) && row.data.versions.length) {
    cache.set(key, { directory, value: row.data }, expiresAt - now, now);
    return { ...row.data, hit: true, stale: false, expiresAt };
  }
  const result = await fetchVersions(lawId, key, directory, started, ttl, selectionDate, true);
  if (!selectionDate && !result.stale && result.versions.length && result.expiresAt > Date.now()) {
    const { versions, name, kind } = result;
    await store.put(sharedKey, { versions, name, kind }, started, result.expiresAt);
  }
  return result;
}

// 내림차순 첫 쪽에 적용일보다 오래된 판이 있어야 같은 날의 다른 판까지 포함했다고 보장할 수 있다.
function coversDate(page, date) {
  const total = String(page.raw?.LawSearch?.totalCnt ?? "");
  const dates = page.rows.map(row => digits(row["시행일자"]));
  if (!/^\d+$/.test(total) || !dates.length || Number(total) < dates.length ||
      dates.some((d, i) => !/^\d{8}$/.test(d) || (i > 0 && d > dates[i - 1]))) return false;
  if (Number(total) === dates.length) return true;
  const applicable = dates.find(d => d <= date);
  return dates.length === RECENT_PAGE_SIZE && !!applicable && dates.at(-1) < applicable;
}

async function fetchVersions(lawId, key, directory, started, ttl, selectionDate, readOnlyStore = false) {
  const rows = []; let hit = true; let stale = false; let name = "", kind = "";
  const size = selectionDate ? RECENT_PAGE_SIZE : 100;
  const fetchPage = page => search("eflaw", pageParams(lawId, page, size), {
    rowKeys: ["law"], ttl, validUntil: started + ttl, readOnlyStore: readOnlyStore && !selectionDate,
  });
  const first = selectionDate ? await fetchPage(1).catch(() => null) : await fetchPage(1);
  if (selectionDate && (!first || !coversDate(first, selectionDate))) return listVersions(lawId);
  const pages = [first];
  const need = selectionDate ? 1 : Math.min(5, Math.ceil((first.total || 0) / 100));
  if (need > 1) pages.push(...(await Promise.all(Array.from({ length: need - 1 }, (_, i) => fetchPage(i + 2))))); // 나머지 페이지는 병렬
  for (const r of pages) {
    hit = hit && r.hit;
    if (r.stale) stale = true;
    for (const x of r.rows) {
      const l = lawRow(x);
      if (!name) { name = l.name; kind = l.kind; }
      rows.push({ mst: l.mst, efYd: digits(x["시행일자"]), effectiveDate: l.effectiveDate, promulgationDate: l.promulgationDate, promulgationNo: l.promulgationNo, revision: l.revision, statusCode: l.statusCode, name: l.name, kind: l.kind });
    }
  }
  const seen = new Set(); const out = [];
  for (const v of rows) { const k = v.mst + ":" + v.efYd; if (!seen.has(k) && /^\d{8}$/.test(v.efYd)) { seen.add(k); out.push(v); } }
  out.sort((a, b) => b.efYd.localeCompare(a.efYd) || b.mst.localeCompare(a.mst));
  const expiresAt = Math.min(started + ttl, ...pages.map(page => page.expiresAt));
  if (out.length && !stale && expiresAt > Date.now() && cacheDir() === directory) {
    const value = { versions: out, name, kind };
    if (!selectionDate && pages.every(page => !page.hit)) writeDisk("versions", lawId, value, started);
    // 가공한 목록도 가장 먼저 만료되는 원본 페이지까지만 재사용한다.
    cache.set(selectionDate ? key + ":" + selectionDate : key, { directory, value }, expiresAt - started, started);
  }
  return { versions: out, name, kind, hit, stale, expiresAt };
}

/** 기준일 D 에 대한 적용 판과 시행예정 판. 기준일 이전 판이 없으면 LAW_NOT_FOUND(대체 금지). */
export function selectVersion(versions, asOfYmd) {
  const D = asOfYmd || todayKst();
  const applicable = versions.filter((v) => v.efYd <= D);
  const upcoming = versions.filter((v) => v.efYd > D).sort((a, b) => a.efYd.localeCompare(b.efYd));
  if (!applicable.length) {
    const first = versions.length ? versions[versions.length - 1] : null;
    throw new LawError("LAW_NOT_FOUND", `기준일 ${fmtDate(D)} 에 시행 중인 판 없음` + (first ? `, 최초 시행일 ${first.effectiveDate}` : ""), { retryable: false, data: first ? { firstEffectiveDate: first.effectiveDate } : undefined });
  }
  const latest = applicable[0].efYd;
  const same = applicable.filter((v) => v.efYd === latest);
  const chosen = same.find((v) => v.statusCode === "현행") || same.sort((a, b) => (b.promulgationDate || "").localeCompare(a.promulgationDate || "") || b.mst.localeCompare(a.mst))[0];
  return { chosen, upcoming, isToday: D === todayKst() };
}

export const statusOf = (v, D) => (v.efYd > D ? "upcoming" : v.statusCode === "현행" ? "current" : "historical");

/**
 * 법령 지정(spec: {name|lawId|mst}) + 기준일 → {law:{...}, chosen, upcoming, versions, cache}.
 * mst 만 주면 lawId 를 알기 위해 본문 기본정보를 1회 받는다(캐시됨).
 */
export async function resolveLaw(spec, asOfYmd) {
  const D = asOfYmd || todayKst();
  let expiresAt = Infinity;
  let lawId = spec.lawId, resolved = null; const cacheStates = [];
  if (!lawId && spec.name) { resolved = await resolveLawName(spec.name); lawId = resolved.lawId; cacheStates.push(resolved.cache); }
  if (!lawId && spec.mst) {
    // eflaw 는 MST 에 efYd 가 필수라 법령ID 를 모를 땐 law target(MST 단독 허용)으로 기본정보만 받는다(JO 지정으로 작게)
    const { data, hit, stale, expiresAt: mappingExpiry } = await service("law", { MST: spec.mst, JO: "000100" }, { long: true });
    cacheStates.push(stale ? "stale" : hit ? "hit" : "miss");
    expiresAt = mappingExpiry;
    lawId = str(data?.["법령"]?.["기본정보"]?.["법령ID"]);
    if (!lawId) throw new LawError("LAW_NOT_FOUND", `MST ${spec.mst} 에 해당하는 법령 없음`, { retryable: false });
  }
  const vl = await listVersions(lawId);
  cacheStates.push(cacheState(vl));
  if (!vl.versions.length) throw new LawError("LAW_NOT_FOUND", `법령ID ${lawId} 의 판 목록 없음`, { retryable: false });
  // 모순 검사: name 과 lawId/mst 가 같이 왔는데 다른 법령이면 INVALID_INPUT
  if (spec.name && (spec.lawId || spec.mst) && normalizeName(vl.name) !== normalizeName(spec.name) && !(resolved && resolved.lawId === lawId)) {
    const r = await resolveLawName(spec.name).catch(() => null);
    if (r && r.lawId !== lawId) throw invalid(`name(${spec.name})과 lawId/mst 가 서로 다른 법령을 가리킴`);
  }
  let chosen, upcoming, warnings = [];
  if (spec.mst) {
    const rows = vl.versions.filter((v) => v.mst === spec.mst);
    if (!rows.length) throw new LawError("LAW_NOT_FOUND", `MST ${spec.mst} 는 이 법령의 판 목록에 없음`, { retryable: false });
    const sel = selectVersion(vl.versions, D);
    upcoming = sel.upcoming;
    const applicableRow = rows.filter((v) => v.efYd <= D)[0];
    chosen = applicableRow || rows[rows.length - 1];
    if (!applicableRow) warnings.push(`MST ${spec.mst} 판은 아직 시행 전(시행일 ${chosen.effectiveDate}) — 기준일 ${fmtDate(D)} 의 현행 판은 MST ${sel.chosen.mst}(시행 ${sel.chosen.effectiveDate})`);
    else if (chosen.mst !== sel.chosen.mst || chosen.efYd !== sel.chosen.efYd) warnings.push(`MST ${spec.mst} 판(시행 ${chosen.effectiveDate})은 기준일 ${fmtDate(D)} 의 적용 판이 아님 — 적용 판은 MST ${sel.chosen.mst}(시행 ${sel.chosen.effectiveDate})`);
  } else {
    const sel = selectVersion(vl.versions, D);
    chosen = sel.chosen; upcoming = sel.upcoming;
  }
  const law = { name: vl.name, kind: vl.kind, lawId, mst: chosen.mst, effectiveDate: chosen.effectiveDate, promulgationDate: chosen.promulgationDate, promulgationNo: chosen.promulgationNo, status: statusOf(chosen, D), upcoming: upcoming.map((u) => ({ mst: u.mst, effectiveDate: u.effectiveDate, promulgationDate: u.promulgationDate, revision: u.revision })) };
  if (resolved?.expandedFrom) warnings.push(`약칭 '${resolved.expandedFrom}' → '${vl.name}' 으로 해석`);
  return { law, chosen, upcoming, versions: vl.versions, cacheStates, warnings, asOf: D, expiresAt: Math.min(vl.expiresAt, expiresAt) };
}

export { asList };
