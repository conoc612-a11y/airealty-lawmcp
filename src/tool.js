// 도구 정의 틀. 핸들러는 봉투 객체를 돌려주고, 예외는 코드화된 오류 봉투로 바뀐다.
import { z } from "zod";
import { ok, fail } from "./envelope.js";
import { stats } from "./drf.js";
import { asOf as parseAsOf } from "./kst.js";
import { invalid } from "./errors.js";

/** 도구 정의: {name, description, schema(zod object shape), handler(args)->envelope, catalog?:{summary,tags,example}} */
export function defineTool(def) {
  const schema = z.object(def.schema).strict();
  return {
    ...def,
    zod: schema,
    async invoke(rawArgs) {
      const t0 = stats.upstreamMs; const started = Date.now();
      let args;
      try { args = schema.parse(rawArgs || {}); } catch (e) {
        const issues = e?.issues?.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ") || "입력 형식 오류";
        return fail(invalid(issues));
      }
      try {
        const body = await def.handler(args);
        if (body?.meta) { body.meta.upstreamMs = stats.upstreamMs - t0; body.meta.elapsedMs = Date.now() - started; }
        return body;
      } catch (e) {
        if (process.env.LAWMCP_DEBUG) console.error(`[${def.name}]`, e?.code || "", e?.message || e);
        return fail(e, args?.asOf);
      }
    },
  };
}

export { ok, fail, z };

/** 공통 스키마 조각 */
export const S = {
  lawSpec: {
    name: z.string().min(1).max(100).optional().describe("법령명 또는 약칭"),
    lawId: z.string().regex(/^\d{1,6}$/).optional().describe("법령ID"),
    mst: z.string().regex(/^\d{1,8}$/).optional().describe("법령일련번호(특정 판)"),
  },
  asOf: z.string().max(12).optional().describe("기준일(YYYY-MM-DD, 기본 오늘)"),
  page: z.number().int().min(1).max(10000).default(1),
  size: (d = 20) => z.number().int().min(1).max(100).default(d),
  maxBytes: z.number().int().min(8000).max(200000).default(60000).describe("응답 예산(바이트)"),
  part: z.number().int().min(1).max(1000).default(1).describe("이어받기 번호"),
};

/** asOf 입력 검증 → YYYYMMDD. */
export function asOfYmd(input) {
  const d = parseAsOf(input);
  if (!d) throw invalid(`기준일 형식 오류: ${input}`, "YYYYMMDD · YYYY-MM-DD · YYYY.MM.DD · YYYY. M. D.");
  return d;
}
