import test from "node:test";
import assert from "node:assert/strict";
import { cache, TTL } from "../src/cache.js";
import { setDocumentStore, cached } from "../src/upstream.js";
import { createDocumentStore, documentKind, isDocument } from "../src/document_store.js";
import { _test as drf } from "../src/drf.js";
import { _setApiKey } from "../src/keys.js";

function setup(t, storageFetch) {
  drf.reset();
  cache.clear();
  _setApiKey("only-fixture-credential");
  const store = createDocumentStore({ url: "https://cache.example", secret: "fixture" }, storageFetch);
  setDocumentStore(store);
  t.after(() => { setDocumentStore(null); cache.clear(); _setApiKey(null); });
  return store;
}
const judgment = { PrecService: { 판례정보일련번호: "12345", 판례내용: "판결 전문" } };
const article = { 법령: { 기본정보: { 법령ID: "1" }, 조문: { 조문단위: { 조문번호: "2" } } } };

test("새 인스턴스에서도 같은 판결을 읽고 만료된 공유 항목은 다시 조회한다", async t => {
  let saved, reads = 0, writes = 0, upstream = 0;
  setup(t, async (url, opts) => {
    assert.equal(opts.redirect, "error");
    if (opts.method === "POST") { saved = JSON.parse(opts.body); writes++; return new Response(null, { status: 204 }); }
    reads++;
    assert.ok(!url.includes("12345") && !url.includes("only-fixture"));
    return Response.json(saved ? [{ expires_at: saved.p_expires, doc: saved.p_doc }] : []);
  });
  t.mock.method(globalThis, "fetch", async () => { upstream++; return Response.json(judgment); });
  const get = () => cached("lawService.do", { target: "prec", ID: "12345" }, TTL.sourceBody);
  const [first, same] = await Promise.all([get(), get()]);
  assert.deepEqual(first.data, same.data);
  assert.equal(writes, 1);
  cache.clear();
  assert.deepEqual(await get(), { data: judgment, hit: true });
  assert.equal((await get()).hit, true);
  assert.deepEqual([reads, writes, upstream], [2, 1, 1]);
  cache.clear(); saved.p_expires = Date.now() - 1;
  assert.equal((await get()).hit, false);
  assert.equal(upstream, 2);
});

test("현행 법령 ID는 한국 자정을 넘겨 저장하지 않고 판·조문별 공유 키가 다르다", async t => {
  const saved = [];
  setup(t, async (_url, opts) => {
    if (opts.method === "POST") { saved.push(JSON.parse(opts.body)); return new Response(null, { status: 204 }); }
    return Response.json([]);
  });
  const now = Date.parse("2026-11-24T14:59:59Z");
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "fetch", async () => Response.json(article));
  for (const params of [{ ID: "123", JO: "000200" }, { MST: "123", efYd: "20240101", JO: "000200" }, { MST: "123", efYd: "20190101", JO: "000200" }]) {
    await cached("lawService.do", { target: "eflaw", ...params }, TTL.body);
  }
  assert.equal(saved[0].p_expires, now + 1000);
  assert.equal(saved[1].p_expires, now + TTL.body);
  assert.equal(new Set(saved.map(x => x.p_hash)).size, 3);
});

test("문서 캐시 장애는 원천 조회를 막지 않고 일반 쟁점·빈 본문은 저장하지 않는다", async t => {
  const store = setup(t, async () => { throw new Error("unavailable"); });
  t.mock.method(globalThis, "fetch", async () => Response.json(judgment));
  const r = await cached("lawService.do", { target: "prec", ID: "4" }, TTL.sourceBody);
  assert.equal(r.data.PrecService.판례내용, "판결 전문");
  assert.equal(store.stats.errors, 2);
  assert.equal(documentKind("lawSearch.do", { target: "prec", query: "임의의 문장" }), null);
  assert.equal(documentKind("lawSearch.do", { target: "prec", nb: "2025다220329" }), "docket");
  assert.equal(isDocument("judgment", { PrecService: {} }), false);
  assert.equal(isDocument("versions", { LawSearch: { totalCnt: 0 } }), false);
});


