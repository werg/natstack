import { z } from "zod";
import { createAIError } from "./errors.js";
import type { AIToolDefinition } from "@natstack/types";

/**
 * Zod-backed validation helpers for AI payloads.
 * Throws AIError with helpful context on validation failure.
 */

const AIToolDefinitionSchema = z.object({
  type: z.literal("function"),
  name: z.string(),
  description: z.string().optional(),
  parameters: z.record(z.unknown()),
});

const AIToolDefinitionArraySchema = z.array(AIToolDefinitionSchema);

export function validateToolDefinitions(tools: unknown): AIToolDefinition[] | undefined {
  if (tools === undefined) return undefined;
  const result = AIToolDefinitionArraySchema.safeParse(tools);
  if (result.success) return result.data;
  const firstError = result.error.errors[0];
  const path = firstError?.path.join(".") || "input";
  const message = firstError?.message || "unknown validation error";
  throw createAIError("internal_error", `AI tool definitions validation failed (${path}: ${message})`);
}
