/**
 * Event Filtering Utility
 *
 * Shared event filtering logic used by both Electron and DO runtimes
 * to ensure consistent behavior when filtering the event stream.
 *
 * This was extracted from the client.ts shouldYieldEvent logic to
 * provide identical filtering in both runtime modes.
 */

import type { Participant } from "@natstack/pubsub";
import type {
  AgenticParticipantMetadata,
  EventStreamItem,
  IncomingEvent,
} from "@natstack/agentic-messaging";

/**
 * Context needed for event filtering decisions.
 */
export interface EventFilterContext<M extends AgenticParticipantMetadata = AgenticParticipantMetadata> {
  /**
   * Only yield message events where `at` includes this client's ID,
   * or `at` is undefined (broadcast).
   */
  targetedOnly?: boolean;

  /**
   * When targetedOnly is true, also yield non-targeted messages if this client
   * is the only non-panel participant in the channel.
   */
  respondWhenSolo?: boolean;

  /**
   * Include ephemeral events (default: false).
   */
  includeEphemeral?: boolean;

  /**
   * Skip replay events (default: false).
   */
  skipReplay?: boolean;

  /**
   * This client's handle (for @-mention matching).
   */
  selfHandle: string;

  /**
   * This client's ID (for @-mention matching in `at` array).
   */
  selfId?: string | null;

  /**
   * Current roster for respondWhenSolo check.
   */
  roster: Record<string, Participant<M>>;
}

/**
 * Type guard to check if an event has the IncomingEvent shape (has 'kind' field).
 */
function isIncomingEvent(event: EventStreamItem): event is IncomingEvent {
  return "kind" in event;
}

/**
 * Check if an event is an agent-debug event (UI-only, should be skipped by agents).
 * These events are used for debugging agent state in the UI panel.
 */
export function isAgentDebugEvent(event: EventStreamItem): boolean {
  return isIncomingEvent(event) && event.type === "agent-debug";
}

/**
 * Check if this client is the only non-panel participant in the channel.
 */
function isSoloResponder<M extends AgenticParticipantMetadata>(
  roster: Record<string, Participant<M>>,
  selfId: string | null | undefined
): boolean {
  if (!selfId) return false;

  for (const [participantId, participant] of Object.entries(roster)) {
    if (participantId === selfId) continue;

    const meta = participant.metadata as Record<string, unknown>;
    if (meta["type"] !== "panel") {
      // Found another non-panel participant
      return false;
    }
  }

  return true;
}

/**
 * Determine if an event should be yielded based on filter options.
 *
 * This is the core filtering logic shared between Electron and DO runtimes.
 * It ensures both runtimes have identical event filtering behavior.
 *
 * @param event - The event to check
 * @param ctx - Filter context with options and roster
 * @returns true if the event should be yielded to the agent
 *
 * @example
 * ```typescript
 * // In runtime event loop:
 * for await (const event of eventSource) {
 *   if (!shouldYieldEvent(event, filterContext)) {
 *     continue; // Skip filtered events
 *   }
 *   await agent.onEvent(event);
 * }
 * ```
 */
export function shouldYieldEvent<M extends AgenticParticipantMetadata = AgenticParticipantMetadata>(
  event: EventStreamItem,
  ctx: EventFilterContext<M>
): boolean {
  // Only apply filtering to events that have the IncomingEvent shape
  if (!isIncomingEvent(event)) {
    // Aggregated events (from replay) - always yield
    return true;
  }

  // Skip ephemeral events unless opted in
  if (event.kind === "ephemeral" && !ctx.includeEphemeral) {
    return false;
  }

  // Skip replay events if configured
  if (event.kind === "replay" && ctx.skipReplay) {
    return false;
  }

  // Only filter "message" type events - always yield other event types
  if (event.type !== "message") {
    return true;
  }

  // If targetedOnly is not set, yield all messages
  if (!ctx.targetedOnly) {
    return true;
  }

  // If `at` is undefined or empty, it's a broadcast - always yield
  if (!event.at || event.at.length === 0) {
    return true;
  }

  // If `at` includes this client's ID, yield
  if (ctx.selfId && event.at.includes(ctx.selfId)) {
    return true;
  }

  // respondWhenSolo: yield if we're the only non-panel participant
  if (ctx.respondWhenSolo && isSoloResponder(ctx.roster, ctx.selfId)) {
    return true;
  }

  // Event is targeted at someone else
  return false;
}

/**
 * Options for configuring the event stream (from agent.getEventsOptions).
 * This mirrors EventStreamOptions from agentic-messaging.
 */
export interface EventStreamFilterOptions {
  /**
   * Only yield message events where `at` includes this client's ID,
   * or `at` is undefined (broadcast).
   */
  targetedOnly?: boolean;

  /**
   * When targetedOnly is true, also yield non-targeted messages if this client
   * is the only non-panel participant in the channel.
   */
  respondWhenSolo?: boolean;

  /**
   * Include replay events in the stream.
   */
  includeReplay?: boolean;

  /**
   * Include ephemeral events in the stream.
   */
  includeEphemeral?: boolean;
}

/**
 * Convert agent's EventStreamOptions to EventFilterContext.
 *
 * @param options - Agent's event stream options
 * @param selfHandle - This client's handle
 * @param selfId - This client's ID
 * @param roster - Current roster
 * @returns Filter context for shouldYieldEvent
 */
export function createFilterContext<M extends AgenticParticipantMetadata = AgenticParticipantMetadata>(
  options: EventStreamFilterOptions | undefined,
  selfHandle: string,
  selfId: string | null | undefined,
  roster: Record<string, Participant<M>>
): EventFilterContext<M> {
  return {
    targetedOnly: options?.targetedOnly,
    respondWhenSolo: options?.respondWhenSolo,
    includeEphemeral: options?.includeEphemeral,
    skipReplay: options?.includeReplay === false,
    selfHandle,
    selfId,
    roster,
  };
}
