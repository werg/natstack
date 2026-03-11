/**
 * Minimal JSON Schema → Zod conversion for MCP tool parameters.
 *
 * The Claude Agent SDK's `tool()` function expects a `ZodRawShape`
 * (object with Zod type values), but we receive JSON Schema from
 * the PubSub method discovery layer. This module bridges the gap.
 *
 * Only handles the JSON Schema subset commonly produced by
 * `zod-to-json-schema` (the round-trip panel → metadata → harness).
 */

import { z } from "zod";

/**
 * Convert a JSON Schema "object" definition to a Zod raw shape
 * suitable for passing to the SDK's `tool()` function.
 *
 * @param schema - JSON Schema with `type: "object"`, `properties`, `required`
 * @returns A `{ [key: string]: ZodTypeAny }` shape
 */
export function jsonSchemaToZodRawShape(schema: Record<string, unknown>): z.ZodRawShape {
  const properties = (schema["properties"] as Record<string, unknown>) ?? {};
  const required = new Set(
    Array.isArray(schema["required"]) ? (schema["required"] as string[]) : [],
  );

  const shape: z.ZodRawShape = {};
  for (const [key, value] of Object.entries(properties)) {
    const propSchema =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    const zodProp = jsonSchemaToZod(propSchema);
    shape[key] = required.has(key) ? zodProp : zodProp.optional();
  }
  return shape;
}

/**
 * Convert a single JSON Schema type to a Zod type.
 */
function jsonSchemaToZod(schema: Record<string, unknown>): z.ZodTypeAny {
  // Enums
  if (Array.isArray(schema["enum"])) {
    const values = schema["enum"].filter(
      (v): v is string => typeof v === "string",
    );
    if (values.length > 0) return z.enum(values as [string, ...string[]]);
  }

  const type = schema["type"];

  if (type === "string") {
    let s: z.ZodTypeAny = z.string();
    if (schema["description"]) s = s.describe(schema["description"] as string);
    if (schema["default"] !== undefined) s = (s as z.ZodString).default(schema["default"] as string);
    return s;
  }

  if (type === "number" || type === "integer") {
    let n: z.ZodTypeAny = z.number();
    if (schema["description"]) n = n.describe(schema["description"] as string);
    if (schema["default"] !== undefined) n = (n as z.ZodNumber).default(schema["default"] as number);
    return n;
  }

  if (type === "boolean") {
    let b: z.ZodTypeAny = z.boolean();
    if (schema["description"]) b = b.describe(schema["description"] as string);
    return b;
  }

  if (type === "array") {
    const items = schema["items"];
    const itemSchema =
      items && typeof items === "object" && !Array.isArray(items)
        ? jsonSchemaToZod(items as Record<string, unknown>)
        : z.any();
    return z.array(itemSchema);
  }

  if (type === "object") {
    // Record<string, T> pattern: additionalProperties with a typed schema
    if (
      schema["additionalProperties"] &&
      typeof schema["additionalProperties"] === "object"
    ) {
      return z.record(
        z.string(),
        jsonSchemaToZod(schema["additionalProperties"] as Record<string, unknown>),
      );
    }
    // Object with properties
    if (schema["properties"]) {
      return z.object(jsonSchemaToZodRawShape(schema));
    }
    // Generic object
    return z.record(z.string(), z.any());
  }

  return z.any();
}
