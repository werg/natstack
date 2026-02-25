/**
 * Codex MCP HTTP Bridge Adapter
 *
 * Converts PubsubToolRegistry to MCP tool definitions for the Codex SDK.
 * Codex uses an HTTP MCP server to discover and invoke tools.
 */

import type { AgenticClient } from "@workspace/agentic-messaging";
import type { PubsubToolRegistry } from "../pubsub-tool-registry.js";
import { createToolExecutor } from "../pubsub-tool-registry.js";

/**
 * MCP tool definition for Codex HTTP bridge.
 */
export interface CodexToolDefinition {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
  /** Original execution name for routing tool calls back */
  originalName: string;
}

/**
 * Convert a PubsubToolRegistry to Codex MCP tool definitions.
 *
 * Returns tool definitions with `originalName` markers for routing,
 * plus an execute function that dispatches by originalName.
 */
export function toCodexMcpTools(
  registry: PubsubToolRegistry,
  client: AgenticClient,
  standardMcpTools: Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    originalName: string;
  }>,
): {
  definitions: CodexToolDefinition[];
  /** Map from originalName -> display name for action tracking */
  originalToDisplay: ReadonlyMap<string, string>;
  /** Execute a tool by its originalName (wire name or standard tool marker) */
  execute: (originalName: string, args: unknown, signal?: AbortSignal) => Promise<unknown>;
} {
  const definitions: CodexToolDefinition[] = [];
  const originalToDisplay = new Map<string, string>();
  const executorCache = new Map<string, (args: unknown, signal?: AbortSignal) => Promise<unknown>>();

  // Add pubsub tools
  for (const tool of registry.tools) {
    const displayName = tool.wireName;

    definitions.push({
      name: displayName,
      description: tool.description,
      parameters: tool.parameters,
      originalName: tool.wireName,
    });

    originalToDisplay.set(tool.wireName, displayName);

    // Pre-create executor
    const executor = createToolExecutor(client, tool);
    executorCache.set(tool.wireName, executor);
  }

  // Add standard MCP tools
  for (const stdTool of standardMcpTools) {
    definitions.push({
      name: stdTool.name,
      description: stdTool.description,
      parameters: stdTool.parameters,
      originalName: stdTool.originalName,
    });
    originalToDisplay.set(stdTool.originalName, stdTool.name);
  }

  // Execute function dispatches by originalName
  const execute = async (originalName: string, args: unknown, signal?: AbortSignal): Promise<unknown> => {
    const executor = executorCache.get(originalName);
    if (executor) {
      return executor(args, signal);
    }

    // Not a pubsub tool - must be handled by caller (standard tools)
    throw new Error(`Tool not found in registry: ${originalName}`);
  };

  return { definitions, originalToDisplay, execute };
}
