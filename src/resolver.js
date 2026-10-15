// 법령명 해석 — 모든 도구가 공유하는 단일 함수 (SPEC §3.4). 정확 일치가 있으면 무조건 그것.
import { ensureDictionary, dictionary, normalizeName, expandAbbreviation } from "./dictionary.js";
import { search, lawRow } from "./upstream.js";
import { cache, TTL } from "./cache.js";
import { msUntilKstMidnight, todayKst } from "./kst.js";
import { LawError, invalid } from "./errors.js";

const KIND_RANK = (k) => (/^법률$/.test(k) ? 0 : /^헌법$/.test(k) ? 0 : /대통령령/.test(k) ? 1 : /총리령|부령|령$/.test(k) ? 2 : /규칙/.test(k) ? 3 : 4);
const SUFFIX = /(시행령|시행규칙)$/;

export function rankTier(inputNorm, candNorm) {
  if (candNorm === inputNorm) return 0;
  if (candNorm.startsWith(inputNorm)) return 2;
  if (candNorm.includes(inputNorm)) return 3;
  return 9;
}

/** 후보 정렬 키: 등급 → 법종 → 이름 길이. */
export function sortCandidates(inputNorm, cands) {
  const sfx = inputNorm.match(SUFFIX)?.[1];
  return cands
    .map((c) => ({ ...c, tier: rankTier(inputNorm, normalizeName(c.name)) }))
    .filter((c) => c.tier < 9)
    // "시행령"을 붙여 물었으면 하위법만(상위법 대체 금지); 안 붙였으면 시행령·시행규칙은 접두 일치에서 상위법보다 뒤
    .filter((c) => !sfx || normalizeName(c.name).endsWith(sfx))
    .sort((a, b) => a.tier - b.tier || KIND_RANK(a.kind) - KIND_RANK(b.kind) || a.name.length - b.name.length || a.name.localeCompare(b.name, "ko"));
}

function fromDictionary(norm) {
  const d = dictionary();
  if (!d.entries.length) return null;
  const out = [];
  for (const e of d.entries) {
    const n = normalizeName(e.n);
    if (n === norm || n.startsWith(norm) || n.includes(norm)) out.push({ name: e.n, kind: e.k, lawId: e.i, mst: e.m, effectiveDate: e.e, status: "current" });
  }
  return out;
}

async function fromUpstream(name) {
  const r = await search("eflaw", { query: name, nw: 3, display: 100 }, { rowKeys: ["law"] });
  return { cands: r.rows.map((x) => { const l = lawRow(x); return { name: l.name, kind: l.kind, lawId: l.lawId, mst: l.mst, effectiveDate: l.effectiveDate, status: "current" }; }), hit: r.hit };
}

export const matchTypeOf = (tier) => (tier === 0 ? "exact" : tier === 2 ? "prefix" : "contains");

/**
 * 이름 → {lawId, mst, name, kind, effectiveDate, status, matchType} (현행 기준).
 * 정확 일치 없고 상위 두 후보 점수가 같으면 AMBIGUOUS_NAME(+후보 5). 없으면 LAW_NOT_FOUND.
 * opts.list: 오류 대신 순위 후보 전체를 돌려준다(statute_find 용).
 */
export async function resolveLawName(input, opts = {}) {
  const raw = String(input || "").trim();
  if (!raw || raw.length > 100) throw invalid("법령명은 1~100자");
  let norm = normalizeName(raw);
  const ckey = "resolve:" + norm;
  if (!opts.list) { const hit = cache.get(ckey); if (hit) return { ...hit, cache: "hit" }; }

  await ensureDictionary({ allowNetwork: true });
  const expanded = expandAbbreviation(raw);
  const normEx = expanded ? normalizeName(expanded) : norm;
  let cands = fromDictionary(normEx) || [];
  let hit = true;
  if (!cands.some((c) => normalizeName(c.name) === normEx)) {
    // 사전에 정확 일치가 없으면 업스트림으로 보충(사전이 비었거나 오래됐을 수 있다)
    try { const u = await fromUpstream(expanded || raw); hit = u.hit; const seen = new Set(cands.map((c) => c.lawId)); for (const c of u.cands) if (!seen.has(c.lawId)) cands.push(c); } catch (e) { if (!cands.length) throw e; }
  }
  const ranked = sortCandidates(normEx, cands);
  if (opts.list) return { candidates: ranked, cache: hit ? "hit" : "miss", expandedFrom: expanded ? raw : undefined };
  if (!ranked.length) throw new LawError("LAW_NOT_FOUND", `법령을 찾지 못함: ${raw}`, { hint: "statute_find 로 이름을 확인하세요" });
  const top = ranked[0];
  if (top.tier !== 0 && ranked.length > 1 && ranked[1].tier === top.tier && KIND_RANK(ranked[1].kind) === KIND_RANK(top.kind)) {
    throw new LawError("AMBIGUOUS_NAME", `법령명이 여러 법령에 해당: ${raw}`, { candidates: ranked.slice(0, 5).map(({ tier, ...c }) => ({ ...c, matchType: matchTypeOf(tier) })), hint: "정확한 법령명 또는 lawId 로 다시 부르세요" });
  }
  const { tier, ...res } = top;
  const out = { ...res, matchType: matchTypeOf(tier), inputName: raw, expandedFrom: expanded ? raw : undefined };
  cache.set(ckey, out, Math.min(TTL.resolve, msUntilKstMidnight()));
  return { ...out, cache: hit ? "hit" : "miss" };
}

/**
 * 법령 지정 {name|lawId|mst} 해석 (SPEC §3.3): 우선순위 mst > lawId > name, 서로 모순이면 INVALID_INPUT.
 * mst 만 주어지면 판 목록에서 그 MST 를 찾아 법령ID 를 얻는다(versions 모듈이 처리하므로 여기선 pass-through).
 */
export function pickLawSpec(args) {
  const spec = {};
  if (args.mst != null && String(args.mst).trim()) spec.mst = String(args.mst).trim();
  if (args.lawId != null && String(args.lawId).trim()) spec.lawId = String(args.lawId).trim().padStart(6, "0");
  if (args.name != null && String(args.name).trim()) spec.name = String(args.name).trim();
  if (!spec.mst && !spec.lawId && !spec.name) throw invalid("법령 지정 필요: name | lawId | mst 중 하나");
  if (spec.mst && !/^\d{1,8}$/.test(spec.mst)) throw invalid("mst 는 숫자");
  if (spec.lawId && !/^\d{6}$/.test(spec.lawId)) throw invalid("lawId 는 숫자(6자리)");
  return spec;
}

export { todayKst };
