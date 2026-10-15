// Bearer 토큰 검사 + 토큰별 레이트리밋. 토큰 값은 로그·응답 어디에도 쓰지 않는다 — 이름만.
// 토큰 목록: LAWMCP_TOKENS="name:token,…"(평문) 또는 LAWMCP_TOKENS_FILE(한 줄 `name sha256hex`, # 주석 — tools/token.js 가 만든다; 평문도 받는다).
// 파일은 5초마다 mtime 을 보고 다시 읽는다(폐기 즉시 반영). 새로 읽은 결과가 0개면 옛 목록을 유지한다.
import { readFileSync, statSync } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";

const env = (k, d) => (process.env[k] != null && process.env[k] !== "" ? process.env[k] : d);
const sha = (s) => createHash("sha256").update(s).digest("hex");
const HEX64 = /^[0-9a-f]{64}$/i;

/** @returns {Map<string,string>} sha256hex → name */
export function loadTokens({ list = env("LAWMCP_TOKENS", ""), file = env("LAWMCP_TOKENS_FILE", "") } = {}) {
  const out = new Map();
  const add = (name, token) => {
    if (!name || !token) return;
    if (HEX64.test(token)) out.set(token.toLowerCase(), name);
    else if (token.length >= 16) out.set(sha(token), name);
    else console.error(`[auth] 토큰 무시(16자 미만): ${name}`);
  };
  for (const pair of list.split(",")) { const i = pair.indexOf(":"); if (i > 0) add(pair.slice(0, i).trim(), pair.slice(i + 1).trim()); }
  if (file) {
    let text = ""; try { text = readFileSync(file, "utf8"); } catch (e) { throw new Error(`LAWMCP_TOKENS_FILE 을 읽을 수 없다: ${e.code || e.message}`); }
    for (const raw of text.split(/\r?\n/)) { const line = raw.trim(); if (!line || line.startsWith("#")) continue; const [name, token] = line.split(/\s+/); add(name, token); }
  }
  return out;
}

/** 토큰 저장소 — get() 이 파일 변경을 따라간다. */
export function createTokenStore({ file = env("LAWMCP_TOKENS_FILE", ""), list = env("LAWMCP_TOKENS", ""), everyMs = 5000 } = {}) {
  let tokens = loadTokens({ list, file }); let mtime = 0; let checked = 0;
  try { if (file) mtime = statSync(file).mtimeMs; } catch {}
  return {
    get() {
      if (!file) return tokens;
      const now = Date.now(); if (now - checked < everyMs) return tokens; checked = now;
      try {
        const m = statSync(file).mtimeMs; if (m === mtime) return tokens; mtime = m;
        const next = loadTokens({ list, file });
        if (next.size) tokens = next; else console.error("[auth] 다시 읽은 토큰이 0개 — 옛 목록 유지");
      } catch (e) { console.error(`[auth] 토큰 파일 다시 읽기 실패: ${e.code || e.message}`); }
      return tokens;
    },
    get size() { return tokens.size; },
  };
}

/** 요청의 Authorization: Bearer <token> 을 검사한다. @returns {string|null} 토큰 이름(없거나 틀리면 null) */
export function authenticate(req, tokens) {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || "");
  if (!m) return null;
  const digest = Buffer.from(sha(m[1]), "hex");
  for (const [hex, name] of tokens) if (timingSafeEqual(digest, Buffer.from(hex, "hex"))) return name;
  return null;
}

/** 토큰별 버킷(초당 r, 최대 b) + 일일 상한(UTC 날짜 — 자정 직후 첫 호출은 버스트 전부 사용 가능). Retry-After 는 최대 86400초. */
export function createLimiter({ ratePerSec = +env("LAWMCP_TOKEN_RATE_PER_SEC", 2) || 2, burst = +env("LAWMCP_TOKEN_BURST", 10) || 10, daily = +env("LAWMCP_TOKEN_DAILY", 2000) || 2000 } = {}) {
  const buckets = new Map(); // ponytail: 프로세스 내 Map — 인스턴스가 여럿이면 공유 저장소로
  return {
    settings: { ratePerSec, burst, daily },
    /** @returns {number} 0 이면 통과, 양수면 기다릴 초(429 Retry-After) */
    take(name, now = Date.now()) {
      const day = Math.floor(now / 86_400_000);
      let b = buckets.get(name);
      if (!b || b.day !== day) { b = { tokens: burst, last: now, day, count: 0 }; buckets.set(name, b); }
      b.tokens = Math.min(burst, b.tokens + ((now - b.last) / 1000) * ratePerSec); b.last = now;
      if (b.count >= daily) return Math.ceil(((day + 1) * 86_400_000 - now) / 1000);
      if (b.tokens < 1) return Math.ceil((1 - b.tokens) / ratePerSec);
      b.tokens -= 1; b.count += 1; return 0;
    },
    stats() { return Object.fromEntries([...buckets].map(([n, b]) => [n, { today: b.count }])); },
  };
}
