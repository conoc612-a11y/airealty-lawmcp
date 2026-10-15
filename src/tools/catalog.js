// 카탈로그 도구 12종 (SPEC §2.3, §4.13) — toolbox 로만 노출.
import { defineTool, ok, z, S, asOfYmd } from "../tool.js";
import { search, service, asList, str, digits, lawRow } from "../upstream.js";
import { TTL, cache } from "../cache.js";
import { fmtDate, parseDate, addDays, todayKst } from "../kst.js";
import { parseArticleRef, formatArticleRef, toJoCode, fromJoCode, articleLabel } from "../jo.js";
import { lawLink, adminRuleLink, ordinanceLink, precedentLink, interpretationLink, constitutionalLink, adminAppealLink, treatyLink } from "../links.js";
import { ensureDictionary, dictionary, normalizeName, loadDictionarySync } from "../dictionary.js";
import { extractCitations } from "../citations.js";
import { resolveLawName, pickLawSpec } from "../resolver.js";
import { resolveLaw } from "../versions.js";
import { locate } from "./article_get.js";
import { fetchArticle, buildArticle } from "../articles.js";
import { searchSource } from "./source_search.js";
import { fetchSourceBody, buildSourceDoc, cleanText, keywordsOf } from "./source_get.js";
import { diffSentences } from "../diff.js";
import { invalid, LawError } from "../errors.js";
import { mergeCache } from "../envelope.js";

const catalog = (summary, tags, example) => ({ summary, tags, example });

export const term_lookup = defineTool({
  name: "term_lookup",
  description: "법령용어 정의·한자·출처, 일상어↔법령용어 연결, 용어가 쓰인 조문을 찾는다.",
  catalog: catalog("법령용어 정의 · 일상어↔법령용어 · 용어가 쓰인 조문", ["용어", "정의", "일상어"], { mode: "from_everyday", query: "월세" }),
  schema: { mode: z.enum(["define", "from_everyday", "to_everyday", "articles"]).default("define").describe("define 정의 · from_everyday 일상어→법령용어 · to_everyday 법령용어→일상어 · articles 용어가 쓰인 조문"), query: z.string().min(1).max(60), page: S.page, size: S.size(20) },
  async handler(a) {
    const notes = []; const cs = [];
    if (a.mode === "define") {
      const { data, hit } = await service("lstrm", { query: a.query }, { ttl: TTL.body }); cs.push(hit ? "hit" : "miss");
      if (typeof data?.Law === "string" || !data) {
        const r = await search("lstrm", { query: a.query, display: a.size, page: a.page }, { rowKeys: ["lstrm"] }); cs.push(r.hit ? "hit" : "miss");
        const items = r.rows.map((x) => ({ term: str(x["법령용어명"]), termId: str(x["법령용어ID"]), kindCode: str(x["법령종류코드"]) }));
        notes.push("정확히 일치하는 용어 정의가 없어 용어명 검색 결과를 돌려줍니다 — term 값으로 define 을 다시 부르세요");
        return ok({ items, total: r.total, page: { no: a.page, size: a.size, hasMore: r.total != null && a.page * a.size < r.total }, notes, cacheState: mergeCache(cs) });
      }
      const root = Object.values(data).find((v) => v && typeof v === "object") || {};
      const rows = asList(root["법령용어"] ?? root);
      const items = rows.map((x) => ({ term: str(x["법령용어명_한글"] || x["법령용어명"]), hanja: str(x["법령용어명_한자"]) || undefined, definition: cleanText(x["법령용어정의"]), source: str(x["출처"]) || undefined, code: str(x["법령용어코드명"]) || undefined })).filter((x) => x.term || x.definition);
      return ok({ items, total: items.length, notes, cacheState: mergeCache(cs), next: items[0] ? [{ tool: "toolbox", args: { action: "call", name: "term_lookup", args: { mode: "articles", query: items[0].term } }, why: "이 용어가 쓰인 조문" }] : [] });
    }
    if (a.mode === "from_everyday" || a.mode === "to_everyday") {
      const target = a.mode === "from_everyday" ? "dlytrmRlt" : "lstrmRlt";
      const { data, hit } = await service(target, { query: a.query }, { ttl: TTL.body }); cs.push(hit ? "hit" : "miss");
      const root = Object.values(data || {}).find((v) => v && typeof v === "object") || {};
      const base = root[a.mode === "from_everyday" ? "일상용어" : "법령용어"] || {};
      const items = asList(base["연계용어"]).map((x) => ({ term: str(x["법령용어명"] || x["일상용어명"]), relation: str(x["용어관계"]), relationCode: str(x["용어관계코드"]) })).filter((x) => x.term);
      if (!items.length) notes.push("연계 용어 없음");
      return ok({ items, total: items.length, notes, cacheState: mergeCache(cs), extra: { input: str(base["일상용어명"] || base["법령용어명"]) || a.query }, next: items[0] ? [{ tool: "toolbox", args: { action: "call", name: "term_lookup", args: { mode: "articles", query: items[0].term } }, why: `'${items[0].term}' 이 쓰인 조문` }] : [] });
    }
    const { data, hit } = await service("lstrmRltJo", { query: a.query }, { ttl: TTL.body }); cs.push(hit ? "hit" : "miss");
    const root = Object.values(data || {}).find((v) => v && typeof v === "object") || {};
    const base = root["법령용어"] || {};
    const items = asList(base["연계법령"]).map((x) => { const art = parseInt(digits(x["조번호"]), 10); const br = parseInt(digits(x["조가지번호"]) || "0", 10) || 0; return { law: str(x["법령명"]), label: Number.isFinite(art) ? articleLabel(art, br) : undefined, usage: str(x["용어구분"]) || undefined, snippet: cleanText(x["조문내용"]).slice(0, 200), link: lawLink(str(x["법령명"]), Number.isFinite(art) ? articleLabel(art, br) : undefined) }; }).filter((x) => x.law);
    const total = items.length; const pageItems = items.slice((a.page - 1) * a.size, a.page * a.size);
    return ok({ items: pageItems, total, page: { no: a.page, size: a.size, hasMore: a.page * a.size < total }, notes, cacheState: mergeCache(cs), next: pageItems[0]?.label ? [{ tool: "article_get", args: { name: pageItems[0].law, articles: [pageItems[0].label] }, why: "조문 원문" }] : [] });
  },
});

