import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cache } from "../src/cache.js";
import { publicSearchRows } from "../src/prepared_documents.js";
import { setDocumentStore } from "../src/upstream.js";
import { _setApiKey } from "../src/keys.js";
import { _setDictionary } from "../src/dictionary.js";
import { getTool } from "../src/registry.js";
import { _test as drf } from "../src/drf.js";
import { msUntilKstMidnight } from "../src/kst.js";

import { listVersions, selectVersion } from "../src/versions.js";

import { requestKey } from "../src/drf.js";

function environment(t) {
  const dir = mkdtempSync(join(tmpdir(), "article-snapshot-"));
  const prev = process.env.LAWMCP_CACHE_DIR;
  process.env.LAWMCP_CACHE_DIR = dir;
  cache.clear(); drf.reset(); _setApiKey("fixture-only");
  _setDictionary({ entries: [{ n: "시험법", i: "000123", k: "법률", m: "321" }] });
  const rows = new Map(), reads = [], upstream = [];
  setDocumentStore({
    async get(key) { reads.push(key); return rows.get(key); },
    async put(key, data, _started, expiresAt) { rows.set(key, { data: structuredClone(data), expiresAt }); },
  });
  t.mock.method(globalThis, "fetch", async input => {
    const url = new URL(input); upstream.push(url.pathname);
    if (url.pathname.endsWith("lawSearch.do")) return Response.json({ LawSearch: { totalCnt: 1, law: [
      { 법령명한글: "시험법", 법령구분명: "법률", 법령ID: "000123", 법령일련번호: "321", 시행일자: "20190101", 현행연혁코드: "현행" },
    ] } });
    const num = Number((url.searchParams.get("JO") || "000100").slice(0, 4));
    return Response.json({ 법령: {
      기본정보: { 법령ID: "000123", 법령명_한글: "시험법", 시행일자: "20190101" },
      조문: { 조문단위: [{ 조문여부:"조문", 조문번호:String(num), 조문제목:"제목", 조문내용:"제" + num + "조(제목)", 항:[{항번호:"①",항내용:"① 본문"}] }] },
      별표: { 별표단위: [{ 별표번호: "0001", 별표구분:"별표", 별표내용:"기준 1", 별표제목:"기준" }] },
    } });
  });
  t.after(() => {
    cache.clear(); setDocumentStore(null); _setApiKey(""); drf.reset();
    if (prev === undefined) delete process.env.LAWMCP_CACHE_DIR; else process.env.LAWMCP_CACHE_DIR = prev;
    rmSync(dir, { recursive:true, force:true });
  });
  return { rows, reads, upstream };
}

test("판과 조문을 한 번에 읽고 조회 순서·항·출력 형식·기준일을 보존한다", async t => {
  const { rows, reads, upstream } = environment(t);
  const get = args => getTool("article_get").invoke(args);
  const initial = await get({lawId:"123",articles:["제1조","제2조"],asOf:"2020-01-01"});
  assert.equal(initial.ok,true);
  const key = [...rows.keys()].find(k=>k.startsWith("article-set:"));
  const expiry=rows.get(key).expiresAt;
  assert.ok(expiry <= Date.now()+msUntilKstMidnight());
  cache.clear(); reads.length=0; const priorCalls=upstream.length;
  const reverse=await get({name:"시험법",articles:["제2조제1항","제1조"],format:"text",asOf:"2020-01-01"});
  assert.equal(reverse.ok,true);
  assert.deepEqual(reverse.items.map(x=>x.article),[2,1]);
  assert.ok(reverse.items[0].scope.includes("제1항")); assert.equal(reverse.items[0].paragraphs,undefined);
  assert.deepEqual(reads,[key]); assert.equal(upstream.length,priorCalls);
  assert.equal(cache.expiresAt(key),expiry);
  const invalidBranch=await get({lawId:"123",articles:["제1조의100"],asOf:"2020-01-01"});
  assert.equal(invalidBranch.ok,false);
  const otherDate=await get({lawId:"123",articles:["제2조","제1조"],asOf:"2021-01-01"});
  assert.equal(otherDate.ok,true);
  assert.notEqual(reads.at(-1),key);
  cache.clear(); rows.get(key).expiresAt=Date.now()-1; reads.length=0;
  assert.equal((await get({lawId:"123",articles:["제1조","제2조"],asOf:"2020-01-01"})).ok,true);
  assert.ok(reads.length>1);
});

