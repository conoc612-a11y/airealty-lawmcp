// statute_outline — 법령 구조·상하위·위임·관련 법령 요약 (SPEC §4.3). 원본 JSON 덤프 금지, hierarchy ≤ 8KB.
import { defineTool, ok, z, S, asOfYmd } from "../tool.js";
import { locate } from "./article_get.js";
import { service, search, asList, str, digits } from "../upstream.js";
import { TTL } from "../cache.js";
import { fmtDate } from "../kst.js";
import { fetchFullBody, tocUnits } from "../articles.js";
import { articleLabel, toJoCode } from "../jo.js";
import { parseArticleRef } from "../jo.js";
import { lawLink, adminRuleLink } from "../links.js";
import { mergeCache, bytesOf } from "../envelope.js";
import { invalid } from "../errors.js";
import { readHierarchy, writeHierarchy, refreshHierarchy, relatedRows } from "../hierarchy_cache.js";
import { loadDictionarySync } from "../dictionary.js";

export { summarizeTree };
const kindFromDictionary = (lawId) => loadDictionarySync().entries.find((e) => e.i === lawId)?.k || "";

const node = (b) => ({ name: str(b?.["법령명"]), kind: str(b?.["법종구분"]), lawId: str(b?.["법령ID"]), mst: str(b?.["법령일련번호"]), effectiveDate: fmtDate(b?.["시행일자"]) });
const ruleNode = (b) => ({ name: str(b?.["행정규칙명"]), kind: str(b?.["행정규칙종류"]), id: str(b?.["행정규칙일련번호"]) || str(b?.["행정규칙ID"]), date: fmtDate(b?.["발령일자"]) || fmtDate(b?.["시행일자"]), link: adminRuleLink(str(b?.["행정규칙명"])) });

/** 체계도(lsStmd) → 요약 트리. 응답 구조가 중첩/흔들려서 재귀로 "기본정보" 노드를 모은다. */
function summarizeTree(data) {
  const root = data?.["법령체계도"] || data;
  const base = root?.["기본정보"] || {};
  const rel = root?.["상하위법"] || {};
  const lawNode = rel?.["법률"] || {};
  const out = { law: node(base), upper: [], lower: { decree: [], rule: [] }, adminRules: { total: 0, items: [] }, ordinances: { total: 0 }, decreeDetails: [] };
  const collectRules = (o) => { let n = 0; const items = []; for (const [k, v] of Object.entries(o || {})) for (const x of asList(v)) { if (x?.["기본정보"]) { n++; items.push({ ...ruleNode(x["기본정보"]), kind: k }); } } return { n, items }; };
  const countOrd = (o) => { let n = 0; for (const v of Object.values(o || {})) n += asList(v).length; return n; };
  const kind = str(base["법종구분"]);
  const basePresent = lawNode?.["기본정보"];
  if (/법률|헌법/.test(kind) || !basePresent) {
    // 요청 법령이 법률: 하위 시행령·시행규칙 + 행정규칙 + 자치법규
    const decrees = asList(lawNode?.["시행령"]);
    for (const d of decrees) { const n = node(d?.["기본정보"]); if (n.name) out.lower.decree.push(n); for (const r of asList(d?.["시행규칙"])) { const rn = node(r?.["기본정보"]); if (rn.name && !out.lower.rule.some((x) => x.lawId === rn.lawId)) out.lower.rule.push(rn); } }
    for (const r of asList(lawNode?.["시행규칙"])) { const rn = node(r?.["기본정보"]); if (rn.name && !out.lower.rule.some((x) => x.lawId === rn.lawId)) out.lower.rule.push(rn); }
    const rules = collectRules(lawNode?.["행정규칙"]); out.adminRules.total += rules.n; out.adminRules.items.push(...rules.items);
    out.ordinances.total += countOrd(lawNode?.["자치법규"]);
    for (const d of decrees) { const r2 = collectRules(d?.["행정규칙"]); out.adminRules.total += r2.n; out.adminRules.items.push(...r2.items); out.ordinances.total += countOrd(d?.["자치법규"]); for (const r of asList(d?.["시행규칙"])) { const r3 = collectRules(r?.["행정규칙"]); out.adminRules.total += r3.n; out.adminRules.items.push(...r3.items); out.ordinances.total += countOrd(r?.["자치법규"]); } }
  } else {
    // 요청 법령이 시행령·시행규칙: 상위 법률과 형제·하위
    const up = node(lawNode?.["기본정보"]); if (up.name && up.lawId !== out.law.lawId) out.upper.push(up);
    for (const d of asList(lawNode?.["시행령"])) { const n = node(d?.["기본정보"]); if (n.name && n.lawId !== out.law.lawId) { if (/대통령령/.test(n.kind)) { if (/규칙|부령|총리령/.test(kind)) out.upper.push(n); else out.lower.decree.push(n); } } for (const r of asList(d?.["시행규칙"])) { const rn = node(r?.["기본정보"]); if (rn.name && rn.lawId !== out.law.lawId && !out.lower.rule.some((x) => x.lawId === rn.lawId)) out.lower.rule.push(rn); } const r2 = collectRules(d?.["행정규칙"]); out.adminRules.total += r2.n; out.adminRules.items.push(...r2.items); out.ordinances.total += countOrd(d?.["자치법규"]); }
    const rules = collectRules(lawNode?.["행정규칙"]); out.adminRules.total += rules.n; out.adminRules.items.push(...rules.items);
  }
  const seen = new Set(); out.adminRules.items = out.adminRules.items.filter((r) => r.name && !seen.has(r.name) && seen.add(r.name));
  out.adminRules.total = Math.max(out.adminRules.total, out.adminRules.items.length);
  out.adminRules.items = out.adminRules.items.slice(0, 20);
  delete out.decreeDetails;
  return out;
}

