#!/usr/bin/env node
// 토큰 발급·폐기·목록. 파일: LAWMCP_TOKENS_FILE(기본 ~/.config/airealty-lawmcp/tokens.txt), 한 줄 `name sha256hex` — 평문 토큰은 파일에 남지 않는다.
// 발급된 토큰 값은 이 명령의 stdout 에 딱 한 번 찍힌다. 서버는 파일 mtime 을 5초마다 보고 다시 읽는다(재시작 불필요).
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes, createHash } from "node:crypto";

const file = process.env.LAWMCP_TOKENS_FILE || join(process.env.HOME || process.env.USERPROFILE || ".", ".config", "airealty-lawmcp", "tokens.txt");
const [cmd, name] = process.argv.slice(2);
const entries = (existsSync(file) ? readFileSync(file, "utf8").split(/\r?\n/) : []).map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((l) => l.split(/\s+/)).filter((r) => r.length >= 2);
const save = (rows) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file + ".tmp", "# name sha256(token)  — 평문 없음. 발급: node tools/token.js add <name>\n" + rows.map((r) => r.join(" ")).join("\n") + "\n"); renameSync(file + ".tmp", file); };

if (cmd === "add" && /^[a-z0-9_-]{1,32}$/i.test(name || "")) {
  if (entries.some(([n]) => n === name)) { console.error(`이미 있음: ${name} (revoke 먼저)`); process.exit(1); }
  const token = "lm_" + randomBytes(24).toString("base64url");
  save([...entries, [name, createHash("sha256").update(token).digest("hex")]]);
  console.log(`${name} 발급 — 아래 값을 사용자에게 한 번만 전달(다시 볼 수 없다):\n${token}\n\nclaude mcp add --transport http airealty-law "https://bhgijvaxxjnocgfnaaeu.supabase.co/functions/v1/airealty-lawmcp/mcp?forceFunctionRegion=ap-northeast-2" --header "Authorization: Bearer ${token}"`);
} else if (cmd === "revoke" && name) {
  if (!entries.some(([n]) => n === name)) { console.error(`없음: ${name}`); process.exit(1); }
  save(entries.filter(([n]) => n !== name)); console.log(`${name} 폐기 (서버가 5초 안에 반영)`);
} else if (cmd === "secret") {
  // Workers 시크릿 LAWMCP_TOKENS 값(name:sha256hex,…) — 화면에 찍지 말고 바로 넘긴다: node tools/token.js secret | npx wrangler secret put LAWMCP_TOKENS -c worker/wrangler.toml
  process.stdout.write(entries.map(([n, h]) => `${n}:${h}`).join(","));
} else if (cmd === "list") {
  console.log(entries.length ? entries.map(([n]) => n).join("\n") : "(없음)"); console.log(`파일: ${file}`);
} else {
  console.error("사용: node tools/token.js add <name> | revoke <name> | list | secret   (name: 영숫자·_·- 32자 이하)"); process.exit(2);
}
