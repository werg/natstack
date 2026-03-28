// =============================================================================
// @workspace/agentic-session — Headless agentic session convenience
// =============================================================================

// --- HeadlessSession ---
export { HeadlessSession, HeadlessTimeoutError } from "./headless-session.js";
export type { HeadlessSessionConfig, HeadlessWithAgentConfig, SessionSnapshot } from "./headless-session.js";

// --- Prompts ---
export { HEADLESS_SYSTEM_PROMPT, HEADLESS_NO_EVAL_PROMPT } from "./prompts.js";

// --- Channel Helpers ---
export {
  getRecommendedHarnessConfig,
  getRecommendedChannelConfig,
  subscribeHeadlessAgent,
} from "./channel.js";
export type { SubscribeHeadlessAgentOptions } from "./channel.js";

// --- SandboxConfig Factories (worker + Node) ---
export {
  createWorkerSandboxConfig,
  createNodeSandboxConfig,
} from "./sandbox-factory.js";

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
