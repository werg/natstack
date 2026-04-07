// =============================================================================
// @workspace/agentic-core — Headless agentic session management
// =============================================================================

// --- Types ---
export type {
  MethodCallStatus,
  MethodHistoryEntry,
  PendingAgentStatus,
  PendingAgent,
  ChatParticipantMetadata,
  DisconnectedAgentInfo,
  ChatMessage,
  ConnectionConfig,
  AgenticChatActions,
  ChatSandboxValue,
  SandboxConfig,
  ToolProviderDeps,
  ToolProvider,
} from "./types.js";

// Re-exported from @natstack/pubsub for convenience — canonical role-based
// predicates for distinguishing agent participants from client participants.
// They live in pubsub so lower-level packages (agentic-do) can use them
// without depending on agentic-core.
export { isAgentParticipantType, isClientParticipantType } from "@natstack/pubsub";

// --- Message Reducer ---
export {
  messageWindowReducer,
  messageWindowInitialState,
} from "./message-reducer.js";
export type {
  MessageWindowState,
  MessageWindowAction,
} from "./message-reducer.js";

// --- Event Dispatch ---
export {
  dispatchAgenticEvent,
  aggregatedToChatMessage,
} from "./event-dispatch.js";
export type {
  DirtyRepoDetails,
  AgentEventHandlers,
  EventMiddleware,
} from "./event-dispatch.js";

// --- Typed Event Emitter ---
export { TypedEmitter } from "./emitter.js";

// --- Method History ---
export { MethodHistoryTracker } from "./method-history.js";

// --- Connection ---
export { ConnectionManager } from "./connection.js";
export type { ConnectionStatus } from "./connection.js";

// --- Message State ---
export { MessageState } from "./message-state.js";

// --- Session Manager ---
export { SessionManager } from "./session-manager.js";
export type { SessionManagerConfig, SessionManagerEvents, ConnectOptions, SendOptions } from "./session-manager.js";

// --- Eval Tool ---
export { buildEvalTool } from "./eval-tool.js";
export type { BuildEvalToolOptions } from "./eval-tool.js";

// --- SandboxConfig Factories ---
export {
  createPanelSandboxConfig,
} from "./sandbox-factory.js";
