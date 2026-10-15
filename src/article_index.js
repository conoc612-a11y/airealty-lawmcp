// 법령별 조문 번호 색인 — 조 번호·가지번호·삭제 여부·마지막 조. 전체 본문(약 1MB)을 한 번 읽어 만들고 디스크에 24시간 둔다(키 없음).
// 없는 조문의 validRange·nearest 는 이 색인으로 답해 전체 본문 왕복을 없앤다. 만료 뒤엔 옛 색인을 먼저 쓰고 뒤에서 다시 만든다(stale-while-revalidate).
import { call } from "./drf.js";
import { service, digits, str } from "./upstream.js";
import { TTL } from "./cache.js";
import { articleUnits, lawMetaFromBody } from "./articles.js";
import { articleLabel } from "./jo.js";
import { readDisk, writeDisk } from "./diskcache.js";

export const INDEX_TTL = 24 * 3600 * 1000;
const BUCKET = "article_index";
const VERSION = 1;
const mem = new Map();      // key → {index, savedAt}
const building = new Map(); // key → Promise

export function indexKey({ lawId, mst, efYd }) { return `${lawId || "x"}_${mst || "cur"}_${digits(efYd) || "cur"}`; }

/** 전체 본문 → 색인. articles 는 [조, 가지, 삭제(1)] 의 배열(크기 절약). */
export function buildIndex(body, { lawId, mst, efYd } = {}) {
  const units = articleUnits(body);
  const meta = lawMetaFromBody(body);
  const articles = [];
  for (const u of units) {
    const a = parseInt(digits(u["조문번호"]), 10); if (!Number.isFinite(a)) continue;
    const b = parseInt(digits(u["조문가지번호"]) || "0", 10) || 0;
    const deleted = /^제\d+조(?:의\d+)?\s*삭제/.test(str(u["조문내용"]));
    articles.push(deleted ? [a, b, 1] : [a, b]);
  }
  const last = articles.length ? Math.max(...articles.map((x) => x[0])) : 0;
  return { v: VERSION, lawId: lawId || meta.lawId, mst: mst || "", efYd: digits(efYd) || digits(meta.effectiveDate), name: meta.name, builtAt: Date.now(), count: articles.length, last, articles };
}

export function lookup(index, ref) {
  if (!index || !ref) return null;
  const hit = index.articles.find((x) => x[0] === ref.article && x[1] === (ref.branch || 0));
  return hit ? { article: hit[0], branch: hit[1], deleted: !!hit[2] } : null;
}

/** 없는 조문 안내용: {validRange, all:[{a,b}]} — articles.validRange 와 같은 모양. */
export function rangeOf(index) {
  if (!index || !index.articles.length) return { validRange: null, all: [] };
  return { validRange: `제1조~제${index.last}조`, all: index.articles.map((x) => ({ a: x[0], b: x[1] })) };
}

async function fetchBody(access, { background }) {
  const params = access.useId ? { ID: access.lawId } : { MST: access.mst, efYd: access.efYd };
  if (background) return { body: await call("lawService.do", { target: "eflaw", ...params }, { long: true, background: true }), hit: false };
  const { data, hit } = await service("eflaw", params, { ttl: TTL.body, long: true });
  return { body: data, hit };
}

/**
 * 색인 얻기. 순서: 메모리 → 디스크(신선) → 디스크(만료: 돌려주고 뒤에서 갱신) → 새로 만들기(allowBuild).
 * 반환 {index, source:"mem"|"disk"|"stale"|"built"|null, hit}. background=true 면 업스트림 호출이 사용자 요청에 양보한다.
 */
export async function getArticleIndex(access, ver = {}, { allowBuild = true, background = false, now = Date.now() } = {}) {
  const key = indexKey({ lawId: access.lawId, mst: ver.mst ?? access.mst, efYd: ver.efYd ?? access.efYd });
  const m = mem.get(key);
  if (m && now - m.savedAt < INDEX_TTL) return { index: m.index, source: "mem", hit: true };
  const d = readDisk(BUCKET, key, now);
  if (d && d.value?.v === VERSION) {
    mem.set(key, { index: d.value, savedAt: d.savedAt });
    if (d.ageMs < INDEX_TTL) return { index: d.value, source: "disk", hit: true };
    if (allowBuild) rebuild(key, access, ver, { background: true }).catch(() => {});
    return { index: d.value, source: "stale", hit: true };
  }
  if (!allowBuild) return { index: null, source: null, hit: false };
  return rebuild(key, access, ver, { background });
}

function rebuild(key, access, ver, { background }) {
  if (building.has(key)) return building.get(key);
  const p = (async () => {
    const { body, hit } = await fetchBody(access, { background });
    const index = buildIndex(body, { lawId: access.lawId, mst: ver.mst ?? access.mst, efYd: ver.efYd ?? access.efYd });
    const savedAt = Date.now();
    mem.set(key, { index, savedAt });
    writeDisk(BUCKET, key, index, savedAt);
    return { index, source: "built", hit };
  })().finally(() => building.delete(key));
  building.set(key, p);
  return p;
}

/** 디스크에 신선한 색인이 있는가(예열이 건너뛸지 판단). */
export function hasFreshIndex(access, ver = {}, now = Date.now()) {
  const d = readDisk(BUCKET, indexKey({ lawId: access.lawId, mst: ver.mst ?? access.mst, efYd: ver.efYd ?? access.efYd }), now);
  return !!(d && d.value?.v === VERSION && d.ageMs < INDEX_TTL);
}

export function nearestFromIndex(index, ref, k = 3) {
  return rangeOf(index).all.map((n) => ({ n, d: Math.abs(n.a - ref.article) + (n.b ? 0.5 : 0) })).sort((x, y) => x.d - y.d).slice(0, k).map(({ n }) => articleLabel(n.a, n.b));
}

export const _test = { mem, clear() { mem.clear(); building.clear(); } };
