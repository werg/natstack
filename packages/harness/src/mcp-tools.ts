/**
 * MCP tool creation for the Claude SDK adapter.
 *
 * Converts discovered channel methods (from the `discoverMethods` dep) into
 * MCP tool definitions suitable for the Claude Agent SDK's `createSdkMcpServer`.
 *
 * This module is adapter-agnostic: it works with the `DiscoveredMethod` shape
 * defined in the adapter deps, not with PubSub types directly.
 */

import type { DiscoveredMethod } from './claude-sdk-adapter.js';

/**
 * MCP tool definition in a shape the Claude Agent SDK can consume.
 *
 * The `parameters` field is a JSON Schema object (not a Zod schema) because
 * the adapter converts it to Zod at call-time using the SDK's helpers.
 */
export interface McpToolDefinition {
  /** Tool name as seen by the model */
  name: string;
  /** Human-readable description */
  description: string;
  /** JSON Schema for the tool's input parameters */
  parameters: Record<string, unknown>;
  /**
   * Execute the tool by calling the channel participant's method.
   *
   * @returns The MCP CallToolResult content array
   */
  execute: (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: 'text'; text: string }>;
  }>;
}

/**
 * Convert discovered channel methods into MCP tool definitions.
 *
 * Each discovered method becomes a tool whose `execute` function delegates
 * to `callMethod` on the adapter deps.
 *
 * @param methods - Methods discovered via `deps.discoverMethods()`
 * @param callMethod - The `deps.callMethod` function to delegate execution to
 * @returns An array of MCP tool definitions ready for `createSdkMcpServer`
 */
export function buildMcpToolDefinitions(
  methods: DiscoveredMethod[],
  callMethod: (participantId: string, method: string, args: unknown) => Promise<unknown>,
  log?: { info(...args: unknown[]): void; error(...args: unknown[]): void },
): McpToolDefinition[] {
  return methods.map((method) => ({
    name: method.name,
    description: method.description,
    parameters: (method.parameters as Record<string, unknown>) ?? { type: 'object', properties: {} },
    execute: async (args: Record<string, unknown>) => {
      log?.info(`MCP tool execute: ${method.name} -> ${method.participantId} (args keys: ${Object.keys(args).join(', ')})`);
      try {
        const result = await callMethod(method.participantId, method.name, args);
        log?.info(`MCP tool result: ${method.name} (type: ${typeof result})`);
        const text = typeof result === 'string' ? result : JSON.stringify(result);
        return { content: [{ type: 'text' as const, text }] };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        log?.error(`MCP tool error: ${method.name} — ${errorMsg}`);
        return { content: [{ type: 'text' as const, text: `Error executing ${method.name}: ${errorMsg}` }] };
      }
    },
  }));
}
