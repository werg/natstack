// =============================================================================
// @workspace/agentic-session — Headless agentic session convenience
// =============================================================================

// --- HeadlessSession ---
export { HeadlessSession, HeadlessTimeoutError } from "./headless-session.js";
export type {
  HeadlessSessionConfig,
  HeadlessWithAgentConfig,
  SessionSnapshot,
} from "./headless-session.js";

// --- Channel Helpers ---
export {
  getRecommendedChannelConfig,
  subscribeHeadlessAgent,
} from "./channel.js";
export type { SubscribeHeadlessAgentOptions } from "./channel.js";

// --- SandboxConfig Factory (RPC-based, for non-panel contexts) ---
export { createRpcSandboxConfig } from "./sandbox-factory.js";

// --- Re-export Pi-native types from agentic-core for convenience ---
export type {
  ChatMessage,
  ChatParticipantMetadata,
  ConnectionConfig,
  SandboxConfig,
  MethodHistoryEntry,
  MethodCallStatus,
  AgentMessage,
} from "@workspace/agentic-core";
