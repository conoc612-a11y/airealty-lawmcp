// 법제처 DRF 클라이언트 — 동시성 한도·토큰 버킷(선택: 파일 공유)·재시도·회로 차단기·in-flight 합치기·인증값 제거 (SPEC §6.2, §8).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { apiKey, scrub } from "./keys.js";
import { LawError } from "./errors.js";

export const BASE = process.env.LAWMCP_DRF_BASE || "http://www.law.go.kr/DRF/";
const env = (k, d) => (process.env[k] != null && process.env[k] !== "" ? process.env[k] : d);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const settings = {
  concurrency: clamp(+env("LAWMCP_CONCURRENCY", 4) || 4, 1, 8),
  ratePerSec: +env("LAWMCP_RATE_PER_SEC", 5) || 5,
  burst: +env("LAWMCP_BURST", 8) || 8,
  bucketFile: env("LAWMCP_BUCKET_FILE", ""),     // 지정하면 파일 기반 공유 버킷(수집기와 공용)
  retries: 3,
  backoffMs: +env("LAWMCP_BACKOFF_MS", 300) || 300,
  timeoutMs: 10_000,
  timeoutLongMs: 20_000,
  breakerFailures: 10, breakerWindowMs: 30_000, breakerOpenMs: 15_000,
};

// ── 토큰 버킷(프로세스 내) ──
const bucket = { tokens: settings.burst, last: Date.now() };
function takeTokenLocal(now) {
  const elapsed = (now - bucket.last) / 1000;
  bucket.tokens = Math.min(settings.burst, bucket.tokens + elapsed * settings.ratePerSec);
  bucket.last = now;
  if (bucket.tokens >= 1) { bucket.tokens -= 1; return 0; }
  return Math.ceil(((1 - bucket.tokens) / settings.ratePerSec) * 1000);
}
// ── 파일 공유 버킷(선택): 파일에 {tokens,last} 를 두고 읽기-수정-쓰기. 경합은 드물고 보수적으로 동작한다. ──
function takeTokenFile(now) {
  const f = settings.bucketFile;
  let st = { tokens: settings.burst, last: now };
  try { st = JSON.parse(readFileSync(f, "utf8")); } catch { try { mkdirSync(dirname(f), { recursive: true }); } catch {} }
  const elapsed = Math.max(0, (now - (st.last || now)) / 1000);
  let tokens = Math.min(settings.burst, (st.tokens ?? settings.burst) + elapsed * settings.ratePerSec);
  let wait = 0;
  if (tokens >= 1) tokens -= 1; else wait = Math.ceil(((1 - tokens) / settings.ratePerSec) * 1000);
  try { writeFileSync(f, JSON.stringify({ tokens, last: now })); } catch {}
  return wait;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 버킷을 소비하지 않고 남은 토큰을 어림한다(백그라운드 양보 판단용). */
function peekTokens(now) {
  if (settings.bucketFile) {
    let st = null; try { st = JSON.parse(readFileSync(settings.bucketFile, "utf8")); } catch { return settings.burst; }
    return Math.min(settings.burst, (st.tokens ?? settings.burst) + Math.max(0, (now - (st.last || now)) / 1000) * settings.ratePerSec);
  }
  return Math.min(settings.burst, bucket.tokens + ((now - bucket.last) / 1000) * settings.ratePerSec);
}
// ── 백그라운드 양보: 사용자(전경) 요청이 하나라도 진행·대기 중이거나 버킷 여유가 2 토큰 미만이면 기다린다 ──
let foreground = 0;
const promoted = new Set(); // 전경 요청이 합류한 백그라운드 in-flight 키 — 더 기다리지 않는다
export const BACKGROUND_HEADROOM = 2;
async function backgroundGate(key) {
  for (;;) {
    if (promoted.has(key) || (foreground === 0 && peekTokens(Date.now()) >= BACKGROUND_HEADROOM)) return;
    await sleep(100);
  }
}
async function acquireToken() {
  for (;;) {
    const wait = settings.bucketFile ? takeTokenFile(Date.now()) : takeTokenLocal(Date.now());
    if (wait <= 0) return;
    await sleep(wait);
  }
}

// ── 동시성 한도 ──
let active = 0; const waiters = [];
async function acquireSlot() {
  if (active < settings.concurrency) { active++; return; }
  await new Promise((r) => waiters.push(r)); active++;
}
function releaseSlot() { active--; const w = waiters.shift(); if (w) w(); }

// ── 회로 차단기 ──
const breaker = { failures: [], openUntil: 0 };
function breakerCheck() {
  if (breaker.openUntil > Date.now()) throw new LawError("UPSTREAM_UNAVAILABLE", "업스트림 연속 실패로 잠시 차단 중", { hint: "15초 뒤 다시 시도" });
}
function breakerFail() {
  const now = Date.now();
  breaker.failures = breaker.failures.filter((t) => now - t < settings.breakerWindowMs);
  breaker.failures.push(now);
  if (breaker.failures.length >= settings.breakerFailures) { breaker.openUntil = now + settings.breakerOpenMs; breaker.failures = []; }
}
function breakerOk() { breaker.failures = []; }
export function breakerState() { return breaker.openUntil > Date.now() ? "open" : "closed"; }

// ── 통계·in-flight ──
export const stats = { requests: 0, retries: 0, errors: 0, upstreamMs: 0 };
const inflight = new Map();

/** 인증값을 뺀 요청 식별 문자열(캐시 키·로그용). */
export function requestKey(path, params) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== "").map(([k, v]) => [k, String(v)]));
  qs.sort();
  return `${path}?${qs}`;
}

