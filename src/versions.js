// 판(버전) 목록과 기준일 판 선택 (SPEC §3.5). 한 MST 가 시행일이 다른 여러 판(분할 시행)으로 나올 수 있어 키는 (mst, efYd).
import { search, service, lawRow, digits, str, asList } from "./upstream.js";
import { TTL } from "./cache.js";
import { fmtDate, todayKst } from "./kst.js";
import { LawError, invalid } from "./errors.js";
import { resolveLawName } from "./resolver.js";
import { normalizeName } from "./dictionary.js";
import { readDisk, writeDisk } from "./diskcache.js";

/** 법령ID → 판 목록(시행일 내림차순). 각 {mst, efYd, effectiveDate, promulgationDate, promulgationNo, revision, statusCode}. */
export async function listVersions(lawId) {
  // 디스크(키 없음): 같은 KST 날짜 안에서 6시간 — 새 프로세스의 첫 호출도 판 목록 왕복을 건너뛴다
  const dk = readDisk("versions", lawId);
  if (dk && dk.ageMs < TTL.resolve && todayKst(dk.savedAt) === todayKst() && Array.isArray(dk.value?.versions) && dk.value.versions.length) return { ...dk.value, hit: true };
  const out0 = await fetchVersions(lawId);
  if (out0.versions.length) writeDisk("versions", lawId, { versions: out0.versions, name: out0.name, kind: out0.kind });
  return out0;
}
async function fetchVersions(lawId) {
  const rows = []; let hit = true; let name = "", kind = "";
  const fetchPage = (page) => search("eflaw", { LID: lawId, nw: "1,2,3", display: 100, page, sort: "efdes" }, { rowKeys: ["law"], ttl: TTL.resolve });
  const first = await fetchPage(1);
  const pages = [first];
  const need = Math.min(5, Math.ceil((first.total || 0) / 100));
  if (need > 1) pages.push(...(await Promise.all(Array.from({ length: need - 1 }, (_, i) => fetchPage(i + 2))))); // 나머지 페이지는 병렬
  for (const r of pages) {
    hit = hit && r.hit;
    for (const x of r.rows) {
      const l = lawRow(x);
      if (!name) { name = l.name; kind = l.kind; }
      rows.push({ mst: l.mst, efYd: digits(x["시행일자"]), effectiveDate: l.effectiveDate, promulgationDate: l.promulgationDate, promulgationNo: l.promulgationNo, revision: l.revision, statusCode: l.statusCode, name: l.name, kind: l.kind });
    }
  }
  const seen = new Set(); const out = [];
  for (const v of rows) { const k = v.mst + ":" + v.efYd; if (!seen.has(k) && /^\d{8}$/.test(v.efYd)) { seen.add(k); out.push(v); } }
  out.sort((a, b) => b.efYd.localeCompare(a.efYd) || b.mst.localeCompare(a.mst));
  return { versions: out, name, kind, hit };
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
  let lawId = spec.lawId, resolved = null; const cacheStates = [];
  if (!lawId && spec.name) { resolved = await resolveLawName(spec.name); lawId = resolved.lawId; cacheStates.push(resolved.cache); }
  if (!lawId && spec.mst) {
    // eflaw 는 MST 에 efYd 가 필수라 법령ID 를 모를 땐 law target(MST 단독 허용)으로 기본정보만 받는다(JO 지정으로 작게)
    const { data, hit } = await service("law", { MST: spec.mst, JO: "000100" }, { long: true });
    cacheStates.push(hit ? "hit" : "miss");
    lawId = str(data?.["법령"]?.["기본정보"]?.["법령ID"]);
    if (!lawId) throw new LawError("LAW_NOT_FOUND", `MST ${spec.mst} 에 해당하는 법령 없음`, { retryable: false });
  }
  const vl = await listVersions(lawId);
  cacheStates.push(vl.hit ? "hit" : "miss");
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
  return { law, chosen, upcoming, versions: vl.versions, cacheStates, warnings, asOf: D };
}

export { asList };