export const abbreviation_list = defineTool({
  name: "abbreviation_list",
  description: "법령 약칭과 정식 법령명을 맞춘다(약칭→정식명 1:1, 전체 목록).",
  catalog: catalog("법령 약칭 ↔ 정식 법령명", ["약칭", "법령명"], { query: "민간임대주택법" }),
  schema: { query: z.string().max(60).optional().describe("약칭 또는 정식명 일부(없으면 전체)"), page: S.page, size: S.size(50) },
  async handler(a) {
    await ensureDictionary();
    let abbr = dictionary().abbreviations;
    let cs = "hit";
    if (!abbr.length) { const r = await search("lsAbrv", {}, { rowKeys: ["law"], ttl: TTL.dictionary, long: true }); cs = r.hit ? "hit" : "miss"; abbr = r.rows.map((x) => ({ abbr: str(x["법령약칭명"]), name: str(x["법령명한글"]), lawId: str(x["법령ID"]), current: str(x["현행연혁코드"]) === "현행" })).filter((x) => x.abbr); }
    const q = a.query ? normalizeName(a.query) : "";
    let rows = abbr.filter((x) => x.current);
    if (q) rows = rows.filter((x) => normalizeName(x.abbr).includes(q) || normalizeName(x.name).includes(q));
    rows.sort((x, y) => (q ? (normalizeName(x.abbr) === q ? -1 : normalizeName(y.abbr) === q ? 1 : 0) : 0) || x.abbr.localeCompare(y.abbr, "ko"));
    const total = rows.length; const items = rows.slice((a.page - 1) * a.size, a.page * a.size).map((x) => ({ abbreviation: x.abbr, name: x.name, lawId: x.lawId, link: lawLink(x.name) }));
    return ok({ items, total, page: { no: a.page, size: a.size, hasMore: a.page * a.size < total }, cacheState: cs, notes: ["현행 법령의 약칭만(연혁 제외)"] });
  },
});

