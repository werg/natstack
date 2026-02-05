export {
  createMissedContextManager,
  type MissedContextManagerOptions,
  type MissedContextManager,
} from "./missed-context.js";

// Re-export formatMissedContext for direct usage if needed
export {
  formatMissedContext,
  aggregateReplayEvents,
  type MissedContext,
  type FormatOptions,
  type AggregatedEvent,
} from "@natstack/agentic-messaging";
