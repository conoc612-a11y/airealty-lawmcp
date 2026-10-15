// 디스크 JSON 캐시(키 없음) — 조문 번호 색인·체계도 요약처럼 "한 번 만들면 오래 쓰는" 파생물만 둔다.
// 디렉터리는 호출 시점에 읽는다(LAWMCP_CACHE_DIR, 테스트가 바꿀 수 있게). 쓰기 전에 인증값이 섞였는지 검사한다.
import { readFileSync, writeFileSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { apiKey } from "./keys.js";

export function cacheDir() { return process.env.LAWMCP_CACHE_DIR || join(homedir(), ".cache", "airealty-lawmcp"); }

const safe = (s) => String(s).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120);
function pathOf(bucket, key) { return join(cacheDir(), safe(bucket), safe(key) + ".json"); }

/** 읽기 → {value, savedAt, ageMs} | null. 깨진 파일은 null. */
export function readDisk(bucket, key, now = Date.now()) {
  const p = pathOf(bucket, key);
  try {
    const d = JSON.parse(readFileSync(p, "utf8"));
    const savedAt = +d.savedAt || statSync(p).mtimeMs;
    return { value: d.value, savedAt, ageMs: Math.max(0, now - savedAt) };
  } catch { return null; }
}

/** 쓰기(원자적: 임시 파일 → rename). 인증값이 들어 있으면 쓰지 않고 false. */
export function writeDisk(bucket, key, value, now = Date.now()) {
  const text = JSON.stringify({ savedAt: now, value });
  const k = apiKey();
  if (k && k.length >= 4 && text.includes(k)) return false;
  const p = pathOf(bucket, key);
  try {
    mkdirSync(join(cacheDir(), safe(bucket)), { recursive: true });
    const tmp = `${p}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    writeFileSync(tmp, text);
    try { renameSync(tmp, p); } catch { try { unlinkSync(tmp); } catch {} return false; }
    return true;
  } catch { return false; }
}