/** 3단비교(thdCmp knd=2 위임) → 트리 {law,label,title,children:[{law,label,title,children}]}, 본문 없음. */
function delegationTree(data, lawName, onlyRef) {
  const root = data && typeof data === "object" ? Object.values(data).find((v) => v && typeof v === "object") : null;
  const cmp = root?.["위임조문삼단비교"] || root?.["인용조문삼단비교"] || {};
  const items = [];
  const decreeName = str(root?.["기본정보"]?.["시행령명"]) || "시행령";
  const ruleName = str(root?.["기본정보"]?.["시행규칙명"]) || "시행규칙";
  const cleanTitle = (t) => { const s = str(t); const m = s.match(/^제\d+조(?:의\d+)?\s*\(([^)]*)\)\s*$/); return (m ? m[1] : s) || undefined; };
  const joNode = (law, x, labelKey, branchKey, titleKey) => { const a = parseInt(digits(x?.[labelKey]), 10); if (!Number.isFinite(a)) return null; const b = parseInt(digits(x?.[branchKey]) || "0", 10) || 0; return { law: str(x?.["법령명"]) || law, label: articleLabel(a, b), title: cleanTitle(x?.[titleKey]) }; };
  const byLabel = new Map();
  for (const art of asList(cmp["법률조문"])) {
    const a = parseInt(digits(art["조번호"]), 10); if (!Number.isFinite(a)) continue;
    const b = parseInt(digits(art["조가지번호"]) || "0", 10) || 0;
    if (onlyRef && (a !== onlyRef.article || b !== (onlyRef.branch || 0))) continue;
    const label = articleLabel(a, b);
    const n = byLabel.get(label) || { law: lawName, label, title: cleanTitle(art["조제목"]), children: [] };
    const isNew = !byLabel.has(label); byLabel.set(label, n);
    if (!isNew) { appendChildren(n, art, decreeName, ruleName, joNode); continue; }
    appendChildren(n, art, decreeName, ruleName, joNode);
    // 장·절 머리는 뺀다
    if (!n.children.length && /^제\d+[장절관편]/.test(str(art["조내용"]))) { byLabel.delete(label); continue; }
    items.push(n);
  }
  return items;
}
function appendChildren(n, art, decreeName, ruleName, joNode) {
  const addUnique = (arr, node) => { if (node && !arr.some((x) => x.law === node.law && x.label === node.label)) arr.push(node); return node; };
  const decrees = asList(art["시행령조문목록"]?.["시행령조문"] ?? art["시행령조문"]);
  for (const d of decrees) {
    const dn0 = joNode(decreeName, d, "조번호", "조가지번호", "조제목") || joNode(decreeName, d, "시행령조번호", "시행령조가지번호", "시행령조제목"); if (!dn0) continue;
    const dn = n.children.find((x) => x.law === dn0.law && x.label === dn0.label) || addUnique(n.children, { ...dn0, children: [] });
    for (const r of asList(d["시행규칙조문목록"]?.["시행규칙조문"] ?? d["시행규칙조문"])) addUnique(dn.children, joNode(ruleName, r, "조번호", "조가지번호", "조제목") || joNode(ruleName, r, "시행규칙조번호", "시행규칙조가지번호", "시행규칙조제목"));
    for (const w of asList(d["위임행정규칙목록"]?.["위임행정규칙"] ?? d["위임행정규칙"])) { const nm = str(w["위임행정규칙명"]); if (nm) addUnique(dn.children, { law: nm, label: str(w["위임행정규칙조번호"]) ? articleLabel(parseInt(digits(w["위임행정규칙조번호"]), 10), parseInt(digits(w["위임행정규칙조가지번호"]) || "0", 10) || 0) : undefined, kind: "adminRule" }); }
  }
  for (const r of asList(art["시행규칙조문목록"]?.["시행규칙조문"] ?? art["시행규칙조문"])) addUnique(n.children, joNode(ruleName, r, "조번호", "조가지번호", "조제목"));
  for (const w of asList(art["위임행정규칙목록"]?.["위임행정규칙"] ?? art["위임행정규칙"])) { const nm = str(w["위임행정규칙명"]); if (nm) addUnique(n.children, { law: nm, kind: "adminRule" }); }
}

