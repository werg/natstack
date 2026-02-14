/**
 * RPC Envelope Types
 *
 * Shared envelope format for IPC message routing between agent and host processes.
 * Used by both createIpcTransport (agent-side) and createHostTransport (host-side).
 */

import type { RpcMessage } from "@natstack/rpc";

/**
 * Message envelope for RPC over IPC.
 * Wraps RPC messages with source/target routing information.
 */
export interface ParentPortEnvelope {
  /** Target endpoint ID (e.g., "main" for host process) */
  targetId: string;
  /** Source endpoint ID (e.g., "agent:my-agent-id") */
  sourceId?: string;
  /** The RPC message payload */
  message: RpcMessage;
}

/**
 * Type guard for ParentPortEnvelope.
 */
export function isParentPortEnvelope(msg: unknown): msg is ParentPortEnvelope {
  if (typeof msg !== "object" || msg === null) return false;
  const envelope = msg as Record<string, unknown>;
  return (
    typeof envelope["targetId"] === "string" &&
    "message" in envelope &&
    typeof envelope["message"] === "object" &&
    envelope["message"] !== null
  );
}
