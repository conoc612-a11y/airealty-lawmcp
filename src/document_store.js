// 서울 리전의 비공개 PostgREST 테이블. 프로세스 내 LRU에서 빠진 공식 문서만 읽는다.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

const MAX_BYTES = 128 * 1024;
export function createDocumentStore({ url, secret, table = "lawmcp_document_cache" }, request = fetch) {
  if (!url || !secret || !/^[a-z][a-z0-9_]{0,47}$/.test(table)) return null;
  if (!URL.canParse(url)) return null;
  const origin = new URL(url);
  if (origin.protocol !== "https:") return null;
  const base = origin.origin + "/rest/v1/";
  const headers = { apikey: secret, Authorization: "Bearer " + secret, "Content-Type": "application/json" };
  const stats = { hits: 0, misses: 0, writes: 0, errors: 0 };
  const requests = new AsyncLocalStorage();
  let orderedLookup = true;
  function identify(key) {
    const hash = createHash("sha256").update("document-v1:" + key).digest("hex");
    return { hash, slot: parseInt(hash.slice(0, 8), 16) % 1024 };
  }
  async function persist(key, data, savedAt, expiresAt) {
    if (expiresAt <= Date.now()) return;
    const doc = JSON.stringify(data);
    if (Buffer.byteLength(doc) > MAX_BYTES) return;
    const { slot, hash } = identify(key);
    try {
      const response = await request(base + "rpc/" + table + "_put", {
        method: "POST", headers, redirect: "error", signal: AbortSignal.timeout(1000),
        body: JSON.stringify({ p_slot: slot, p_hash: hash, p_saved: savedAt, p_expires: expiresAt, p_doc: data }),
      });
      if (!response.ok) throw new Error("cache write");
      stats.writes++;
    } catch { stats.errors++; }
  }
  return {
    stats,
    async get(key, fallbackKeys) {
      const hints = requests.getStore()?.hints;
      if (hints?.has(key)) {
        const hint = hints.get(key);
        if (!hint || hint.expiresAt > Date.now()) {
          if (hint) stats.hits++; else stats.misses++;
          return hint;
        }
        hints.delete(key);
      }
      const keys = [key];
      if (hints && orderedLookup && fallbackKeys) {
        for (const candidate of [fallbackKeys].flat()) {
          if (candidate && !keys.includes(candidate) && keys.length < 3) keys.push(candidate);
        }
      }
      const ids = keys.map(identify);
      const combined = keys.length > 1;
      const query = combined ? new URLSearchParams({
        p_slots: "{" + ids.map(id => id.slot).join(",") + "}",
        p_hashes: "{" + ids.map(id => id.hash).join(",") + "}",
      }) : new URLSearchParams({ slot: "eq." + ids[0].slot, hash: "eq." + ids[0].hash,
        expires_at: "gt." + Date.now(), select: "expires_at,doc" });
      const path = combined ? "rpc/" + table + "_first" : table;
      try {
        const response = await request(base + path + "?" + query, { headers, redirect: "error", signal: AbortSignal.timeout(800) });
        if (combined && response.status === 404) {
          // SQL을 갱신하기 전 설치에서도 기존 단일 행 조회로 동작한다.
          orderedLookup = false;
          return this.get(key);
        }
        if (!response.ok) throw new Error("cache read");
        const [entry] = await response.json();
        const row = entry && Number.isSafeInteger(entry.expires_at) && entry.expires_at > Date.now()
          ? { data: entry.doc, expiresAt: entry.expires_at } : null;
        const index = combined && entry ? ids.findIndex(id => id.hash === entry.hash) : 0;
        if (row && index === 0) {
          stats.hits++;
          return row;
        }
        if (combined && (!entry || index > 0)) {
          const last = entry ? index : keys.length - 1;
          for (let i = 1; i <= last; i++) hints.set(keys[i], entry && i === index ? row : null);
        }
        stats.misses++;
      } catch { stats.errors++; }
      return null;
    },
    // 서로 독립인 저장과 다음 원본 조회를 겹친다. 응답 직전에는 이 요청의 저장을 모두 기다린다.
    async duringRequest(run) {
      const state = { writes: [], hints: new Map(), closed: false };
      try {
        return await requests.run(state, run);
      } finally {
        state.closed = true;
        await Promise.allSettled(state.writes);
      }
    },
    put(key, data, savedAt, expiresAt) {
      const write = persist(key, data, savedAt, expiresAt);
      const state = requests.getStore();
      if (!state || state.closed) return write;
      state.hints.delete(key);
      state.writes.push(write);
    },
  };
}

export function documentKind(path, p) {
  const numeric = value => /^\d{1,12}$/.test(value ?? "");
  if (path === "lawService.do") {
    if (p.target === "prec" && numeric(p.ID)) return "judgment";
    if ((p.target === "eflaw" || p.target === "law") && numeric(p.JO) && (numeric(p.ID) || numeric(p.MST))) return "article";
  }
  if (path === "lawSearch.do" && p.target === "eflaw" && numeric(p.LID) && !p.query) return "versions";
  if (path === "lawSearch.do" && p.target === "prec" && /^\d{2,4}[가-힣]{1,5}\d{1,12}$/.test(p.nb ?? "") && !p.query) return "docket";
  return null;
}

export function isDocument(kind, data) {
  if (kind === "judgment") return !!data?.PrecService?.["판례정보일련번호"];
  if (kind === "article") return !!data?.["법령"]?.["기본정보"] && !!data["법령"]["조문"];
  if (kind === "docket") return !!data?.PrecSearch?.prec && Number(data.PrecSearch.totalCnt) > 0;
  return kind === "versions" && !!data?.LawSearch?.law && Number(data.LawSearch.totalCnt) > 0;
}
