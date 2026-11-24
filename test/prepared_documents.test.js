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

import { listVersions } from "../src/versions.js";

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