export default defineTool({
  name: "statute_outline",
  description: "법령의 구조를 요약한다: 목차(toc), 상하위 법령·행정규칙·자치법규 수(hierarchy), 법률→시행령→시행규칙 위임 트리(delegation), 관련 법령(related). 본문은 담지 않고 article_get 호출을 안내한다.",
  schema: { ...S.lawSpec, view: z.enum(["toc", "hierarchy", "delegation", "related"]).default("hierarchy"), article: z.string().max(40).optional().describe("delegation 에서 특정 조문만"), delegationKind: z.enum(["delegated", "cited"]).default("delegated"), asOf: S.asOf, page: S.page, size: S.size(50) },
  async handler(a) {
    const D = asOfYmd(a.asOf);
    const loc = await locate(a, D);
    const { law, access } = loc; const cacheStates = [...loc.cacheStates]; const warnings = [...loc.warnings]; const notes = [];
    const nextArticle = (label) => ({ tool: "article_get", args: { lawId: law.lawId, articles: [label] }, why: `${law.name} ${label} 원문` });
    if (a.view === "toc") {
      const { body, hit } = await fetchFullBody(access); cacheStates.push(hit ? "hit" : "miss");
      const toc = tocUnits(body); const tree = []; let cur = null;
      for (const t of toc) { if (t.heading) { cur = { heading: t.heading, articles: [] }; tree.push(cur); } else { if (!cur) { cur = { heading: "", articles: [] }; tree.push(cur); } cur.articles.push({ label: t.label, title: t.title, ...(t.status ? { status: t.status } : {}) }); } }
      const first = toc.find((t) => t.label);
      return ok({ items: tree, total: toc.filter((t) => t.label).length, warnings, notes, cacheState: mergeCache(cacheStates), asOf: D, next: first ? [nextArticle(first.label)] : [], extra: { law } });
    }
    if (a.view === "hierarchy") {
      // 체계도(lsStmd)는 업스트림이 수 초 걸린다 → ① 디스크 요약(7일, 만료 시 옛 값 먼저·뒤에서 갱신) ② 없으면 관련법령(lsRlt, 빠름)으로
      // 상하위 뼈대를 먼저 만들고 체계도는 시간 예산 안에서만 기다린다. 늦게 온 체계도도 디스크에 적어 다음 호출부터 바로 쓴다.
      const ident = { lawId: law.lawId, mst: access.mst };
      const disk = readHierarchy(ident);
      let tree, related = null, haveStmd = false;
      if (disk && disk.tree) {
        cacheStates.push("hit"); tree = disk.tree; related = disk.related; haveStmd = true;
        if (disk.stale) { refreshHierarchy(ident, summarizeTree, { background: true }).catch(() => {}); notes.push("체계도는 디스크 캐시(7일 지남)를 먼저 쓰고 뒤에서 갱신 중"); }
      } else {
        const stmdP = service("lsStmd", { MST: access.mst }, { ttl: TTL.body, long: true }).catch(() => null);
        const rltP = search("lsRlt", { ID: law.lawId }, { rowKeys: ["법령"], ttl: TTL.body }).catch(() => null);
        Promise.all([stmdP, rltP]).then(([s, r]) => { if (s || r) writeHierarchy(ident, { tree: s ? summarizeTree(s.data) : null, related: r ? relatedRows(r.rows) : [] }); }).catch(() => {});
        const budgetMs = +process.env.LAWMCP_HIERARCHY_BUDGET_MS || 1200;
        const stmd = await Promise.race([stmdP, new Promise((res) => setTimeout(() => res("pending"), budgetMs))]);
        if (stmd && stmd !== "pending") { cacheStates.push(stmd.hit ? "hit" : "miss"); tree = summarizeTree(stmd.data); haveStmd = true; }
        const rlt = await rltP;
        if (rlt) { cacheStates.push(rlt.hit ? "hit" : "miss"); related = relatedRows(rlt.rows); }
      }
      if (!haveStmd) {
        tree = { law: {}, upper: [], lower: { decree: [], rule: [] }, adminRules: { total: null, items: [] }, ordinances: { total: null } };
        notes.push("행정규칙·자치법규 수는 법제처 체계도가 아직 준비되지 않아 비워 둠(null) — 같은 호출을 잠시 뒤 다시 부르면 채워집니다");
      }
      if (related) {
        for (const x of related) {
          const nm = x.name, id = x.lawId, rel = x.relation;
          if (!nm || id === law.lawId) continue;
          // 법종은 사전(법령ID → 법종구분: 국토교통부령·대법원규칙…)에서; 사전에 없을 때만 이름 끝말로 추정
          const nd = { name: nm, lawId: id, kind: kindFromDictionary(id) || (/시행령|규정$/.test(nm) && !/규칙/.test(nm) ? "대통령령" : /시행규칙|규칙$/.test(nm) ? "부령" : "") };
          if (/상위/.test(rel) && !tree.upper.some((u) => u.lawId === id)) tree.upper.push(nd);
          if (/하위/.test(rel)) { const bucket = /규칙$/.test(nm) ? tree.lower.rule : tree.lower.decree; if (!bucket.some((u) => u.lawId === id)) bucket.push(nd); }
        }
        if (!haveStmd) notes.push("상하위 법령은 법령정보 지식베이스 관련법령(상위법·하위법 유형)에서 가져옴 — 법종·MST 는 statute_find 로 확인");
      }
      if (!tree.law.name) tree.law = { name: law.name, kind: law.kind, lawId: law.lawId, mst: law.mst, effectiveDate: law.effectiveDate };
      const item = { ...tree, law: { ...tree.law, link: lawLink(tree.law.name) } };
      const next = [];
      if (item.lower.decree[0]) next.push({ tool: "statute_outline", args: { lawId: item.lower.decree[0].lawId, view: "hierarchy" }, why: `${item.lower.decree[0].name} 의 구조` });
      next.push({ tool: "statute_outline", args: { lawId: law.lawId, view: "delegation" }, why: "조문 단위 위임 관계" });
      if (item.adminRules.total > item.adminRules.items.length) { notes.push(`행정규칙 ${item.adminRules.total}건 중 상위 ${item.adminRules.items.length}건만 표시`); next.push({ tool: "source_search", args: { source: "admin_rule", query: law.name.replace(/\s*(시행령|시행규칙)$/, "") }, why: "관련 행정규칙 전체 검색" }); }
      if (item.ordinances.total) next.push({ tool: "toolbox", args: { action: "call", name: "ordinance_link", args: { lawId: law.lawId } }, why: `연계 자치법규 ${item.ordinances.total}건` });
      const body = ok({ items: [item], total: 1, warnings, notes, cacheState: mergeCache(cacheStates), asOf: D, next, extra: { law } });
      if (bytesOf(body) > 8000) { item.adminRules.items = item.adminRules.items.slice(0, 8); notes.push("크기 예산(8KB)으로 행정규칙 목록을 8건으로 줄임"); }
      return body;
    }
    if (a.view === "delegation") {
      const onlyRef = a.article ? parseArticleRef(a.article) : null;
      if (a.article && !onlyRef) throw invalid(`조문 표기를 읽을 수 없음: ${a.article}`);
      const { data, hit } = await service("thdCmp", { MST: access.mst, knd: a.delegationKind === "cited" ? 1 : 2 }, { ttl: TTL.body, long: true }); cacheStates.push(hit ? "hit" : "miss");
      const root = data && typeof data === "object" ? Object.values(data).find((v) => v && typeof v === "object") : null;
      if (str(root?.["기본정보"]?.["삼단비교존재여부"]) === "N") return ok({ items: [], total: 0, warnings, notes: ["이 법령에는 3단비교(위임 관계) 자료가 없습니다"], cacheState: mergeCache(cacheStates), asOf: D, extra: { law } });
      const items = delegationTree(data, law.name, onlyRef);
      const total = items.length;
      const pageItems = items.slice((a.page - 1) * a.size, a.page * a.size);
      notes.push("본문 없음 — 각 노드는 article_get 으로 원문을 받으세요");
      const next = pageItems[0] ? [nextArticle(pageItems[0].label)] : [];
      if (pageItems[0]?.children?.[0]) next.push({ tool: "article_get", args: { name: pageItems[0].children[0].law, articles: [pageItems[0].children[0].label] }, why: "위임 받은 하위 조문 원문" });
      if (a.page * a.size < total) next.push({ tool: "statute_outline", args: { lawId: law.lawId, view: "delegation", page: a.page + 1, size: a.size }, why: "다음 페이지" });
      return ok({ items: pageItems, total, page: { no: a.page, size: a.size, hasMore: a.page * a.size < total }, warnings, notes, cacheState: mergeCache(cacheStates), asOf: D, next, extra: { law } });
    }
    // related
    const r = await search("lsRlt", { ID: law.lawId }, { rowKeys: ["법령"], ttl: TTL.body }); cacheStates.push(r.hit ? "hit" : "miss");
    const base = r.rows[0] || {};
    const items = asList(base["관련법령"]).map((x) => ({ name: str(x["관련법령명"]), lawId: str(x["관련법령ID"]), relation: str(x["법령간관계"]), relationCode: str(x["법령간관계코드"]), link: lawLink(str(x["관련법령명"])) })).filter((x) => x.name);
    const total = items.length; const pageItems = items.slice((a.page - 1) * a.size, a.page * a.size);
    return ok({ items: pageItems, total, page: { no: a.page, size: a.size, hasMore: a.page * a.size < total }, warnings, notes: ["관계 종류는 법령정보 지식베이스 분류(유형 번호)를 그대로 씀"], cacheState: mergeCache(cacheStates), asOf: D, next: pageItems[0] ? [{ tool: "statute_outline", args: { lawId: pageItems[0].lawId, view: "hierarchy" }, why: `${pageItems[0].name} 구조` }] : [], extra: { law } });
  },
});
