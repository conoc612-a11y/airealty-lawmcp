// 인증값 읽기 — 환경변수 openlaw_API_KEY → 저장소 루트 keys.env → tools/keys.env (SPEC §8).
// 값은 절대 로그·출력에 쓰지 않는다. 이름·길이만 보고한다.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const KEY_NAME = "openlaw_API_KEY";
let cached;

function fromFile(path, name) {
  let text;
  try { text = readFileSync(path, "utf8"); } catch { return undefined; }
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i < 0) continue;
    if (line.slice(0, i).trim() !== name) continue;
    const v = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    if (v) return v;
  }
  return undefined;
}

/** @returns {string|undefined} 인증값(없으면 undefined — 서버는 뜨고 호출 시 UPSTREAM_AUTH) */
export function apiKey() {
  if (cached !== undefined) return cached || undefined;
  const v = process.env[KEY_NAME] || fromFile(join(ROOT, "keys.env"), KEY_NAME) || fromFile(join(ROOT, "tools", "keys.env"), KEY_NAME);
  cached = v || "";
  return v;
}

/** 테스트용: 인증값을 강제로 바꾼다(가짜 키 누출 검사). */
export function _setApiKey(v) { cached = v || ""; }

export function keyInfo() { const k = apiKey(); return { name: KEY_NAME, length: k ? k.length : 0 }; }

/** 문자열 어디에든 인증값이 있으면 지운다(응답 링크·오류 메시지·캐시 기록 전에). */
export function scrub(text) {
  const k = apiKey();
  if (typeof text !== "string") return text;
  let out = text.replace(/([?&;]OC=)[^&"'\s<>]*/gi, "$1").replace(/OC%3D[^&"'\s<>%]*/gi, "OC%3D");
  if (k && k.length >= 4) out = out.split(k).join("");
  return out;
}
