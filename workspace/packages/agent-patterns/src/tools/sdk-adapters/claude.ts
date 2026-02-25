/**
 * Claude Agent SDK Adapter
 *
 * Converts PubsubToolRegistry to Claude SDK MCP tool format.
 * Uses canonical names (Read, Write, etc.) for Claude-style LLMs.
 */

import type { AgenticClient } from "@workspace/agentic-protocol";
import type { PubsubToolRegistry } from "../pubsub-tool-registry.js";
import { createToolExecutor } from "../pubsub-tool-registry.js";

/**
 * Result of converting tools for the Claude SDK.
 */
export interface ClaudeMcpToolsResult {
  /**
   * Tool definitions ready for Claude SDK's tool() function.
   * Each entry has the info needed to create an MCP tool:
   * - name: canonical name (e.g., "Read")
   * - description: tool description
   * - parameters: JSON Schema parameters
   * - execute: function that calls the pubsub method
   */
  toolDefs: ClaudeMcpToolDef[];

  /**
   * List of allowed tool names in mcp__<server>__<name> format.
   * Pass this to the Claude SDK's allowedTools option.
   */
  allowedTools: string[];

  /**
   * Execute a tool by its canonical name.
   * Returns the raw pubsub method result.
   */
  execute: (canonicalName: string, args: unknown, signal?: AbortSignal) => Promise<unknown>;
}

/**
 * Tool definition ready for Claude SDK's tool() function.
 */
export interface ClaudeMcpToolDef {
  /** Canonical name (e.g., "Read") */
  name: string;
  /** Tool description */
  description: string;
  /** JSON Schema for parameters */
  parameters: Record<string, unknown>;
  /** Original pubsub method name (e.g., "file_read") */
  originalMethodName: string;
  /** Execute function for this tool */
  execute: (args: unknown) => Promise<{ content: Array<{ type: "text"; text: string }> }>;
}

export interface ToClaudeMcpToolsOptions {
  /** MCP server name for allowedTools prefix (default: "workspace") */
  serverName?: string;
}

/**
 * Convert a PubsubToolRegistry to Claude SDK MCP tool definitions.
 *
 * Returns tool definitions that can be passed to Claude SDK's tool() function,
 * plus the allowedTools list.
 *
 * @example
 * ```typescript
 * const registry = await waitForTools(client, { required: ["feedback_form"] });
 * const { toolDefs, allowedTools, execute } = toClaudeMcpTools(registry, client);
 *
 * // Create MCP tools for Claude SDK
 * const mcpTools = toolDefs.map(t => tool(t.name, t.description, zodShape(t.parameters), t.execute));
 * const server = createSdkMcpServer({ name: "workspace", tools: mcpTools });
 * ```
 */
export function toClaudeMcpTools(
  registry: PubsubToolRegistry,
  client: AgenticClient,
  options?: ToClaudeMcpToolsOptions
): ClaudeMcpToolsResult {
  const serverName = options?.serverName ?? "workspace";
  const toolDefs: ClaudeMcpToolDef[] = [];
  const allowedTools: string[] = [];
  const executorCache = new Map<string, (args: unknown, signal?: AbortSignal) => Promise<unknown>>();

  for (const tool of registry.tools) {
    const executor = createToolExecutor(client, tool);
    executorCache.set(tool.canonicalName, executor);

    toolDefs.push({
      name: tool.canonicalName,
      description: tool.description ?? "",
      parameters: tool.parameters,
      originalMethodName: tool.methodName,
      execute: async (args: unknown) => {
        const result = await executor(args);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      },
    });

    allowedTools.push(`mcp__${serverName}__${tool.canonicalName}`);
  }

  const execute = async (canonicalName: string, args: unknown, signal?: AbortSignal): Promise<unknown> => {
    const executor = executorCache.get(canonicalName);
    if (!executor) {
      throw new Error(`Tool not found: ${canonicalName}`);
    }
    return executor(args, signal);
  };

  return { toolDefs, allowedTools, execute };
}
