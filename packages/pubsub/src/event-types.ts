/**
 * Event stream types for replay aggregation.
 *
 * Re-exports the event stream types from protocol-types for convenience.
 * The EventStreamItem, AggregatedEvent, and isAggregatedEvent are the
 * primary types used by consumers for working with replay events.
 */

// These are defined in protocol-types.ts and re-exported here
// for discoverability and the task specification.
export type {
  EventStreamItem,
  AggregatedEvent,
  AggregatedEventBase,
  AggregatedMessage,
  AggregatedMethodCall,
  AggregatedMethodResult,
} from "./protocol-types.js";

export { isAggregatedEvent } from "./protocol-types.js";
