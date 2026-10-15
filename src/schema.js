// zod 객체 → 간결한 JSON Schema (tools/list 크기 예산을 위해 설명은 그대로, 불필요한 키 없이).
import { z } from "zod";

export function zodToJsonSchema(schema) {
  const def = schema?._def;
  if (!def) return {};
  const t = def.typeName;
  const desc = def.description ? { description: def.description } : {};
  switch (t) {
    case "ZodObject": {
      const shape = typeof def.shape === "function" ? def.shape() : def.shape;
      const properties = {}; const required = [];
      for (const [k, v] of Object.entries(shape)) { properties[k] = zodToJsonSchema(v); if (!isOptional(v)) required.push(k); }
      return { type: "object", properties, ...(required.length ? { required } : {}), ...desc };
    }
    case "ZodString": { const o = { type: "string", ...desc }; for (const c of def.checks || []) { if (c.kind === "min") o.minLength = c.value; if (c.kind === "max") o.maxLength = c.value; } return o; }
    case "ZodNumber": { const o = { type: (def.checks || []).some((c) => c.kind === "int") ? "integer" : "number", ...desc }; for (const c of def.checks || []) { if (c.kind === "min") o.minimum = c.value; if (c.kind === "max") o.maximum = c.value; } return o; }
    case "ZodBoolean": return { type: "boolean", ...desc };
    case "ZodLiteral": return { const: def.value, ...desc };
    case "ZodEnum": return { type: "string", enum: def.values, ...desc };
    case "ZodArray": { const o = { type: "array", items: zodToJsonSchema(def.type), ...desc }; if (def.minLength) o.minItems = def.minLength.value; if (def.maxLength) o.maxItems = def.maxLength.value; return o; }
    case "ZodUnion": return { anyOf: def.options.map(zodToJsonSchema), ...desc };
    case "ZodRecord": return { type: "object", additionalProperties: zodToJsonSchema(def.valueType), ...desc };
    case "ZodAny": return { ...desc };
    case "ZodOptional": return { ...zodToJsonSchema(def.innerType), ...desc };
    case "ZodDefault": return { ...zodToJsonSchema(def.innerType), default: def.defaultValue(), ...desc };
    case "ZodEffects": return { ...zodToJsonSchema(def.schema), ...desc };
    default: return { ...desc };
  }
}
function isOptional(v) { const t = v?._def?.typeName; return t === "ZodOptional" || t === "ZodDefault" || (t === "ZodEffects" && isOptional(v._def.schema)); }
export { z };
