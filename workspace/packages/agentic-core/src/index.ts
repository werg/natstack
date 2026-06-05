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
  AvailableAgent,
  ConnectProviderResult,
  ChatSandboxValue,
  SandboxConfig,
  ToolProviderDeps,
  ToolProvider,
} from "./types.js";
// Model catalog shared types (re-exported so chat/panel import one surface).
export type {
  AgentThinkingLevel as ModelAgentThinkingLevel,
  ModelCatalog,
  ModelCatalogEntry,
  ModelCatalogProvider,
} from "@natstack/shared/models/catalog";
export type {
  AgentApprovalLevel,
  AgentRespondPolicy,
  AgentSubscriptionConfig,
  AgentThinkingLevel,
} from "./agent-subscription-config.js";

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
  PendingAgent,
  PendingAgentStatus,
  DisconnectedAgentInfo,
  DirtyRepoDetails,
  InlineUiCardPayload,
  ActionBarPayload,
  ApprovalCardPayload,
  CustomMessageCardPayload,
  CustomMessageDisplayMode,
  CustomMessageUpdatePayload,
  ActiveMessageTypeDefinition,
  ClearedMessageTypeDefinition,
  MessageTypeDefinition,
  ProjectedMessageTypeDefinition,
} from "./derived-types.js";

export {
  compileMessageTypeModule,
  foldCustomMessageState,
  validateCustomState,
} from "./custom-message-types.js";
export type {
  CustomMessageComponentProps,
  CustomMessageValidator,
  MessageTypeModule,
} from "./custom-message-types.js";

// --- Invocation card payload (derived UI shape for invocation events) ---
export type { InvocationCardPayload, ToolExecutionState } from "./invocation-card-payload.js";
export { parseInvocationCardPayload } from "./invocation-card-payload.js";

// --- Shared wire-event → ChatMessage merge helpers ---
export {
  actionBarPayloadFromChannelView,
  chatMessagesFromChannelView,
  messageTypeDefinitionsFromChannelView,
} from "./channel-chat-merge.js";

// --- Invocation result helpers ---
export {
  isChatMethodResult,
  unwrapChatMethodResult,
} from "./invocation-result.js";
export type { ChatMethodResult } from "./invocation-result.js";

// --- Pi snapshot → ChatMessage[] deriver (removed: channel messages replace snapshots) ---
