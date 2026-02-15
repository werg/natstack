/**
 * IPC Protocol - Message types for host <-> agent communication.
 *
 * Types are canonical in @natstack/types. Type guards live here.
 */

import type { HostToAgentMessage, AgentToHostMessage } from "@natstack/types";

/**
 * Type guard for HostToAgentMessage.
 */
export function isHostToAgentMessage(msg: unknown): msg is HostToAgentMessage {
  if (typeof msg !== "object" || msg === null || !("type" in msg)) return false;
  const type = (msg as { type: unknown }).type;
  return (
    typeof type === "string" && ["init", "shutdown", "state-response"].includes(type)
  );
}

/**
 * Type guard for AgentToHostMessage.
 */
export function isAgentToHostMessage(msg: unknown): msg is AgentToHostMessage {
  if (typeof msg !== "object" || msg === null || !("type" in msg)) return false;
  const type = (msg as { type: unknown }).type;
  return (
    typeof type === "string" &&
    ["ready", "state-request", "state-update", "state-save", "shutdown-complete", "error", "log"].includes(
      type
    )
  );
}