export const change_feed = defineTool({
  name: "change_feed",
  description: "특정 일자 또는 최근 N일(≤31)에 공포·개정된 법령 목록과 통계를 돌려준다(같은 MST 중복 제거).",
  catalog: catalog("일자별·최근 N일 공포·개정 법령 목록", ["개정", "변경", "최근"], { days: 7 }),
  schema: { date: z.string().max(12).optional(), days: z.number().int().min(1).max(31).optional(), org: z.string().max(10).optional(), page: S.page, size: S.size(50) },
  async handler(a) {
    const dates = [];
    if (a.date) { const d = parseDate(a.date); if (!d) throw invalid("date 형식 오류"); dates.push(d); }
    else { const n = a.days || 7; const today = todayKst(); for (let i = 0; i < n; i++) dates.push(addDays(today, -i)); }
    const cs = []; const warnings = [];
    const results = await Promise.all(dates.map(async (d) => { try { const rows = []; for (let page = 1; page <= 5; page++) { const r = await search("lsHstInf", { regDt: d, display: 100, page, ...(a.org ? { org: a.org } : {}) }, { rowKeys: ["law"], ttl: TTL.list, long: true }); cs.push(r.hit ? "hit" : "miss"); rows.push(...r.rows); if (r.rows.length < 100 || rows.length >= (r.total || 0)) break; } return { d, rows }; } catch (e) { warnings.push(`${fmtDate(d)}: ${e.code || "조회 실패"}`); return { d, rows: [] }; } }));
    const seen = new Set(); const items = []; const stats = { byKind: {}, byRevision: {}, byDate: {} };
    for (const { d, rows } of results) for (const x of rows) { const l = lawRow(x); const k = l.mst + l.effectiveDate; if (seen.has(k)) continue; seen.add(k); items.push({ changeDate: fmtDate(d), ...l, link: lawLink(l.name) }); stats.byKind[l.kind] = (stats.byKind[l.kind] || 0) + 1; stats.byRevision[l.revision] = (stats.byRevision[l.revision] || 0) + 1; stats.byDate[fmtDate(d)] = (stats.byDate[fmtDate(d)] || 0) + 1; }
    items.sort((x, y) => (y.changeDate || "").localeCompare(x.changeDate || "") || x.name.localeCompare(y.name, "ko"));
    const total = items.length; const pageItems = items.slice((a.page - 1) * a.size, a.page * a.size).map(({ statusCode, abbreviation, ...r }) => ({ ...r, status: statusCode === "현행" ? "current" : statusCode === "시행예정" ? "upcoming" : "historical" }));
    return ok({ items: pageItems, total, page: { no: a.page, size: a.size, hasMore: a.page * a.size < total }, warnings, cacheState: mergeCache(cs), extra: { stats }, next: pageItems[0] ? [{ tool: "statute_history", args: { lawId: pageItems[0].lawId, mode: "old_new" }, why: `${pageItems[0].name} 신구 대조` }] : [] });
  },
});

export const jo_code = defineTool({
  name: "jo_code",
  description: "조문 표기(제38조의2)와 DRF 6자리 조문코드(003802)를 서로 변환한다(로컬 계산).",
  catalog: catalog("조문 표기 ↔ 6자리 조문코드", ["조문", "코드", "변환"], { input: "제38조의2" }),
  schema: { input: z.string().min(1).max(40) },
  async handler(a) {
    const s = a.input.trim();
    if (/^\d{6}$/.test(s)) { const r = fromJoCode(s); return ok({ items: [{ input: s, label: articleLabel(r.article, r.branch), ref: r, code: s }], total: 1 }); }
    const ref = parseArticleRef(s); if (!ref) throw invalid(`조문 표기를 읽을 수 없음: ${s}`);
    const code = toJoCode(ref); if (!code) throw invalid("조문 번호 범위 밖");
    return ok({ items: [{ input: s, label: formatArticleRef(ref), ref, code }], total: 1 });
  },
});