/** 업스트림 응답 판정: HTML/빈 응답 → UPSTREAM_FORMAT(재시도), {result,msg} 래퍼 → UPSTREAM_AUTH(무재시도). */
export function classifyBody(status, text) {
  if (status === 429) return new LawError("RATE_LIMITED", "업스트림 요청 한도 초과");
  if (status >= 500) return new LawError("UPSTREAM_UNAVAILABLE", `업스트림 HTTP ${status}`);
  if (status !== 200) return new LawError("UPSTREAM_UNAVAILABLE", `업스트림 HTTP ${status}`, { retryable: false });
  const t = text.trimStart();
  if (!t) return new LawError("UPSTREAM_FORMAT", "업스트림 빈 응답");
  if (t[0] !== "{" && t[0] !== "[") return new LawError("UPSTREAM_FORMAT", "업스트림이 JSON 이 아닌 안내 페이지를 돌려줌");
  let data;
  try { data = JSON.parse(t); } catch { return new LawError("UPSTREAM_FORMAT", "업스트림 JSON 파싱 실패"); }
  if (data && typeof data === "object" && !Array.isArray(data) && "result" in data && "msg" in data && Object.keys(data).length <= 3) {
    return new LawError("UPSTREAM_AUTH", "업스트림 인증 실패 — 서버 설정(인증값·등록 IP)부터 점검", { retryable: false });
  }
  return data;
}

/**
 * DRF 호출. path: "lawSearch.do"|"lawService.do". 응답 JSON(인증값 제거됨)을 돌려준다.
 * opts.long: 20초 타임아웃(체계도·대형 본문). opts.background: 예열·갱신용 — 전경 요청에 양보하고 버킷 여유가 있을 때만 나간다.
 */
export async function call(path, params, opts = {}) {
  const key = requestKey(path, params);
  if (inflight.has(key)) { if (!opts.background) promoted.add(key); return inflight.get(key); }
  if (!opts.background) foreground++;
  const p = doCall(path, params, key, opts).finally(() => { inflight.delete(key); promoted.delete(key); if (!opts.background) foreground--; });
  inflight.set(key, p);
  return p;
}

async function doCall(path, params, key, opts) {
  const oc = apiKey();
  if (!oc) throw new LawError("UPSTREAM_AUTH", "서버 설정: 인증값 없음(openlaw_API_KEY)", { retryable: false });
  breakerCheck();
  const timeout = opts.long ? settings.timeoutLongMs : settings.timeoutMs;
  let lastErr;
  for (let attempt = 0; attempt <= settings.retries; attempt++) {
    if (attempt) { stats.retries++; const base = lastErr?.code === "RATE_LIMITED" ? 2000 : settings.backoffMs * 2 ** (attempt - 1); await sleep(base + Math.random() * base * 0.3); }
    if (opts.background) { await backgroundGate(key); breakerCheck(); }
    await acquireSlot();
    try {
      await acquireToken();
      const qs = new URLSearchParams({ OC: oc, type: "JSON" });
      for (const [k, v] of Object.entries(params)) if (v != null && v !== "") qs.set(k, String(v));
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeout);
      const t0 = Date.now();
      let res, text;
      try {
        res = await fetch(`${BASE}${path}?${qs}`, { signal: ctrl.signal, headers: { "User-Agent": "airealty-lawmcp/0.1" } });
        text = await res.text();
      } finally { clearTimeout(timer); stats.upstreamMs += Date.now() - t0; stats.requests++; }
      const out = classifyBody(res.status, scrub(text));
      if (out instanceof LawError) throw out;
      breakerOk();
      return out;
    } catch (e) {
      lastErr = e instanceof LawError ? e : (e?.name === "AbortError" ? new LawError("TIMEOUT", "업스트림 응답 시간 초과") : new LawError("UPSTREAM_UNAVAILABLE", "업스트림 네트워크 오류"));
      stats.errors++;
      if (lastErr.code !== "UPSTREAM_AUTH") breakerFail();
      if (!lastErr.retryable) break;
    } finally { releaseSlot(); }
  }
  throw lastErr;
}

/** 테스트용 교체 지점: fetch 를 바꿔 끼운다(모의 업스트림). */
export const _test = { reset() { breaker.failures = []; breaker.openUntil = 0; bucket.tokens = settings.burst; bucket.last = Date.now(); inflight.clear(); foreground = 0; }, settings, foregroundCount: () => foreground, peekTokens };
