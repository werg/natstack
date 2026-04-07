// =============================================================================
// @workspace/agentic-session — Headless agentic session convenience
// =============================================================================

// --- HeadlessSession ---
export { HeadlessSession, HeadlessTimeoutError } from "./headless-session.js";
export type { HeadlessSessionConfig, HeadlessWithAgentConfig, SessionSnapshot } from "./headless-session.js";

// --- Channel Helpers ---
export {
  getRecommendedChannelConfig,
  subscribeHeadlessAgent,
} from "./channel.js";
export type { SubscribeHeadlessAgentOptions } from "./channel.js";

// --- SandboxConfig Factory (RPC-based, for non-panel contexts) ---
export { createRpcSandboxConfig } from "./sandbox-factory.js";

// --- Re-export core values + types for convenience ---
export { SessionManager } from "@workspace/agentic-core";
export type {
  SessionManagerConfig,
  ConnectOptions,
  SendOptions,
  ChatMessage,
  ChatParticipantMetadata,
  ConnectionConfig,
  SandboxConfig,
  MethodHistoryEntry,
  MethodCallStatus,
} from "@workspace/agentic-core";
