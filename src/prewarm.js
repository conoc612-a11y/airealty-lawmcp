// 예열 — 서버가 뜬 뒤(stdio 는 initialize 응답 뒤) 백그라운드에서 자주 쓰는 법령의 조문 번호 색인(24h)과 체계도 요약(7d)을 디스크에 채운다.
// 요청을 막지 않는다: 순차 1건씩, drf background 레인(전경 요청 진행 중·버킷 여유 2토큰 미만이면 대기)으로만 나간다. LAWMCP_PREWARM=0 으로 끈다.
import { ensureDictionary } from "./dictionary.js";
import { resolveLawName } from "./resolver.js";
import { getArticleIndex, hasFreshIndex } from "./article_index.js";
import { hasFreshHierarchy, refreshHierarchy } from "./hierarchy_cache.js";

// tools/collect_law_rag.py LAWS(2026-10-13) + 벤치·인용 검사에서 자주 나오는 법령. 수집기 목록이 바뀌면 같이 고친다.
export const PREWARM_LAWS = [
  "주택임대차보호법", "주택임대차보호법 시행령", "상가건물 임대차보호법", "상가건물 임대차보호법 시행령",
  "도시 및 주거환경정비법", "도시 및 주거환경정비법 시행령", "빈집 및 소규모주택 정비에 관한 특례법",
  "재건축초과이익 환수에 관한 법률", "주택법", "주택법 시행령", "주택공급에 관한 규칙",
  "공인중개사법", "공인중개사법 시행령", "공인중개사법 시행규칙", "민간임대주택에 관한 특별법", "민간임대주택에 관한 특별법 시행령",
  "공공주택 특별법", "부동산 거래신고 등에 관한 법률", "부동산 거래신고 등에 관한 법률 시행령",
  "국토의 계획 및 이용에 관한 법률", "국토의 계획 및 이용에 관한 법률 시행령", "건축법", "건축법 시행령",
  "부동산등기법", "집합건물의 소유 및 관리에 관한 법률", "민법",
  "소득세법", "소득세법 시행령", "지방세법", "지방세법 시행령", "종합부동산세법", "종합부동산세법 시행령",
  "지방세특례제한법", "상속세 및 증여세법", "조세특례제한법",
  // 자주 묻는 것(벤치 B9·문서 위험 규칙 근거)
  "주택법 시행규칙", "상법", "공인중개사법 시행규칙",
];

const OFF = new Set(["0", "off", "false", "no"]);
export function prewarmEnabled() { return !OFF.has(String(process.env.LAWMCP_PREWARM ?? "1").trim().toLowerCase()); }

export const prewarmState = { state: "idle", total: 0, done: 0, index: { built: 0, skipped: 0, failed: 0 }, hierarchy: { built: 0, skipped: 0, failed: 0 }, startedAt: null, finishedAt: null, errors: [] };
let running = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 비차단 시작. 두 번 불러도 한 번만 돈다. 반환 Promise 는 테스트·벤치에서만 기다린다. */
export function startPrewarm({ laws = PREWARM_LAWS, hierarchy = true, summarize } = {}) {
  if (!prewarmEnabled()) { prewarmState.state = "disabled"; return Promise.resolve(prewarmState); }
  if (running) return running;
  running = new Promise((resolve) => setTimeout(() => run({ laws, hierarchy, summarize }).then(resolve, resolve), 0));
  return running;
}

async function run({ laws, hierarchy, summarize }) {
  prewarmState.state = "running"; prewarmState.startedAt = Date.now(); prewarmState.total = laws.length * (hierarchy ? 2 : 1); prewarmState.done = 0;
  const resolved = new Map();
  try { await ensureDictionary(); } catch {}
  // 1) 조문 번호 색인(사용자 체감이 큰 것부터)
  for (const name of laws) {
    try {
      const r = await resolveLawName(name); resolved.set(name, r);
      const access = { lawId: r.lawId, useId: true };
      const ver = { mst: r.mst, efYd: String(r.effectiveDate || "").replace(/\D/g, "") };
      if (hasFreshIndex(access, ver)) prewarmState.index.skipped++;
      else { await getArticleIndex(access, ver, { background: true }); prewarmState.index.built++; }
    } catch (e) { prewarmState.index.failed++; if (prewarmState.errors.length < 10) prewarmState.errors.push(`index ${name}: ${e?.code || e?.message || e}`); }
    prewarmState.done++;
    await sleep(50);
  }
  // 2) 체계도 요약(업스트림 ~7초/건 — 전경 요청에 양보하며 천천히)
  if (hierarchy) {
    if (!summarize) { const m = await import("./tools/statute_outline.js"); summarize = m.summarizeTree; }
    for (const name of laws) {
      try {
        const r = resolved.get(name) || (await resolveLawName(name));
        const ident = { lawId: r.lawId, mst: r.mst };
        if (!r.mst) throw new Error("mst 없음");
        if (hasFreshHierarchy(ident)) prewarmState.hierarchy.skipped++;
        else { await refreshHierarchy(ident, summarize, { background: true }); prewarmState.hierarchy.built++; }
      } catch (e) { prewarmState.hierarchy.failed++; if (prewarmState.errors.length < 10) prewarmState.errors.push(`hierarchy ${name}: ${e?.code || e?.message || e}`); }
      prewarmState.done++;
      await sleep(50);
    }
  }
  prewarmState.state = "done"; prewarmState.finishedAt = Date.now();
  return prewarmState;
}

export const _test = { reset() { running = null; Object.assign(prewarmState, { state: "idle", total: 0, done: 0, index: { built: 0, skipped: 0, failed: 0 }, hierarchy: { built: 0, skipped: 0, failed: 0 }, startedAt: null, finishedAt: null, errors: [] }); } };
