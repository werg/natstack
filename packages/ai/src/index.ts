/**
 * @natstack/ai
 *
 * AI client for NatStack.
 *
 * Provides a factory for creating AI clients backed by an RPC bridge.
 * Types live in @natstack/types (canonical source).
 */

// Export the AI client factory and type
export { createAiClient } from "./client.js";
export type { AiClient } from "./client.js";

// =============================================================================
// Tool Helper (Zod -> JSON Schema)
// =============================================================================

import { zodToJsonSchema as convertZodToJsonSchema } from "zod-to-json-schema";
import { z } from "zod";
import type { ToolDefinition } from "@natstack/types";

function isZodSchema(schema: unknown): schema is z.ZodTypeAny {
  return schema instanceof z.ZodType;
}

function zodToJsonSchema(schema: unknown): Record<string, unknown> {
  if (!isZodSchema(schema)) return schema as Record<string, unknown>;
  return convertZodToJsonSchema(schema as Parameters<typeof convertZodToJsonSchema>[0], {
    target: "openApi3",
  }) as Record<string, unknown>;
}

export interface ToolInput<TParams = Record<string, unknown>> {
  description?: string;
  parameters: TParams;
  execute: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
}

export function tool<TParams>(input: ToolInput<TParams>): ToolDefinition {
  return {
    description: input.description,
    parameters: zodToJsonSchema(input.parameters),
    execute: input.execute,
  };
}
