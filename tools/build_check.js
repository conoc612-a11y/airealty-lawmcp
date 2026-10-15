#!/usr/bin/env node
// 빌드 검사: tools/list ≤ 13KB, 코어 ≤ 12, 이름 충돌(이전 서버 104개 이름) 0, 카탈로그 12, 설명·스키마 존재.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { CORE_TOOLS, CATALOG_TOOLS, TOOL_LIST, TOOL_LIST_BYTES } from "../src/registry.js";

const here = dirname(fileURLToPath(import.meta.url));
const failures = [];
const check = (cond, msg) => { if (!cond) failures.push(msg); };

check(CORE_TOOLS.length <= 12, `코어 도구 ${CORE_TOOLS.length}개 > 12`);
check(TOOL_LIST_BYTES <= 13 * 1024, `tools/list ${TOOL_LIST_BYTES}B > 13KB`);
check(CATALOG_TOOLS.length === 12, `카탈로그 도구 ${CATALOG_TOOLS.length}개 ≠ 12`);
const names = [...CORE_TOOLS, ...CATALOG_TOOLS].map((t) => t.name);
check(new Set(names).size === names.length, "도구 이름 중복");
for (const t of [...CORE_TOOLS, ...CATALOG_TOOLS]) {
  check(/^[a-z][a-z0-9_]*$/.test(t.name), `이름 형식: ${t.name}`);
  check(t.description && t.description.length >= 20, `설명 없음: ${t.name}`);
  check(t.zod, `스키마 없음: ${t.name}`);
}
for (const t of CATALOG_TOOLS) check(t.catalog?.summary && t.catalog.summary.length <= 80, `카탈로그 요약 80자 초과/없음: ${t.name}`);

// 금지 이름 집합: 환경변수 LAWMCP_FORBIDDEN_NAMES 또는 forbidden_tool_names.txt(있을 때만)
const forbiddenPath = process.env.LAWMCP_FORBIDDEN_NAMES || join(here, "..", "forbidden_tool_names.txt");
if (existsSync(forbiddenPath)) {
  const forbidden = new Set(readFileSync(forbiddenPath, "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
  const clash = names.filter((n) => forbidden.has(n));
  check(clash.length === 0, `금지 이름과 충돌: ${clash.join(", ")}`);
  console.log(`금지 이름 ${forbidden.size}개와 교집합 ${clash.length}`);
} else console.log(`금지 이름 파일 없음(${forbiddenPath}) — 교집합 검사 생략`);

console.log(`코어 ${CORE_TOOLS.length} · 카탈로그 ${CATALOG_TOOLS.length} · tools/list ${TOOL_LIST_BYTES}B · 도구 ${TOOL_LIST.map((t) => t.name).join(", ")}`);
if (failures.length) { console.error("빌드 검사 실패:\n - " + failures.join("\n - ")); process.exit(1); }
console.log("build-check OK");