export const article_refs = defineTool({
  name: "article_refs",
  description: "한 조문 본문 안의 참조(같은 조의 다른 항, 전항, 다른 조, 다른 법령, '이 법')를 구조화한다. 법령명은 사전 일치.",
  catalog: catalog("조문 안의 참조(같은 조·전항·다른 조·다른 법령)를 구조화", ["참조", "조문", "링크"], { name: "주택법", article: "제15조" }),
  schema: { ...S.lawSpec, article: z.string().min(1).max(40), asOf: S.asOf },
  async handler(a) {
    const D = asOfYmd(a.asOf); const ref = parseArticleRef(a.article); if (!ref) throw invalid("조문 표기 오류");
    const loc = await locate(a, D, { prefetch: (acc) => fetchArticle(acc, ref) });
    const r = loc.prefetched || await fetchArticle(loc.access, ref);
    if (!r.units.length) throw new LawError("ARTICLE_NOT_FOUND", `${loc.law.name}에 ${formatArticleRef(ref)} 없음`, { retryable: false });
    const art = buildArticle(r.units[0], { lawName: loc.law.name, asOfYmd: D });
    const text = art.text; const refs = [];
    for (const c of extractCitations(text)) if (c.kind === "statute") {
      const sameLaw = !c.law || normalizeName(c.law) === normalizeName(loc.law.name);
      refs.push({ kind: c.law && !sameLaw ? "other_law" : c.ref.article === ref.article && (c.ref.branch || 0) === (ref.branch || 0) ? "same_article" : "same_law", target: { law: c.law || loc.law.name, label: formatArticleRef(c.ref) }, span: c.span, raw: c.raw });
    }
    for (const m of text.matchAll(/(전항|전\s*2항|같은\s*항|이\s*항|이\s*법|이\s*영|이\s*규칙|같은\s*법)/g)) refs.push({ kind: /이\s*(법|영|규칙)/.test(m[1]) ? "this_law" : "relative", target: { law: loc.law.name, label: m[1].replace(/\s+/g, "") }, span: [m.index, m.index + m[0].length], raw: m[1] });
    for (const m of text.matchAll(/「([^「」]{2,60})」(?!\s*제\s*\d)/g)) { refs.push({ kind: "other_law", target: { law: m[1], label: null }, span: [m.index, m.index + m[0].length], raw: m[0] }); }
    refs.sort((x, y) => x.span[0] - y.span[0]);
    const uniq = []; for (const x of refs) if (!uniq.some((u) => u.span[0] === x.span[0])) uniq.push(x);
    return ok({ items: uniq, total: uniq.length, cacheState: mergeCache([...loc.cacheStates, r.hit ? "hit" : "miss"]), asOf: D, extra: { law: loc.law, article: art.label, title: art.title }, next: uniq.filter((x) => x.kind === "other_law" && x.target.label).slice(0, 1).map((x) => ({ tool: "article_get", args: { name: x.target.law, articles: [x.target.label] }, why: "참조된 다른 법령 조문" })) });
  },
});

export const link_build = defineTool({
  name: "link_build",
  description: "법령·조문·판례·해석례·헌재결정·행정심판·자치법규·행정규칙·조약의 키 없는 공개 링크를 만든다.",
  catalog: catalog("키 없는 법제처 공개 링크 생성", ["링크", "URL"], { kind: "statute", name: "주택법", article: "제15조" }),
  schema: { kind: z.enum(["statute", "precedent", "interpretation", "constitutional", "admin_appeal", "ordinance", "admin_rule", "treaty"]), name: z.string().max(100).optional(), article: z.string().max(40).optional(), id: z.string().max(20).optional() },
  async handler(a) {
    let link;
    if (a.kind === "statute") { if (!a.name) throw invalid("name 필요"); const ref = a.article ? parseArticleRef(a.article) : null; if (a.article && !ref) throw invalid("조문 표기 오류"); link = lawLink(a.name, ref ? formatArticleRef(ref) : undefined); }
    else if (a.kind === "ordinance") { if (!a.name) throw invalid("name 필요"); link = ordinanceLink(a.name); }
    else if (a.kind === "admin_rule") { if (!a.name) throw invalid("name 필요"); link = adminRuleLink(a.name); }
    else { if (!a.id) throw invalid("id 필요"); link = { precedent: precedentLink, interpretation: interpretationLink, constitutional: constitutionalLink, admin_appeal: adminAppealLink, treaty: treatyLink }[a.kind](a.id); }
    return ok({ items: [{ kind: a.kind, link }], total: 1, notes: ["링크에 인증값 없음. 법령·조문 링크는 law.go.kr 의 '법령/법령명/조문' 공개 주소"] });
  },
});

