// MCP 서버 인스턴스 — 요청마다 새로 만든다(HTTP 무상태). 등록 데이터는 레지스트리에서 미리 만들어 두어 생성 비용이 작다.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { TOOL_LIST, callTool } from "./registry.js";
import { SERVER_INFO } from "./server_info.js";
export { SERVER_INFO };

export function buildServer() {
  const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_LIST }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => callTool(req.params.name, req.params.arguments || {}));
  return server;
}
