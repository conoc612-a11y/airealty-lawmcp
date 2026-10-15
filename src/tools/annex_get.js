// annex_get — 별표·서식 목록·본문, 하위법 자동 보충, 중복 제거, 전체 건수 (SPEC §4.4).
import { defineTool, ok, z, S, asOfYmd } from "../tool.js";
import { locate } from "./article_get.js";
import { fetchFullBody } from "../articles.js";
import { resolveLawName, pickLawSpec } from "../resolver.js";
import { todayKst } from "../kst.js";
import { search, asList, str, digits } from "../upstream.js";
import { TTL } from "../cache.js";
import { normalizeUpstreamLink } from "../links.js";
import { normalizeName } from "../dictionary.js";
import { mergeCache, paginateByBytes } from "../envelope.js";
import { invalid } from "../errors.js";

const KIND = { "별표": "table", "서식": "form", "별지": "form", "별도": "table", "부록": "table" };
const flat = (v) => (Array.isArray(v) ? v.map(flat).join("\n") : v && typeof v === "object" ? Object.values(v).map(flat).join("\n") : String(v ?? ""));
const cleanLines = (s) => s.split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim()).filter(Boolean).join("\n");

function parseAnnexNo(input) {
  if (!input) return null;
  const m = String(input).replace(/\s+/g, "").match(/^(별표|서식|별지)?(\d+)(?:의(\d+))?$/);
  if (!m) return null;
  return { kind: m[1] === "서식" || m[1] === "별지" ? "form" : m[1] ? "table" : null, no: +m[2], branch: m[3] ? +m[3] : 0 };
}

/** 본문(법령.별표.별표단위) → 별표 아이템. */
function annexItems(body, law) {
  const out = [];
  for (const a of asList(body?.["법령"]?.["별표"]?.["별표단위"])) {
    const kindKo = str(a["별표구분"]) || "별표";
    const no = parseInt(digits(a["별표번호"]) || "0", 10) || 0;
    const branch = parseInt(digits(a["별표가지번호"]) || "0", 10) || 0;
    const kind = KIND[kindKo] || "table";
    const text = cleanLines(flat(a["별표내용"]));
    const title = str(a["별표제목"]) || str(a["별표제목문자열"]);
    const label = no ? `${kindKo} ${no}${branch ? `의${branch}` : ""}` : kindKo;
    const files = {};
    const pdf = normalizeUpstreamLink(str(a["별표서식PDF파일링크"])); const hwp = normalizeUpstreamLink(str(a["별표서식파일링크"]));
    if (pdf) files.pdf = pdf; else if (str(a["별표PDF파일명"])) files.pdf = str(a["별표PDF파일명"]);
    if (hwp) files.hwp = hwp; else if (str(a["별표HWP파일명"])) files.hwp = str(a["별표HWP파일명"]);
    const rel = (text.match(/\((?:제\d+조(?:의\d+)?(?:제\d+항)?[^)]{0,40})\)/) || [])[0];
    out.push({ law: { name: law.name, kind: law.kind, mst: law.mst }, no: label, number: no, branch, title, kind, relatedArticle: rel ? rel.slice(1, -1) : undefined, text, files, deleted: text.length < 200 && /삭제/.test(text), key: `${law.mst}|${no}|${branch}|${kind}` });
  }
  return out;
}

async function lowerLaws(baseName) {
  const base = baseName.replace(/\s*(시행령|시행규칙)$/, "");
  const out = [];
  for (const sfx of ["시행령", "시행규칙"]) {
    try { const r = await resolveLawName(`${base} ${sfx}`); if (normalizeName(r.name) === normalizeName(`${base}${sfx}`)) out.push(r); } catch {}
  }
  return out;
}

