// 원본에서 도출한 조문 묶음·목차·별표는 원본과 같은 만료 시각을 사용한다.
import { cache } from "./cache.js";
import { createHash } from "node:crypto";
import { requestKey } from "./drf.js";
import { getDocumentStore, search } from "./upstream.js";

export async function readPrepared(key, accepts, fallbackKey) {
  const local = cache.get(key);
  if (local !== undefined) return local;
  const row = await getDocumentStore()?.get(key, fallbackKey);
  const now = Date.now();
  if (!row || row.expiresAt <= now || !accepts(row.data)) return undefined;
  cache.set(key, row.data, row.expiresAt - now, now);
  return row.data;
}

export async function writePrepared(key, value, started, expiresAt) {
  const now = Date.now();
  if (!(expiresAt > now)) return;
  cache.set(key, value, expiresAt - now, now);
  await getDocumentStore()?.put(key, value, started, expiresAt);
}


/** 공유 목록에는 공개 필드만 넣고, 검색문과 필터는 해시로만 식별한다. */
export async function publicSearchRows(kind, target, params, rowKeys, formatRow) {
  const store = getDocumentStore();
  const started = Date.now();
  let key;
  if (store) {
    const hash = createHash("sha256").update(requestKey(target, params)).digest("hex");
    key = "public-list:v1:" + kind + ":" + hash;
    const saved = await readPrepared(key, value => Array.isArray(value?.items) && Number.isInteger(value.total));
    if (saved) return { items: structuredClone(saved.items), total: saved.total, hit: true, stale: false };
  }
  const result = await search(target, params, { rowKeys });
  const items = result.rows.map(formatRow);
  if (store && items.length && !result.stale) {
    await writePrepared(key, { items: structuredClone(items), total: result.total }, started, result.expiresAt);
  }
  return { items, total: result.total, hit: result.hit, stale: result.stale };
}