test("동시 요청의 캐시 저장을 분리하고 해당 요청의 저장 완료 후 응답한다", async () => {
  const pending = new Map();
  const fakeFetch = async (_url, opts) => {
    const { p_doc } = JSON.parse(opts.body);
    return new Promise(resolve => pending.set(p_doc.id, () => resolve(new Response(null, {status: 204}))));
  };
  const store = createDocumentStore({ url: "https://cache.example", secret: "fixture" }, fakeFetch);
  const finished = [];
  function run(id) {
    return store.duringRequest(async () => {
      await store.put(id, { id }, Date.now(), Date.now() + 60000);
      finished.push("read-" + id);
      return id;
    }).then(result => finished.push("done-" + result));
  }
  const a = run("a"), b = run("b");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(finished, ["read-a", "read-b"]);
  pending.get("b")();
  await b;
  assert.deepEqual(finished, ["read-a", "read-b", "done-b"]);
  pending.get("a")();
  await a;
  assert.deepEqual(finished, ["read-a", "read-b", "done-b", "done-a"]);
});

test("문서와 대체 문서를 함께 확인하고 최고 우선순위 한 행만 읽는다", async () => {
  const saved = new Map();
  const queries = [];
  const store = createDocumentStore({ url: "https://cache.example", secret: "fixture" }, async (url, opts) => {
    if (opts.method === "POST") {
      const { p_slot: slot, p_hash: hash, p_expires: expires_at, p_doc: doc } = JSON.parse(opts.body);
      saved.set(slot, { slot, hash, expires_at, doc });
      return new Response(null, { status: 204 });
    }
    const query = new URL(url).searchParams;
    queries.push(query);
    const hashes = query.has("p_hashes") ? query.get("p_hashes").slice(1, -1).split(",") : [query.get("hash").slice(3)];
    const matches = [...saved.values()].filter(row => hashes.includes(row.hash) && row.expires_at > Date.now());
    matches.sort((a, b) => hashes.indexOf(a.hash) - hashes.indexOf(b.hash));
    return Response.json(matches.slice(0, 1));
  });
  const expiry = Date.now() + 60000;
  const save = key => store.put(key, { key }, Date.now(), expiry);
  await save("b");
  await store.duringRequest(async () => {
    assert.equal(await store.get("a", ["c", "b"]), null);
    assert.equal(await store.get("c"), null);
    assert.deepEqual(await store.get("b"), { data: { key: "b" }, expiresAt: expiry });
    assert.equal(queries.length, 1);
    assert.equal(queries[0].get("p_slots").slice(1, -1).split(",").length, 3);
  });
  await save("a");
  await store.duringRequest(async () => {
    assert.equal((await store.get("a", "b")).data.key, "a");
    assert.equal((await store.get("b", "a")).data.key, "b");
    assert.equal(await store.get("missing", "alsoMissing"), null);
    assert.equal(await store.get("alsoMissing"), null);
    assert.equal(queries.length, 4);
  });
  await store.get("alsoMissing");
  assert.equal(queries.length, 5);
});


test("이전 캐시 스키마에서는 한 번 확인한 뒤 단일 행 조회를 사용한다", async () => {
  const routes = [];
  const store = createDocumentStore({ url: "https://cache.example", secret: "fixture" }, async url => {
    const path = new URL(url).pathname;
    routes.push(path);
    return path.includes("/rpc/") ? new Response(null, {status: 404}) : Response.json([]);
  });
  await store.duringRequest(async () => {
    assert.equal(await store.get("a", ["b", "c"]), null);
    assert.equal(await store.get("d", ["b", "c"]), null);
  });
  assert.equal(routes.length, 3);
  assert.equal(routes.filter(path => path.includes("/rpc/")).length, 1);
});
