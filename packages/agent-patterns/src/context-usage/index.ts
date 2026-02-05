/**
 * Context Usage Pattern
 *
 * Provides tracking of token/context window usage across agent sessions.
 * Use alongside MissedContextManager (which handles reconnection context)
 * for complete context management.
 */

// Implementation lives here in agent-patterns
export {
  createContextTracker,
  getModelContextLimit,
  MODEL_CONTEXT_LIMITS,
  type ContextTracker,
  type ContextTrackerOptions,
  type ContextTrackerState,
} from "./context-tracker.js";

// Data types come from agentic-messaging (used in metadata)
export type {
  ContextWindowUsage,
  NormalizedUsage,
  TokenUsage,
} from "@natstack/agentic-messaging";