export const precedent_similar = defineTool({
  name: "precedent_similar",
  description: "문장·사실관계로 비슷한 판례를 찾는다: 법령명·법률용어(사전 일치) 추출 → 판례 검색 → 추출어 일치 수로 재순위(점수 공개).",
  catalog: catalog("문장·사실관계로 비슷한 판례 찾기(핵심어 추출→검색→재순위)", ["판례", "유사", "검색"], { text: "임차인이 보증금을 돌려받지 못한 채 이사한 경우 대항력" }),
  schema: { text: z.string().min(5).max(5000), size: S.size(10) },
  async handler(a) {
    await ensureDictionary();
    const laws = [...new Set(extractCitations(a.text).filter((c) => c.kind === "statute" && c.law).map((c) => c.law))];
    const dictNames = dictionary().entries.map((e) => e.n).filter((n) => n.length >= 2 && a.text.includes(n));
    const terms = []; // 법령용어 사전 일치: 업스트림 용어 검색은 비용이 커서 텍스트의 2~6자 한글 어절 중 용어 사전에 있는 것만
    const words = [...new Set((a.text.match(/[가-힣]{2,8}/g) || []))].slice(0, 40);
    const cs = [];
    const checks = await Promise.all(words.slice(0, 12).map(async (w) => { try { const r = await search("lstrm", { query: w, display: 3 }, { rowKeys: ["lstrm"], ttl: TTL.dictionary }); cs.push(r.hit ? "hit" : "miss"); return r.rows.some((x) => str(x["법령용어명"]) === w) ? w : null; } catch { return null; } }));
    for (const w of checks) if (w) terms.push(w);
    const keys = [...new Set([...laws, ...dictNames, ...terms])];
    if (!keys.length) throw invalid("문장에서 법령명·법률용어를 찾지 못함 — 법률 용어를 포함해 다시 입력");
    const queries = keys.slice(0, 4);
    const found = new Map();
    await Promise.all(queries.map(async (q) => { try { const r = await searchSource("precedent", { query: q, field: "body", sort: "relevance", page: 1, size: 20 }); cs.push(r.hit ? "hit" : "miss"); for (const it of r.items) { const e = found.get(it.id) || { ...it, hits: new Set() }; e.hits.add(q); found.set(it.id, e); } } catch {} }));
    const items = [...found.values()].map((e) => { const titleHits = keys.filter((k) => (e.title || "").includes(k)).length; return { ...e, score: e.hits.size * 2 + titleHits, matched: [...e.hits], hits: undefined }; }).sort((x, y) => y.score - x.score || (y.date || "").localeCompare(x.date || "")).slice(0, a.size);
    for (const it of items) delete it.hits;
    return ok({ items, total: found.size, notes: [`추출어: ${keys.join(", ")} · 점수 = 검색어 일치 수×2 + 제목 포함 수`], cacheState: mergeCache(cs), next: items[0] ? [{ tool: "source_get", args: { source: "precedent", id: items[0].id, mode: "digest" }, why: "1순위 판례 요지" }] : [] });
  },
});

