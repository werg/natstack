/**
 * Pi Coding Agent SDK Tool Adapter
 *
 * Converts PubsubToolRegistry tools into Pi's ToolDefinition[] format.
 * No HTTP MCP bridge needed — just direct execute functions that call
 * through to createToolExecutor().
 *
 * Tool approval is handled entirely by Pi's tool_call extension hook,
 * not by wrapping here.
 */

import type { AgenticClient } from "@workspace/agentic-protocol";
import type { PubsubToolRegistry } from "../pubsub-tool-registry.js";
import { createToolExecutor } from "../pubsub-tool-registry.js";

/**
 * Pi custom tool definition.
 * Structurally matches Pi SDK's ToolDefinition interface so it can be
 * passed to createAgentSession({ customTools }) with a cast.
 *
 * The execute signature matches Pi's:
 *   execute(toolCallId, params, signal, onUpdate, ctx) → AgentToolResult
 */
export interface PiToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: ((partialResult: { content: Array<{ type: string; text?: string }>; details: unknown }) => void) | undefined,
    ctx: unknown,
  ) => Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>;
}

/**
 * Convert a PubsubToolRegistry to Pi ToolDefinition-compatible objects.
 *
 * Returns tool definitions with built-in execute functions (no central dispatch needed)
 * and an originalToDisplay map for action tracking.
 */
export function toPiCustomTools(
  registry: PubsubToolRegistry,
  client: AgenticClient,
): {
  customTools: PiToolDefinition[];
  originalToDisplay: Map<string, string>;
} {
  const customTools: PiToolDefinition[] = [];
  const originalToDisplay = new Map<string, string>();

  for (const tool of registry.tools) {
    const executor = createToolExecutor(client, tool);

    customTools.push({
      name: tool.wireName,
      label: tool.wireName,
      description: tool.description ?? "",
      parameters: tool.parameters ?? {},
      execute: async (_toolCallId, params, signal) => {
        const result = await executor(params, signal);
        const text = typeof result === "string" ? result : JSON.stringify(result);
        return { content: [{ type: "text" as const, text }], details: undefined as unknown };
      },
    });

    originalToDisplay.set(tool.wireName, tool.wireName);
  }

  return { customTools, originalToDisplay };
}
