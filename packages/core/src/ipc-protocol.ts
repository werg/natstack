/**
 * IPC Protocol - Message types for host ↔ agent communication.
 *
 * Defines the message protocol between AgentHost (main process) and
 * Agent (utilityProcess/Node.js process).
 */

/**
 * Configuration passed to an agent on initialization.
 */
export interface AgentInitConfig {
  /** Agent type ID from AgentManifest */
  agentId: string;
  /** Channel this instance is joining */
  channel: string;
  /** Handle to use in the channel */
  handle: string;
  /** Agent configuration parameters */
  config: Record<string, unknown>;
  /** PubSub WebSocket server URL */
  pubsubUrl: string;
  /** Authentication token for PubSub */
  pubsubToken: string;
}

/**
 * Messages from AgentHost (main process) → Agent (utilityProcess).
 */
export type HostToAgentMessage =
  | { type: "init"; config: AgentInitConfig }
  | { type: "shutdown" }
  | { type: "state-response"; state: unknown | null };

/**
 * Messages from Agent (utilityProcess) → AgentHost (main process).
 */
export type AgentToHostMessage =
  | { type: "ready" }
  | { type: "state-request" }
  | { type: "state-update"; state: unknown }
  | { type: "state-save"; state: unknown }
  | { type: "shutdown-complete" }
  | { type: "error"; error: string; stack?: string };

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
    ["ready", "state-request", "state-update", "state-save", "shutdown-complete", "error"].includes(
      type
    )
  );
}
