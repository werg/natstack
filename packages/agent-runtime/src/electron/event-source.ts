/**
 * Electron Event Source
 *
 * Internal module that handles event reception in Electron runtime.
 * Subscribes to WebSocket events and calls agent.onEvent() for each.
 *
 * This is separate from the EventBus (which handles outgoing operations)
 * because event reception is fundamentally different between runtimes:
 * - Electron: Pull model (WebSocket subscription)
 * - DO: Push model (HTTP POST from pubsub server)
 *
 * The abstraction allows agents to implement onEvent() without caring
 * about how events are sourced.
 */

import type {
  AgenticClient,
  AgenticParticipantMetadata,
  EventStreamItem,
  EventStreamOptions,
} from "@natstack/agentic-messaging";
import type { Agent } from "../agent.js";
import type { AgentLogger } from "../agent.js";
import { shouldYieldEvent, createFilterContext, isAgentDebugEvent } from "../abstractions/event-filter.js";

/**
 * Options for creating an event source.
 */
export interface EventSourceOptions {
  /** Event stream options from agent.getEventsOptions() */
  eventsOptions?: EventStreamOptions;

  /** Callback when checkpoint should advance */
  onCheckpointAdvance?: (pubsubId: number) => void;

  /** Callback to mark agent as active */
  onActivity?: () => void;

  /** Logger for errors */
  log: AgentLogger;
}

/**
 * Start the Electron event source.
 *
 * This subscribes to the client's event stream and delivers events
 * to the agent's onEvent() method with:
 * - Event filtering (targetedOnly, ephemeral, replay)
 * - Auto-checkpoint after delivery
 * - Error handling (logged, not thrown)
 *
 * The event loop runs until the client disconnects or an error occurs.
 *
 * @param client - Connected AgenticClient
 * @param agent - Agent instance to deliver events to
 * @param options - Event source options
 * @returns Promise that resolves when event loop ends
 */
export async function startEventSource<M extends AgenticParticipantMetadata>(
  client: AgenticClient<M>,
  agent: Agent<any, M>,
  options: EventSourceOptions
): Promise<void> {
  const { eventsOptions, onCheckpointAdvance, onActivity, log } = options;

  // Get filter context for event filtering
  const getFilterContext = () =>
    createFilterContext(
      eventsOptions,
      client.handle,
      client.clientId,
      client.roster
    );

  try {
    for await (const event of client.events(eventsOptions)) {
      // Skip agent-debug events - they're UI-only
      if (isAgentDebugEvent(event)) {
        continue;
      }

      // Mark activity for lifecycle management
      onActivity?.();

      // Build filter context (roster may have changed)
      const filterCtx = getFilterContext();

      // Check if event passes filters
      const shouldProcess = shouldYieldEvent(event, filterCtx);

      if (shouldProcess) {
        // Fire and forget - let agent control queueing/serialization
        void Promise.resolve(agent.onEvent(event)).catch((err) => {
          const error = err instanceof Error ? err : new Error(String(err));
          log.error("Error in onEvent:", error.message);
        });
      }

      // Auto-checkpoint: advance for all persisted events we've seen
      // (whether processed or filtered - we received them)
      if (
        "kind" in event &&
        event.kind === "persisted" &&
        event.pubsubId !== undefined
      ) {
        onCheckpointAdvance?.(event.pubsubId);
      }
    }
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    log.error("Event loop error:", error.message);
    throw err;
  }
}

/**
 * Create a non-blocking event source that runs in the background.
 *
 * Unlike startEventSource, this returns immediately and runs the
 * event loop asynchronously. Useful when you need to start the loop
 * but continue with other setup.
 *
 * @param client - Connected AgenticClient
 * @param agent - Agent instance to deliver events to
 * @param options - Event source options
 * @returns Object with stop() method and done promise
 */
export function createEventSource<M extends AgenticParticipantMetadata>(
  client: AgenticClient<M>,
  agent: Agent<any, M>,
  options: EventSourceOptions
): {
  /** Stop the event source (closes client) */
  stop(): Promise<void>;
  /** Promise that resolves when event loop ends */
  done: Promise<void>;
} {
  // Start the event loop
  const done = startEventSource(client, agent, options);

  return {
    async stop() {
      await client.close();
    },
    done,
  };
}
