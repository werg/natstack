// =============================================================================
// @workspace/agentic-core — Headless agentic session helpers
//
// Pi (`@earendil-works/pi-agent-core`) owns chat state. This package provides:
// - Pi message/event type re-exports (single import surface for consumers)
// - The signal event envelope used by the channel snapshot stream
// - The eval tool factory
// - The sandbox config factory
// - Connection management primitives
// =============================================================================

// --- Pi message/event type re-exports ---
export type { AgentMessage, AgentEvent } from "@earendil-works/pi-agent-core";

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

// Re-exported from @workspace/pubsub for convenience — canonical role-based
// predicates for distinguishing agent participants from client participants.
export { isAgentParticipantType, isClientParticipantType } from "@workspace/pubsub";

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

// --- Signal Event Envelope (typed structured channel payloads) ---
export { parseSignalEvent } from "./signal-event-envelope.js";
export type {
  SignalEventEnvelope,
  SignalMessageLike,
} from "./signal-event-envelope.js";

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

// --- Tool call payload (structured content for contentType "toolCall") ---
export type { ToolCallPayload, ToolExecutionState } from "./tool-call-payload.js";
export { parseToolCallPayload } from "./tool-call-payload.js";

// --- Shared wire-event → ChatMessage merge helpers ---
export {
  createChatMessageFromWire,
  applyChatMessageUpdate,
  applyChatMessageError,
} from "./channel-chat-merge.js";
export type {
  WireNewMessage,
  WireUpdateMessage,
  WireErrorMessage,
} from "./channel-chat-merge.js";

// --- Method call result helpers ---
export {
  isChatMethodResult,
  unwrapChatMethodResult,
} from "./method-result.js";
export type { ChatMethodResult } from "./method-result.js";

// --- Pi snapshot → ChatMessage[] deriver (removed: channel messages replace snapshots) ---