test("목차와 별표는 별도로 읽고 모법에 별표가 있으면 누락된 번호를 하위법에서 찾지 않는다", async t => {
  const { rows, reads, upstream } = environment(t);
  const run = (name,args) => getTool(name).invoke({lawId:"123",...args});
  const toc = await run("article_get",{});
  assert.equal(toc.ok,true);
  const annex = await run("annex_get",{annexNo:"1",withText:true});
  assert.equal(annex.items[0].text,"기준 1");
  assert.ok([...rows.keys()].some(k=>k.includes('"toc"')));
  const was=upstream.length;
  cache.clear();reads.length=0;
  const outline=await run("statute_outline",{view:"toc"});
  assert.equal(outline.items[0].articles[0].label,"제1조");assert.equal(upstream.length,was);
  assert.ok(reads.some(k=>k.includes('"toc"')));
  const missing=await run("annex_get",{annexNo:"2",withText:true,includeLower:true});
  assert.equal(missing.total,0);
  assert.ok(!missing.notes.some(x=>x.includes("본문에는")));
});

test("공유 검색 목록은 필터별로 구분하고 원래 검색문과 미가공 응답을 저장하지 않는다", async t => {
  const { rows, upstream } = environment(t);
  const query = "민감한 입력 예";
  const load = page => publicSearchRows("statute", "eflaw", { query, page }, ["law"], row => ({ title: row.법령명한글 }));
  const first = await load(1);
  assert.equal(first.items[0].title, "시험법");
  const key = [...rows.keys()].find(k => k.startsWith("public-list:"));
  assert.ok(key && !key.includes(query));
  assert.deepEqual(rows.get(key).data, { items: [{ title: "시험법" }], total: 1 });
  first.items[0].title = "changed";
  cache.clear();
  const repeated = await load(1);
  assert.deepEqual(repeated.items, [{ title: "시험법" }]);
  assert.equal(repeated.hit, true);
  assert.equal(upstream.length, 1);
  await load(2);
  assert.equal(upstream.length, 2);
});

test("기존 원본 페이지 두 개를 한 목록으로 읽고 동시 호출과 원본 만료 시각을 보존한다", async t => {
  const { rows, reads, upstream } = environment(t);
  const expiresAt = Date.now() + 60000;
  for (const page of [1, 2]) {
    const params = { target: "eflaw", LID: "000123", nw: "1,2,3", display: 100, page, sort: "efdes" };
    const data = { LawSearch: { totalCnt: 101, law: [{
      법령명한글: "시험법", 법령구분명: "법률", 법령ID: "000123",
      법령일련번호: String(324 - page), 시행일자: page === 1 ? "20200101" : "20150101",
    }] } };
    rows.set("drf:" + requestKey("lawSearch.do", params), { data, expiresAt: expiresAt + (page - 1) * 1000 });
  }
  const [first, concurrent] = await Promise.all([listVersions("000123"), listVersions("000123")]);
  assert.deepEqual(first, concurrent);
  assert.equal(first.versions.length, 2);
  assert.equal(first.expiresAt, expiresAt);
  assert.equal(reads.length, 3);
  const key = "version-list:v1:000123";
  assert.equal(rows.get(key).expiresAt, expiresAt);
  cache.clear();
  reads.length = 0;
  const shared = await listVersions("000123");
  assert.deepEqual(shared.versions, first.versions);
  assert.equal(shared.expiresAt, expiresAt);
  assert.deepEqual(reads, [key]);
  assert.deepEqual(upstream, []);
});

test("날짜 판 조회는 예정 판을 보존하고 짧은 목록을 전체 연혁으로 저장하지 않는다", async t => {
  const { rows } = environment(t);
  const pages = [];
  const date = "20260101";
  const make = (day, i) => ({ 법령ID: "000123", 법령일련번호: String(800 + i), 법령명한글: "시험법",
    시행일자: day, 현행연혁코드: day === date ? "현행" : day > date ? "시행예정" : "연혁" });
  const history = ["20280101", "20270101", date, date, ...Array(11).fill("20200101")].map(make);
  t.mock.method(globalThis, "fetch", async input => {
    const size = Number(new URL(input).searchParams.get("display")); pages.push(size);
    return Response.json({ LawSearch: { totalCnt: history.length, law: history.slice(0, size) } });
  });
  const recent = await listVersions("000123", date);
  assert.deepEqual(pages, [12]);
  const selected = selectVersion(recent.versions, date);
  assert.equal(selected.upcoming.length, 2);
  assert.equal(rows.has("version-list:v1:000123"), false);
  cache.clear();
  assert.deepEqual(selectVersion((await listVersions("000123", date)).versions, date), selected);
  assert.deepEqual(pages, [12]);
  const full = await listVersions("000123");
  assert.deepEqual(pages, [12, 100]);
  assert.equal(full.versions.length, history.length);
  assert.deepEqual(selectVersion(full.versions, date), selected);
});