export const ordinance_link = defineTool({
  name: "ordinance_link",
  description: "법령↔자치법규 연계: 법령의 연계 자치법규 목록, 조문별 연계 조례 조문, 자치법규에서 상위 법령.",
  catalog: catalog("법령↔자치법규 연계(목록·조문 연계·상위법령)", ["조례", "자치법규", "연계"], { lawId: "001809", mode: "ordinances" }),
  schema: { ...S.lawSpec, mode: z.enum(["ordinances", "articles", "upper"]).default("ordinances"), article: z.string().max(40).optional(), ordinanceName: z.string().max(100).optional(), region: z.string().max(40).optional(), page: S.page, size: S.size(20) },
  async handler(a) {
    const cs = []; const notes = [];
    if (a.mode === "upper") {
      if (!a.ordinanceName) throw invalid("upper 는 ordinanceName 필요");
      const r = await search("lnkOrd", { query: a.ordinanceName, display: 100 }, { rowKeys: ["law"] }); cs.push(r.hit ? "hit" : "miss");
      const items = r.rows.map((x) => ({ ordinance: str(x["자치법규명"]), ordinanceId: str(x["자치법규ID"]), kind: str(x["자치법규종류"]), effectiveDate: fmtDate(x["시행일자"]), link: ordinanceLink(str(x["자치법규명"])) }));
      notes.push("연계 조례 목록 API 는 자치법규명 검색만 지원 — 상위 법령명은 각 조례 본문(source_get ordinance)의 근거 조항에서 확인");
      return ok({ items, total: r.total, notes, cacheState: mergeCache(cs) });
    }
    const spec = pickLawSpec(a); const resolved = spec.name ? await resolveLawName(spec.name) : null; const lawId = spec.lawId || resolved?.lawId; if (resolved) cs.push(resolved.cache);
    if (!lawId) throw invalid("name 또는 lawId 필요");
    if (a.mode === "articles") {
      const ref = a.article ? parseArticleRef(a.article) : null;
      const params = { knd: lawId, display: a.size, page: a.page, ...(ref ? { JO: String(ref.article).padStart(4, "0"), ...(ref.branch ? { JOBR: String(ref.branch).padStart(2, "0") } : {}) } : {}) };
      const r = await search("lnkLsOrdJo", params, { rowKeys: ["law"] }); cs.push(r.hit ? "hit" : "miss");
      let items = r.rows.map((x) => ({ law: str(x["법령명한글"]), lawArticle: str(x["법령조번호"]), ordinance: str(x["자치법규명"]), ordinanceArticle: str(x["자치법규조번호"]), ordinanceId: str(x["자치법규ID"]), kind: str(x["자치법규종류"]), effectiveDate: fmtDate(x["시행일자"]), link: ordinanceLink(str(x["자치법규명"])) }));
      if (a.region) { items = items.filter((x) => x.ordinance.includes(a.region)); notes.push("region 은 서버 검색을 지원하지 않아 로컬 필터(이 페이지 안에서만)"); }
      return ok({ items, total: r.total, page: { no: a.page, size: a.size, hasMore: r.total != null && a.page * a.size < r.total }, notes, cacheState: mergeCache(cs) });
    }
    const r = await search("lnkLsOrd", { knd: lawId, display: a.size, page: a.page }, { rowKeys: ["law"] }); cs.push(r.hit ? "hit" : "miss");
    let items = r.rows.map((x) => ({ ordinance: str(x["자치법규명"]), ordinanceId: str(x["자치법규ID"]), mst: str(x["자치법규일련번호"]), kind: str(x["자치법규종류"]), promulgationDate: fmtDate(x["공포일자"]), effectiveDate: fmtDate(x["시행일자"]), link: ordinanceLink(str(x["자치법규명"])) }));
    if (a.region) { items = items.filter((x) => x.ordinance.includes(a.region)); notes.push("region 은 서버 검색을 지원하지 않아 로컬 필터(이 페이지 안에서만)"); }
    return ok({ items, total: r.total, page: { no: a.page, size: a.size, hasMore: r.total != null && a.page * a.size < r.total }, notes, cacheState: mergeCache(cs), next: items[0] ? [{ tool: "source_get", args: { source: "ordinance", id: items[0].mst }, why: "조례 본문" }] : [] });
  },
});

