// 키 없는 공개 링크 (SPEC §3.6). airealty 상담 화면이 쓰는 "법령명/조문" 공개 주소와 호환.
import { scrub } from "./keys.js";
import { articleLabel } from "./jo.js";

const SITE = "https://www.law.go.kr";

export function lawLink(name, ref) {
  let u = `${SITE}/법령/${encodeURIComponent(name)}`;
  if (ref) u += `/${encodeURIComponent(typeof ref === "string" ? ref : articleLabel(ref.article, ref.branch))}`;
  return u;
}
export const adminRuleLink = (name) => `${SITE}/행정규칙/${encodeURIComponent(name)}`;
export const ordinanceLink = (name) => `${SITE}/자치법규/${encodeURIComponent(name)}`;
export const precedentLink = (id) => `${SITE}/판례/(${encodeURIComponent(String(id))})`;
export const interpretationLink = (id) => `${SITE}/법령해석례/(${encodeURIComponent(String(id))})`;
export const treatyLink = (id) => `${SITE}/조약/(${encodeURIComponent(String(id))})`;
export const constitutionalLink = (id) => `${SITE}/헌재결정례/(${encodeURIComponent(String(id))})`;
export const adminAppealLink = (id) => `${SITE}/행정심판례/(${encodeURIComponent(String(id))})`;

/** HTML 엔티티 복원. */
export function decodeEntities(s) {
  return String(s || "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

/**
 * 업스트림 상세링크 정규화: 엔티티 복원 → 인증값 파라미터 제거 → 상대 경로면 사이트 접두 → 인증값이 남으면 버린다(null).
 * DRF 경로 링크는 그 자체가 키를 요구하므로 공개 링크로 쓰지 않는다(null) — 호출자는 공개 링크 생성기를 쓴다.
 */
export function normalizeUpstreamLink(raw) {
  if (!raw) return null;
  let s = scrub(decodeEntities(raw)).replace(/[?&]OC=(?=&|$)/g, (m) => (m[0] === "?" ? "?" : "")).replace(/\?&/, "?").replace(/[?&]$/, "");
  if (/OC=/i.test(s)) return null;
  if (/\/DRF\/law(Search|Service)\.do/i.test(s)) return null;
  if (s.startsWith("/")) s = SITE + s;
  if (!/^https?:\/\//i.test(s)) return null;
  return s;
}
