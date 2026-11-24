// zod 객체 → 간결한 JSON Schema. 변환은 zod 가 하고, tools/list 크기 예산(13KB)을 위해 크기만 늘리는 키는 뺀다.
import { z } from "zod";

const DROP = new Set(["$schema", "additionalProperties", "propertyNames", "pattern"]);
const NESTED = new Set(["items", "anyOf", "oneOf", "allOf"]);
// 스키마 자리만 내려간다 — properties 의 키는 입력 필드 이름이고 default·enum·const 는 값이라 건드리지 않는다.
function slim(s) {
  if (Array.isArray(s)) return s.map(slim);
  if (!s || typeof s !== "object") return s;
  const o = {};
  for (const [k, v] of Object.entries(s)) {
    if (DROP.has(k)) continue;
    o[k] = k === "properties" ? Object.fromEntries(Object.entries(v).map(([n, p]) => [n, slim(p)])) : NESTED.has(k) ? slim(v) : v;
  }
  return o;
}

export const zodToJsonSchema = (schema) => (schema ? slim(z.toJSONSchema(schema, { io: "input" })) : {});
export { z };