test("적용일이 최근 목록 끝에 걸리면 다음 행의 같은 날짜 현행 판까지 확인한다", async t => {
  environment(t);
  const date = "20260101", pages = [];
  const history = Array.from({ length: 14 }, (_, i) => ({
    법령일련번호: String(100 + i), 법령ID: "000123", 법령명한글: "시험법",
    시행일자: i < 11 ? "20270101" : i < 13 ? date : "20200101",
    현행연혁코드: i < 11 ? "시행예정" : i === 12 ? "현행" : "연혁",
  }));
  t.mock.method(globalThis, "fetch", async input => {
    const size = Number(new URL(input).searchParams.get("display")); pages.push(size);
    return Response.json({ LawSearch: { totalCnt: history.length, law: history.slice(0, size) } });
  });
  const [one, two] = await Promise.all([listVersions("000123", date), listVersions("000123", date)]);
  assert.deepEqual(pages, [12, 100]); assert.deepEqual(one.versions, two.versions);
  const selected = selectVersion(one.versions, date);
  assert.equal(selected.chosen.mst, "112"); assert.equal(selected.upcoming.length, 11);
});

test("새 인스턴스는 현행 검색 페이지와 시행예정 판을 한 번에 읽고 원래 만료 시각을 지킨다", async t => {
  const { rows, reads, upstream } = environment(t);
  const find = args => getTool("statute_find").invoke({ query: "시험법", size: 3, ...args });
  const expiresAt = Date.now() + 30000;
  const versions = [
    { mst: "789", efYd: "20990101", effectiveDate: "2099-01-01", statusCode: "시행예정" },
    { mst: "321", efYd: "20190101", effectiveDate: "2019-01-01", statusCode: "현행" },
  ];
  rows.set("version-list:v1:000123", { data: { versions, name: "시험법", kind: "법률" }, expiresAt });
  const first = await find({});
  assert.equal(first.ok, true);
  assert.deepEqual(first.items[0].upcoming, [{ mst: "789", effectiveDate: "2099-01-01" }]);
  const pageKey = [...rows.keys()].find(k => k.startsWith("public-list:v1:statute-page:"));
  assert.equal(rows.get(pageKey).expiresAt, expiresAt);
  const withoutTiming = result => {
    const { elapsedMs, upstreamMs, ...meta } = result.meta;
    return { ...result, meta };
  };
  const expected = withoutTiming(structuredClone(first));
  expected.meta.cache = "hit";
  first.items[0].upcoming.length = 0;
  cache.clear();
  reads.length = 0;
  const count = upstream.length;
  const repeated = await find({});
  assert.deepEqual(withoutTiming(repeated), expected);
  assert.deepEqual(reads, [pageKey]);
  assert.equal(upstream.length, count);
  repeated.notes.push("변경");
  assert.deepEqual(withoutTiming(await find({})), expected);
  for (const args of [{size: 2}, {page: 2}, {kinds: ["부령"]}, {promulgatedFrom: "2010-01-01"}]) {
    reads.length = 0;
    const other = await find(args);
    assert.equal(other.ok, true);
    assert.ok(reads[0]?.startsWith("public-list:v1:statute-page:"));
    assert.notEqual(reads[0], pageKey);
    if (args.page || args.kinds) assert.equal(other.items.length, 0);
  }
  cache.clear();
  rows.get(pageKey).expiresAt = Date.now() - 1;
  reads.length = 0;
  assert.equal((await find({})).ok, true);
  assert.ok(reads.length > 1);
});

test("시행판 확인 실패와 낱말 합집합 조회는 완성된 현행 검색 페이지로 공유하지 않는다", async t => {
  const { rows } = environment(t);
  const fetchLaw = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async input => new URL(input).searchParams.has("LID")
    ? Response.json({ LawSearch: { totalCnt: 0, law: [] } }) : fetchLaw(input));
  const find = args => getTool("statute_find").invoke({ query: "비공개 검색문 예", ...args });
  for (const args of [{}, {match: "any"}]) {
    const result = await find(args);
    assert.equal(result.ok, true);
    assert.equal(result.items[0].name, "시험법");
    assert.deepEqual(result.items[0].upcoming, []);
  }
  assert.ok([...rows.keys()].some(k => k.startsWith("public-list:v1:statute:")));
  assert.ok([...rows.keys()].every(k => !k.startsWith("public-list:v1:statute-page:")));
  assert.ok(!JSON.stringify([...rows]).includes("비공개 검색문 예"));
});

