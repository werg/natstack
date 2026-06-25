// =============================================================================
// @workspace/agentic-session — Headless agentic session convenience
// =============================================================================

// --- HeadlessSession ---
export { HeadlessSession } from "./headless-session.js";
export type {
  HeadlessSessionCloseOptions,
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

// --- Re-export Pi-native types from agentic-core for convenience ---
export type {
  ChatMessage,
  ChatParticipantMetadata,
  ConnectionConfig,
  AgentMessage,
  ChatMethodResult,
} from "@workspace/agentic-core";