export default defineTool({
  name: "annex_get",
  description: "법령의 별표·서식 목록과 본문을 가져온다. 법률 본문에 별표가 없으면 같은 계열 시행령·시행규칙의 별표·서식을 보충하고, 전체 건수와 페이지, 파일 링크를 돌려준다.",
  schema: { ...S.lawSpec, annexNo: z.string().max(20).optional().describe("예: 별표 1 / 1 / 서식 3"), kind: z.enum(["table", "form", "all"]).default("all"), includeLower: z.boolean().default(true), withText: z.boolean().optional(), asOf: S.asOf, page: S.page, size: S.size(50), maxBytes: S.maxBytes, part: S.part },
  async handler(a) {
    const D = asOfYmd(a.asOf);
    const want = a.annexNo ? parseAnnexNo(a.annexNo) : null;
    if (a.annexNo && !want) throw invalid(`별표 표기를 읽을 수 없음: ${a.annexNo}`);
    const withText = a.withText ?? !!want;
    const cacheStates = []; const warnings = []; const notes = [];
    let items = [], loc, lawsUsed = [];
    if (!withText && D === todayKst()) {
      // 목록 모드(오늘 기준): 별표·서식 목록 API(licbyl, 법령명 검색) 1왕복 — 본문을 받지 않는다. 가족(법률·시행령·시행규칙)으로 거른다.
      const spec = pickLawSpec(a);
      const resolved = spec.name ? await resolveLawName(spec.name) : null;
      loc = resolved ? { law: { name: resolved.name, kind: resolved.kind, lawId: resolved.lawId, mst: resolved.mst, effectiveDate: resolved.effectiveDate, status: "current", upcoming: [] }, cacheStates: [resolved.cache], warnings: [] } : await locate(a, D);
      cacheStates.push(...loc.cacheStates); warnings.push(...loc.warnings);
      const base = loc.law.name.replace(/\s*(시행령|시행규칙)$/, "");
      const family = new Set([normalizeName(loc.law.name)]);
      if (a.includeLower) for (const s of ["시행령", "시행규칙"]) family.add(normalizeName(`${base} ${s}`));
      const rows = [];
      for (let page = 1; page <= 10; page++) {
        const r = await search("licbyl", { search: 2, query: base, display: 100, page }, { rowKeys: ["licbyl"], ttl: TTL.list }); cacheStates.push(r.hit ? "hit" : "miss");
        rows.push(...r.rows); if (r.rows.length < 100 || rows.length >= (r.total || 0)) break;
      }
      const mine = rows.filter((x) => normalizeName(str(x["관련법령명"])) === normalizeName(loc.law.name));
      const chosen = mine.length || !a.includeLower ? mine : rows.filter((x) => family.has(normalizeName(str(x["관련법령명"]))));
      for (const x of chosen) {
        const code = digits(x["별표번호"]); const no = parseInt(code.slice(0, 4) || "0", 10) || 0; const branch = parseInt(code.slice(4, 6) || "0", 10) || 0;
        const kindKo = str(x["별표종류"]) || "별표"; const kind = KIND[kindKo] || "table";
        const files = {}; const pdf = normalizeUpstreamLink(str(x["별표서식PDF파일링크"])); const hwp = normalizeUpstreamLink(str(x["별표서식파일링크"])); if (pdf) files.pdf = pdf; if (hwp) files.hwp = hwp;
        const mst = str(x["관련법령일련번호"]);
        items.push({ law: { name: str(x["관련법령명"]), kind: str(x["법령종류"]), mst }, no: no ? `${kindKo} ${no}${branch ? `의${branch}` : ""}` : kindKo, number: no, branch, title: str(x["별표명"]), kind, files, key: `${mst}|${no}|${branch}|${kind}` });
        if (!lawsUsed.includes(str(x["관련법령명"]))) lawsUsed.push(str(x["관련법령명"]));
      }
      if (!mine.length && chosen.length) notes.push(`${loc.law.name}(${loc.law.kind}) 본문에는 별표·서식이 없어 ${lawsUsed.join("·")}의 별표·서식을 보여 줍니다`);
      if (!lawsUsed.length) lawsUsed.push(loc.law.name, ...(a.includeLower ? [`${base} 시행령`, `${base} 시행규칙`] : []));
    } else {
      loc = await locate(a, D, { prefetch: (acc) => fetchFullBody(acc) });
      cacheStates.push(...loc.cacheStates); warnings.push(...loc.warnings);
      const { body, hit } = loc.prefetched || await fetchFullBody(loc.access); cacheStates.push(hit ? "hit" : "miss");
      items = annexItems(body, loc.law);
      lawsUsed = [loc.law.name];
      if (!items.length && a.includeLower) {
        const lows = await lowerLaws(loc.law.name);
        const subs = await Promise.all(lows.map(async (l) => { try { const sub = await locate({ lawId: l.lawId }, D, { prefetch: (acc) => fetchFullBody(acc) }); const b = sub.prefetched || await fetchFullBody(sub.access); cacheStates.push(b.hit ? "hit" : "miss"); return { sub, body: b.body }; } catch (e) { warnings.push(`${l.name} 별표 조회 실패: ${e.code || "오류"}`); return null; } }));
        for (const s of subs) if (s) { items.push(...annexItems(s.body, s.sub.law)); lawsUsed.push(s.sub.law.name); }
        if (lows.length) notes.push(`${loc.law.name}(${loc.law.kind}) 본문에는 별표·서식이 없어 ${lows.map((l) => l.name).join("·")}의 별표·서식을 보여 줍니다`);
      }
    }
    // 중복 제거(키 = MST|번호|가지|종류)
    const seen = new Set(); items = items.filter((it) => !seen.has(it.key) && seen.add(it.key));
    // 순서: 법령(법률 → 시행령 → 시행규칙) → 종류(별표 → 서식) → 번호 → 가지번호
    const lawRank = (n) => (/시행규칙$/.test(n) ? 2 : /시행령$/.test(n) ? 1 : 0);
    items.sort((x, y) => lawRank(x.law.name) - lawRank(y.law.name) || x.law.name.localeCompare(y.law.name, "ko") || (x.kind === y.kind ? 0 : x.kind === "table" ? -1 : 1) || x.number - y.number || x.branch - y.branch);
    if (a.kind !== "all") items = items.filter((it) => it.kind === a.kind);
    if (want) items = items.filter((it) => it.number === want.no && it.branch === want.branch && (!want.kind || it.kind === want.kind));
    const total = items.length;
    if (!total) {
      notes.push(want ? `${a.annexNo} 에 해당하는 별표·서식이 없습니다(${lawsUsed.join("·")})` : `이 법령과 하위법령(${lawsUsed.join("·")})에 별표·서식 없음`);
      return ok({ items: [], total: 0, warnings, notes, cacheState: mergeCache(cacheStates), asOf: D, next: [{ tool: "statute_outline", args: { lawId: loc.law.lawId, view: "hierarchy" }, why: "하위 법령 구조 확인" }], extra: { law: loc.law } });
    }
    const pageItems = items.slice((a.page - 1) * a.size, a.page * a.size).map((it) => { const { key, ...rest } = it; const o = { ...rest, key }; if (!withText) delete o.text; return o; });
    const pg = withText ? paginateByBytes(pageItems, { maxBytes: a.maxBytes, part: a.part, splitUnit: (it, budget) => { const lines = it.text.split("\n"); const parts = []; let cur = []; let n = 0; for (const l of lines) { if (n + l.length * 3 > budget - 600 && cur.length) { parts.push(cur); cur = []; n = 0; } cur.push(l); n += l.length * 3; } if (cur.length) parts.push(cur); return parts.length > 1 ? parts.map((ls, i) => ({ ...it, text: ls.join("\n"), part: i + 1, parts: parts.length, note: `${it.law.name} ${it.no}가 길어 ${parts.length}개 부분으로 나눔` })) : [it]; } }) : { items: pageItems, part: 1, hasMore: false, warnings: [] };
    warnings.push(...pg.warnings);
    const hasMore = a.page * a.size < total;
    const next = [];
    if (!withText && pageItems[0]) next.push({ tool: "annex_get", args: { name: pageItems[0].law.name, annexNo: pageItems[0].no }, why: `${pageItems[0].law.name} ${pageItems[0].no} 전문` });
    if (pg.hasMore) next.push({ tool: "annex_get", args: { ...(a.name ? { name: a.name } : { lawId: loc.law.lawId }), annexNo: a.annexNo, kind: a.kind, page: a.page, size: a.size, part: pg.part + 1, maxBytes: a.maxBytes }, why: "이어받기" });
    if (hasMore) next.push({ tool: "annex_get", args: { ...(a.name ? { name: a.name } : { lawId: loc.law.lawId }), kind: a.kind, page: a.page + 1, size: a.size }, why: "다음 페이지" });
    if (withText) notes.push("text 는 별표 전문(절단 없음). 표는 줄 단위로 평탄화됨 — 원본 표 형태는 files.pdf/hwp 참고");
    return ok({ items: pg.items, total, page: { no: a.page, size: a.size, hasMore }, warnings, notes, cacheState: mergeCache(cacheStates), asOf: D, next, extra: { law: loc.law, lawsUsed } });
  },
});