test("한국 자정에 시행되는 판은 같은 검색이어도 새 기준일의 판과 시행예정 목록을 돌려준다", async t => {
  const { rows, reads } = environment(t);
  const midnight = Date.parse("2030-03-02T00:00:00+09:00");
  let now = midnight - 1000;
  t.mock.method(Date, "now", () => now);
  const versions = [
    { mst: "322", efYd: "20300302", effectiveDate: "2030-03-02", statusCode: "시행예정" },
    { mst: "321", efYd: "20190101", effectiveDate: "2019-01-01", statusCode: "현행" },
  ];
  rows.set("version-list:v1:000123", { data: { versions }, expiresAt: midnight + 60000 });
  const find = extra => getTool("statute_find").invoke({ query: "시험법", ...extra });
  const before = await find({});
  assert.equal(before.items[0].mst, "321");
  assert.equal(before.items[0].upcoming[0].mst, "322");
  const oldKey = [...rows.keys()].find(k => k.startsWith("public-list:v1:statute-page:"));
  assert.equal(rows.get(oldKey).expiresAt, midnight);
  now = midnight + 1;
  const after = await find({});
  assert.equal(after.meta.asOf, "2030-03-02");
  assert.equal(after.items[0].mst, "322");
  assert.deepEqual(after.items[0].upcoming, []);
  assert.equal([...rows.keys()].filter(k => k.startsWith("public-list:v1:statute-page:")).length, 2);
  cache.clear();
  reads.length = 0;
  const any = await find({match: "any"});
  assert.equal(any.items[0].mst, "322");
  assert.ok(reads.every(k => !k.startsWith("public-list:v1:statute-page:")));
});

test("현행 조문은 검색에서 읽은 시행판을 재사용하고 과거 판과 전체 연혁을 별도로 조회한다", async t => {
  environment(t);
  const original = globalThis.fetch;
  const displays = [];
  const dates = ["20990101", "20190101", ...Array.from({length: 12}, (_, i) => String(2018 - i) + "0101")];
  const versions = dates.map((day, i) => ({
    법령ID: "000123", 법령명한글: "시험법", 법령구분명: "법률", 시행일자: day,
    법령일련번호: String(500 - i), 현행연혁코드: i === 0 ? "시행예정" : i === 1 ? "현행" : "연혁",
  }));
  t.mock.method(globalThis, "fetch", async input => {
    const url = new URL(input);
    if (!url.searchParams.has("LID")) return original(input);
    const size = Number(url.searchParams.get("display"));
    displays.push(size);
    return Response.json({ LawSearch: { totalCnt: versions.length, law: versions.slice(0, size) } });
  });
  const find = await getTool("statute_find").invoke({ query: "시험법" });
  assert.ok(find.ok);
  assert.deepEqual(displays, [12]);
  const article = args => getTool("article_get").invoke({ lawId: "123", articles: ["제1조"], ...args });
  const current = await article({});
  assert.equal(current.law.mst, "499");
  assert.equal(current.law.upcoming[0].mst, "500");
  assert.deepEqual(displays, [12]);
  const old = await article({ asOf: "2014-06-08" });
  assert.equal(old.law.effectiveDate, "2014-01-01");
  assert.deepEqual(displays, [12, 100]);
  const specific = await article({ mst: "487" });
  assert.equal(specific.law.mst, "487");
  const history = await getTool("statute_history").invoke({ lawId: "123", mode: "versions" });
  assert.equal(history.total, versions.length);
});

test("연혁 100번째 행과 다음 쪽에 같은 시행일의 판이 있으면 다음 쪽의 현행 판도 확인한다", async t => {
  environment(t);
  const original = globalThis.fetch;
  const pages = [];
  const versions = Array.from({length: 102}, (_, i) => ({
    법령ID: "000123", 법령명한글: "시험법", 법령구분명: "법률", 법령일련번호: String(1000 + i),
    시행일자: i < 99 ? "20990101" : i < 101 ? "20190101" : "20100101",
    현행연혁코드: i < 99 ? "시행예정" : i === 100 ? "현행" : "연혁",
  }));
  t.mock.method(globalThis, "fetch", async input => {
    const url = new URL(input);
    if (!url.searchParams.has("LID")) return original(input);
    const page = Number(url.searchParams.get("page"));
    const size = Number(url.searchParams.get("display"));
    pages.push([page, size]);
    return Response.json({LawSearch: {totalCnt: versions.length, law: versions.slice((page - 1) * size, page * size)}});
  });
  const response = await getTool("article_get").invoke({lawId: "123", articles: ["제1조"], asOf: "2020-01-01"});
  assert.equal(response.law.mst, "1100");
  assert.equal(response.law.upcoming.length, 99);
  assert.deepEqual(pages, [[1, 100], [2, 100]]);
});