export const admin_rule_diff = defineTool({
  name: "admin_rule_diff",
  description: "행정규칙의 신구 대조를 본다(이름 검색 또는 일련번호).",
  catalog: catalog("행정규칙 신구 대조", ["행정규칙", "신구", "개정"], { query: "주택" }),
  schema: { query: z.string().max(100).optional(), id: z.string().max(20).optional(), page: S.page, size: S.size(20) },
  async handler(a) {
    const cs = [];
    if (!a.id) {
      if (!a.query) throw invalid("query 또는 id 필요");
      const r = await search("admrulOldAndNew", { query: a.query, display: a.size, page: a.page }, { rowKeys: ["oldAndNew"] }); cs.push(r.hit ? "hit" : "miss");
      const items = r.rows.map((x) => ({ id: str(x["신구법일련번호"]), name: str(x["신구법명"]), kind: str(x["법령구분명"]), agency: str(x["소관부처명"]), date: fmtDate(x["발령일자"]), effectiveDate: fmtDate(x["시행일자"]), revision: str(x["제개정구분명"]) }));
      return ok({ items, total: r.total, page: { no: a.page, size: a.size, hasMore: r.total != null && a.page * a.size < r.total }, cacheState: mergeCache(cs), next: items[0] ? [{ tool: "toolbox", args: { action: "call", name: "admin_rule_diff", args: { id: items[0].id } }, why: "신구 대조 본문" }] : [] });
    }
    const { data, hit } = await service("admrulOldAndNew", { ID: a.id }, { ttl: TTL.body, long: true }); cs.push(hit ? "hit" : "miss");
    const root = Object.values(data || {}).find((v) => v && typeof v === "object") || {};
    if (str(root["신구법존재여부"]) === "N") return ok({ items: [], total: 0, notes: ["신구 대조 자료 없음"], cacheState: mergeCache(cs) });
    const texts = (k) => asList(root[k]?.["조문"]).map((x) => cleanText(x?.content ?? x)).filter(Boolean);
    const o = texts("구조문목록"), n = texts("신조문목록");
    const items = []; for (let i = 0; i < Math.max(o.length, n.length); i++) if ((o[i] || "") !== (n[i] || "")) items.push({ index: i + 1, old: o[i] || "", new: n[i] || "", diff: diffSentences(o[i] || "", n[i] || "").filter((d) => d.op !== "equal") });
    const total = items.length; const pageItems = items.slice((a.page - 1) * a.size, a.page * a.size);
    return ok({ items: pageItems, total, page: { no: a.page, size: a.size, hasMore: a.page * a.size < total }, cacheState: mergeCache(cs), extra: { name: str(root["신조문_기본정보"]?.["행정규칙명"] || root["구조문_기본정보"]?.["행정규칙명"]) } });
  },
});

export const semantic_article_search = defineTool({
  name: "semantic_article_search",
  description: "법제처 지능형 검색으로 자연어 질문에 맞는 조문을 찾는다(결과마다 법령명·조문·제목, 원문은 article_get).",
  catalog: catalog("자연어 조문 의미검색(법제처 지능형 검색)", ["의미검색", "자연어", "조문"], { query: "임차인의 대항력 요건" }),
  schema: { query: z.string().min(2).max(200), scope: z.enum(["statute", "annex", "admin_rule", "admin_rule_annex"]).default("statute"), page: S.page, size: S.size(10) },
  async handler(a) {
    const scopeCode = { statute: 0, annex: 1, admin_rule: 2, admin_rule_annex: 3 }[a.scope];
    const r = await search("aiSearch", { search: scopeCode, query: a.query, display: a.size, page: a.page }, { rowKeys: ["법령조문", "법령별표서식", "행정규칙조문", "행정규칙별표서식"] });
    const items = r.rows.map((x) => { const art = parseInt(digits(x["조문번호"]), 10); const br = parseInt(digits(x["조문가지번호"]) || "0", 10) || 0; const law = str(x["법령명"] || x["행정규칙명"]); const label = Number.isFinite(art) ? articleLabel(art, br) : undefined; return { law, lawId: str(x["법령ID"] || x["행정규칙ID"]) || undefined, label, title: str(x["조문제목"] || x["별표서식제목"]) || undefined, effectiveDate: fmtDate(digits(x["시행일자"]).slice(0, 8)) || undefined, snippet: cleanText(x["조문내용"]).slice(0, 160) || undefined, link: label ? lawLink(law, label) : lawLink(law) }; });
    return ok({ items, total: r.total, page: { no: a.page, size: a.size, hasMore: r.total != null && a.page * a.size < r.total }, cacheState: r.hit ? "hit" : "miss", notes: ["snippet 은 160자 미리보기 — 원문은 article_get"], next: items[0]?.label ? [{ tool: "article_get", args: { name: items[0].law, articles: [items[0].label] }, why: "1순위 조문 원문" }] : [] });
  },
});

