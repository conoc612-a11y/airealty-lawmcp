#!/usr/bin/env node
// stdio 진입점 — initialize 전 네트워크 없음, 로그는 stderr 만 (SPEC §7.1). 가벼운 stdio 루프(src/stdio.js) + 지연 로드.
import { startStdio } from "./stdio.js";
import { keyInfo } from "./keys.js";

startStdio();
const k = keyInfo();
console.error(`airealty-lawmcp ready (stdio) · key ${k.name} len ${k.length}`);
