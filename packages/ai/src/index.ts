/**
 * @natstack/ai
 *
 * AI client and types for NatStack.
 *
 * This package provides a ready-to-use AI client that works in both
 * panels and workers, built on top of @natstack/runtime's RPC layer.
 */

// Export the pre-wired ai client
export { ai } from "./client.js";

// RPC injection (for runtime configuration)
export { setRpc, getRpc } from "./rpc-inject.js";

// Re-export all public types.
export type * from "./types.js";

// =============================================================================
// Tool Helper (Zod -> JSON Schema)
// =============================================================================

import { zodToJsonSchema as convertZodToJsonSchema } from "zod-to-json-schema";
import { z } from "zod";
import type { ToolDefinition } from "./types.js";

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