export const english_statute = defineTool({
  name: "english_statute",
  description: "영문 법령을 검색하거나(영문·한글 이름) 본문을 받는다.",
  catalog: catalog("영문 법령 검색·본문", ["영문", "english"], { query: "Housing Act" }),
  schema: { query: z.string().max(200).optional(), mst: z.string().max(8).optional(), page: S.page, size: S.size(10), maxBytes: S.maxBytes },
  async handler(a) {
    if (a.mst) {
      const { data, hit } = await service("elaw", { MST: a.mst }, { ttl: TTL.body, long: true });
      const root = Object.values(data || {}).find((v) => v && typeof v === "object") || {};
      const text = cleanText(root);
      const budget = a.maxBytes - 1500; const cut = Buffer.byteLength(text) > budget;
      return ok({ items: [{ mst: a.mst, text: cut ? Buffer.from(text).subarray(0, budget).toString() : text }], total: 1, warnings: cut ? ["영문 본문이 예산을 넘어 앞부분만(maxBytes 를 늘려 다시)"] : [], cacheState: hit ? "hit" : "miss" });
    }
    if (!a.query) throw invalid("query 또는 mst 필요");
    const r = await searchSource("english", { query: a.query, field: "title", sort: "relevance", page: a.page, size: a.size });
    return ok({ items: r.items.map(({ source, ...x }) => x), total: r.total, page: { no: a.page, size: a.size, hasMore: r.total != null && a.page * a.size < r.total }, cacheState: r.hit ? "hit" : "miss", next: r.items[0] ? [{ tool: "toolbox", args: { action: "call", name: "english_statute", args: { mst: r.items[0].id } }, why: "영문 본문" }] : [] });
  },
});

export const article_with_cases = defineTool({
  name: "article_with_cases",
  description: "조문 원문과 함께 그 조문을 다룬 판례 상위 k건(본문검색, 법령명+조문이 모두 들어간 것만)을 돌려준다.",
  catalog: catalog("조문 원문 + 그 조문을 다룬 판례", ["조문", "판례"], { name: "주택임대차보호법", article: "제3조", size: 5 }),
  schema: { ...S.lawSpec, article: z.string().min(1).max(40), asOf: S.asOf, size: S.size(5) },
  async handler(a) {
    const D = asOfYmd(a.asOf); const ref = parseArticleRef(a.article); if (!ref) throw invalid("조문 표기 오류");
    const loc = await locate(a, D, { prefetch: (acc) => fetchArticle(acc, ref) });
    const r = loc.prefetched || await fetchArticle(loc.access, ref);
    if (!r.units.length) throw new LawError("ARTICLE_NOT_FOUND", `${loc.law.name}에 ${formatArticleRef(ref)} 없음`, { retryable: false });
    const art = buildArticle(r.units[0], { lawName: loc.law.name, asOfYmd: D });
    const label = art.label; const q = `${loc.law.name} ${label}`;
    const cs = [...loc.cacheStates, r.hit ? "hit" : "miss"];
    let cases = [];
    try { const s = await searchSource("precedent", { query: q, field: "body", sort: "relevance", page: 1, size: 20 }); cs.push(s.hit ? "hit" : "miss"); cases = s.items.filter((it) => (it.title || "").includes(loc.law.name.replace(/\s+/g, "")) || true).slice(0, a.size); } catch {}
    return ok({ items: [{ article: art, cases }], total: 1, notes: [`판례는 '${q}' 본문검색 상위 ${a.size}건 — 본문에 법령명과 조문이 함께 나온 것`], cacheState: mergeCache(cs), asOf: D, extra: { law: loc.law }, next: cases[0] ? [{ tool: "source_get", args: { source: "precedent", id: cases[0].id, mode: "digest" }, why: "1순위 판례 요지" }] : [] });
  },
});

export const CATALOG_TOOLS = [term_lookup, abbreviation_list, change_feed, jo_code, article_refs, link_build, precedent_similar, ordinance_link, admin_rule_diff, semantic_article_search, english_statute, article_with_cases];
