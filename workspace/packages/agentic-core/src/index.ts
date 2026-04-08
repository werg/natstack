// =============================================================================
// @workspace/agentic-core — Headless agentic session helpers
//
// Pi (`@mariozechner/pi-coding-agent`) owns chat state. This package provides:
// - Pi message/event type re-exports (single import surface for consumers)
// - The ephemeral event envelope used by the channel snapshot stream
// - The eval tool factory
// - The sandbox config factory
// - Connection management primitives
// =============================================================================

// --- Pi message/event type re-exports ---
export type { AgentMessage } from "@mariozechner/pi-agent-core";
export type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";

// --- Headless types ---
export type {
  ChatParticipantMetadata,
  ConnectionConfig,
  AgenticChatActions,
  ChatSandboxValue,
  SandboxConfig,
  ToolProviderDeps,
  ToolProvider,
} from "./types.js";

// Re-exported from @natstack/pubsub for convenience — canonical role-based
// predicates for distinguishing agent participants from client participants.
export { isAgentParticipantType, isClientParticipantType } from "@natstack/pubsub";

// --- Typed Event Emitter ---
export { TypedEmitter } from "./emitter.js";

// --- Connection ---
export { ConnectionManager } from "./connection.js";
export type { ConnectionStatus } from "./connection.js";

// --- Eval Tool ---
export { buildEvalTool } from "./eval-tool.js";
export type { BuildEvalToolOptions } from "./eval-tool.js";

// --- SandboxConfig Factories ---
export { createPanelSandboxConfig } from "./sandbox-factory.js";

// --- Ephemeral Event Envelope (typed structured channel payloads) ---
export { parseEphemeralEvent } from "./ephemeral-event-envelope.js";
export type {
  EphemeralEventEnvelope,
  EphemeralMessageLike,
} from "./ephemeral-event-envelope.js";

// --- Derived UI shapes (computed from Pi snapshots for component rendering) ---
export type {
  ChatMessage,
  MethodHistoryEntry,
  MethodCallStatus,
  PendingAgent,
  PendingAgentStatus,
  DisconnectedAgentInfo,
  DirtyRepoDetails,
} from "./derived-types.js";

// --- Pi snapshot → ChatMessage[] deriver ---
export { derivePiSnapshot } from "./derive-pi-snapshot.js";
