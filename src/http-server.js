// Streamable HTTP 서버 — 무상태 요청 단위: POST 마다 새 서버 + 새 전송, 응답 뒤 둘 다 닫는다 (SPEC §7.2).
// GET/DELETE /mcp → 405, 그 밖의 경로 404, /healthz, 본문 1MB 상한, Origin 검사, 종료 신호 시 진행 중 요청 마무리.
// 공개 호스팅(LAWMCP_HOST 가 루프백이 아님)에서는 Bearer 토큰 필수(src/auth.js) + 토큰별 레이트리밋(tools/call 만 센다).
import http from "node:http";
import { pathToFileURL } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer, SERVER_INFO } from "./server.js";
import { cache } from "./cache.js";
import { breakerState, stats } from "./drf.js";
import { keyInfo } from "./keys.js";
import { TOOL_LIST_BYTES } from "./registry.js";
import { startPrewarm, prewarmState } from "./prewarm.js";
import { ensureDictionary } from "./dictionary.js";
import { createTokenStore, authenticate, createLimiter } from "./auth.js";

const MAX_BODY = 1024 * 1024;
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|::1|\[::1\])$/i;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0; let tooLarge = false;
    req.on("data", (c) => { size += c.length; if (tooLarge) return; if (size > MAX_BODY) { tooLarge = true; chunks.length = 0; return; } chunks.push(c); });
    req.on("end", () => (tooLarge ? reject(Object.assign(new Error("payload too large"), { status: 413 })) : resolve(Buffer.concat(chunks).toString("utf8"))));
    req.on("error", reject);
  });
}

/**
 * @param {object} [opts]
 * @param {{get():Map<string,string>, size:number}} [opts.tokens] 토큰 저장소(sha256hex → 이름). 비어 있으면 인증 없음 — 루프백 전용. 프록시 헤더(cf-connecting-ip·x-forwarded-for)가 붙은 요청은 그래도 401.
 * @param {string[]} [opts.allowedOrigins] 브라우저 Origin 허용 목록(LAWMCP_ALLOWED_ORIGINS, 쉼표). 로컬 Origin 은 항상 허용.
 */
export function createHttpServer({ tokens = createTokenStore(), allowedOrigins = (process.env.LAWMCP_ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean), limiter = createLimiter() } = {}) {
  const authOn = tokens.size > 0;
  const json = (res, status, body, headers = {}) => { res.writeHead(status, { "Content-Type": "application/json", ...headers }); res.end(JSON.stringify(body)); };
  let inflight = 0;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    const origin = req.headers.origin;
    const originOk = !origin || LOCAL_ORIGIN.test(origin) || allowedOrigins.includes(origin);
    if (!originOk) return json(res, 403, { error: "forbidden origin" });
    if (origin) { res.setHeader("Access-Control-Allow-Origin", origin); res.setHeader("Vary", "Origin"); res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id"); res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS"); res.setHeader("Access-Control-Expose-Headers", "Retry-After, WWW-Authenticate, Mcp-Session-Id"); res.setHeader("Access-Control-Max-Age", "600"); }
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
    const proxied = !!(req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"]);
    if (url.pathname === "/healthz" && req.method === "GET") {
      const k = keyInfo();
      if (!(authOn ? authenticate(req, tokens.get()) : !proxied)) return json(res, 200, { ok: true, version: SERVER_INFO.version });
      return json(res, 200, { ok: true, version: SERVER_INFO.version, cache: cache.stats(), upstream: { breaker: breakerState(), requests: stats.requests, errors: stats.errors }, key: { name: k.name, length: k.length }, auth: { required: authOn, tokens: tokens.size, limit: limiter.settings }, toolsListBytes: TOOL_LIST_BYTES, prewarm: { state: prewarmState.state, done: prewarmState.done, total: prewarmState.total, index: prewarmState.index, hierarchy: prewarmState.hierarchy } });
    }
    if (url.pathname !== "/mcp") return json(res, 404, { error: "not found" });
    if (req.method !== "POST") return json(res, 405, { error: "stateless server: POST only" }, { Allow: "POST" });
    let who = null;
    if (authOn || proxied) {
      who = authOn ? authenticate(req, tokens.get()) : null;
      if (!who) return json(res, 401, { error: "unauthorized: Authorization: Bearer <token> 필요" }, { "WWW-Authenticate": 'Bearer realm="airealty-lawmcp"' });
    }
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, e.status || 400, { error: e.message }, { Connection: "close" }); }
    let parsed;
    try { parsed = JSON.parse(body); } catch { return json(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }); }
    if (Array.isArray(parsed)) return json(res, 400, { jsonrpc: "2.0", error: { code: -32600, message: "batch not supported" }, id: null });
    if (who && parsed?.method === "tools/call") {
      const wait = limiter.take(who);
      if (wait > 0) { if (process.env.LAWMCP_DEBUG) console.error(`[auth] ${who} rate limited ${wait}s`); return json(res, 429, { jsonrpc: "2.0", error: { code: -32000, message: `rate limited: ${wait}초 뒤 다시` }, id: parsed.id ?? null }, { "Retry-After": String(wait) }); }
    }
    inflight++;
    const mcp = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res, parsed);
    } catch (e) {
      if (!res.headersSent) json(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: "internal error" }, id: null });
    } finally {
      res.on("close", () => { transport.close().catch(() => {}); mcp.close().catch(() => {}); });
      if (res.writableEnded) { transport.close().catch(() => {}); mcp.close().catch(() => {}); }
      inflight--;
    }
  });
  server.inflightCount = () => inflight;
  server.authRequired = authOn;
  return server;
}

export function startHttp({ port = Number(process.env.LAWMCP_PORT || process.env.PORT) || 3457, host = process.env.LAWMCP_HOST || "127.0.0.1" } = {}) {
  const server = createHttpServer();
  const mustAuth = !LOOPBACK_HOST.test(host) || process.env.LAWMCP_REQUIRE_AUTH === "1" || !!(process.env.LAWMCP_TOKENS || process.env.LAWMCP_TOKENS_FILE);
  if (mustAuth && !server.authRequired) { console.error(`airealty-lawmcp: 유효한 토큰이 0개 — LAWMCP_TOKENS_FILE 또는 LAWMCP_TOKENS 에 토큰을 넣어라(node tools/token.js add <name>)`); process.exit(2); }
  server.listen(port, host, () => { const k = keyInfo(); console.error(`airealty-lawmcp http listening ${host}:${port} · auth ${server.authRequired ? "bearer" : "off"} · tools/list ${TOOL_LIST_BYTES}B · key ${k.name} len ${k.length}`); ensureDictionary().catch(() => {}); startPrewarm().catch(() => {}); });
  const shutdown = () => {
    server.close(() => process.exit(0));
    const t0 = Date.now();
    const tick = setInterval(() => { if (server.inflightCount() === 0 || Date.now() - t0 > 5000) { clearInterval(tick); process.exit(0); } }, 100);
  };
  process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startHttp();
