/**
 * IPC Protocol - Type guard for host-to-agent messages.
 *
 * Inlined from @workspace/core/ipc-protocol.ts during package rescoping.
 */

import type { HostToAgentMessage } from "@natstack/types";

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
