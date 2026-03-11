/**
 * Tool bridge — creates SDK-compatible tool executors that call channel
 * participant methods via the harness's RPC bridge.
 *
 * The harness process doesn't have direct access to PubSub or channels.
 * Instead, it calls `channel.callMethod` and `channel.discoverMethods` on the
 * server via RPC, and the server dispatches to the actual channel participants.
 *
 * @module
 */

import type { DiscoveredMethod } from "./claude-sdk-adapter.js";

/**
 * Dependencies for the tool bridge — satisfied by the harness's RPC wiring.
 */
export interface ToolBridgeDeps {
  /** Call a method on a channel participant via the server */
  callMethod(
    participantId: string,
    method: string,
    args: unknown,
  ): Promise<unknown>;

  /** Discover available methods from all channel participants */
  discoverMethods(): Promise<DiscoveredMethod[]>;
}

/**
 * Discover methods from channel participants via the server.
 *
 * Returns the full list of {@link DiscoveredMethod} entries that can be
 * converted to SDK tools (MCP tools for Claude, custom tools for Pi).
 */
export async function discoverAndCreateTools(
  deps: ToolBridgeDeps,
): Promise<DiscoveredMethod[]> {
  return deps.discoverMethods();
}

/**
 * Create a tool executor function that calls a specific channel method via RPC.
 *
 * The returned function can be used as a tool handler for SDK tool definitions.
 *
 * @param deps - Tool bridge dependencies
 * @param participantId - The ID of the channel participant that provides the method
 * @param methodName - The method name to call on the participant
 * @returns An async function that executes the tool call
 */
export function createToolExecutor(
  deps: ToolBridgeDeps,
  participantId: string,
  methodName: string,
): (args: unknown) => Promise<unknown> {
  return async (args: unknown) => {
    return deps.callMethod(participantId, methodName, args);
  };
}
