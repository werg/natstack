/**
 * RPC injection module for @workspace/ai.
 *
 * This allows @workspace/ai to work without a direct dependency on
 * @workspace/runtime. The runtime configures this during initialization.
 *
 * For agents running in utilityProcess, the agent-runtime will inject
 * its own RPC bridge that uses IPC to communicate with the host.
 */

import type { RpcBridge } from "@natstack/rpc";

let rpcBridge: RpcBridge | null = null;

/**
 * Set the RPC bridge instance.
 * Called by @workspace/runtime during initialization.
 *
 * @param bridge The RPC bridge to use for AI communication
 */
export function setRpc(bridge: RpcBridge): void {
  rpcBridge = bridge;
}

/**
 * Get the current RPC bridge.
 * Throws if not configured.
 */
export function getRpc(): RpcBridge {
  if (!rpcBridge) {
    throw new Error(
      "RPC bridge not configured. " +
      "Call setRpc() before using AI features. " +
      "In panels/workers, @workspace/runtime does this automatically."
    );
  }
  return rpcBridge;
}
