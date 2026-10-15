// stdio 전송 — 줄 단위 JSON-RPC(MCP stdio 규약). SDK 의 Server 클래스는 시작에 ~200ms 가 들어(zod 타입 로드) cold start 예산(300ms)을
// 넘기므로, stdio 경로는 가벼운 자체 루프를 쓰고 도구 레지스트리는 initialize 응답 뒤에 지연 로드한다. HTTP 경로는 SDK 전송을 그대로 쓴다.
import { createInterface } from "node:readline";
import { SERVER_INFO } from "./server_info.js";

const SUPPORTED = ["2025-06-18", "2025-03-26", "2024-11-05"];
let registryP = null;
const registry = () => (registryP ||= import("./registry.js"));

export function startStdio({ input = process.stdin, output = process.stdout } = {}) {
  const send = (msg) => output.write(JSON.stringify(msg) + "\n");
  const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
  const error = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });
  const rl = createInterface({ input, crlfDelay: Infinity });
  rl.on("line", async (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return error(null, -32700, "Parse error"); }
    const batch = Array.isArray(msg) ? msg : [msg];
    for (const m of batch) {
      const id = m.id;
      try {
        if (m.method === "initialize") {
          const want = m.params?.protocolVersion;
          reply(id, { protocolVersion: SUPPORTED.includes(want) ? want : SUPPORTED[0], capabilities: { tools: {} }, serverInfo: SERVER_INFO });
          // 응답 뒤 백그라운드: 레지스트리 로드 → 색인·체계도 예열(LAWMCP_PREWARM=0 이면 안 함). initialize 전엔 네트워크 없음(§7.1)
          setTimeout(() => registry().then(() => import("./dictionary.js")).then((d) => d.ensureDictionary()).then(() => import("./prewarm.js")).then((m) => m.startPrewarm()).catch(() => {}), 0);
        } else if (m.method === "notifications/initialized" || (typeof m.method === "string" && m.method.startsWith("notifications/"))) {
          // 알림: 응답 없음
        } else if (m.method === "ping") reply(id, {});
        else if (m.method === "tools/list") { const { TOOL_LIST } = await registry(); reply(id, { tools: TOOL_LIST }); }
        else if (m.method === "tools/call") { const { callTool } = await registry(); reply(id, await callTool(m.params?.name, m.params?.arguments || {})); }
        else if (id !== undefined) error(id, -32601, `Method not found: ${m.method}`);
      } catch (e) { if (id !== undefined) error(id, -32603, "internal error"); }
    }
  });
  rl.on("close", () => process.exit(0));
}
