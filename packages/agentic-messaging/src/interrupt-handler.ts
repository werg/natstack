/**
 * Interrupt handler for agent execution.
 *
 * Monitors for RPC pause method calls and provides interrupt state.
 * Used by responder workers to support user interruption.
 */

import type { AgenticClient, AgenticParticipantMetadata, EventStreamItem } from "./types.js";

export interface InterruptHandlerOptions<T extends AgenticParticipantMetadata = AgenticParticipantMetadata> {
  client: AgenticClient<T>;
  messageId: string;
  onPause?: (reason: string) => void | Promise<void>;
}

/**
 * Creates an interrupt monitor for agent execution.
 *
 * Monitors for RPC pause method calls and provides interrupt state.
 * The monitor runs concurrently with the main execution loop and can be checked
 * via isPaused() to determine when to stop processing.
 *
 * @param options - Configuration for the interrupt handler
 * @returns Object with monitor task, status check, and cleanup function
 *
 * @example
 * ```typescript
 * const handler = createInterruptHandler({
 *   client,
 *   messageId: userMessageId,
 *   onPause: async (reason) => {
 *     console.log(`Interrupted: ${reason}`);
 *     if (queryInstance) await queryInstance.interrupt();
 *   }
 * });
 *
 * // Start monitoring in background
 * void handler.monitor();
 *
 * // In main loop, check if paused
 * if (handler.isPaused()) {
 *   break; // Stop processing
 * }
 *
 * // On cleanup
 * handler.cleanup();
 * ```
 */
export function createInterruptHandler<T extends AgenticParticipantMetadata = AgenticParticipantMetadata>(
  options: InterruptHandlerOptions<T>
): {
  monitor: () => Promise<void>;
  isPaused: () => boolean;
  cleanup: () => void;
} {
  let paused = false;
  let monitoringActive = true;
  // Keep a reference to the iterator so we can properly close it on cleanup
  let eventIterator: AsyncIterableIterator<EventStreamItem> | null = null;

  const monitor = async () => {
    try {
      const iterator = options.client.events();
      eventIterator = iterator;

      for await (const event of iterator) {
        if (!monitoringActive) break;

        if (event.type === "method-call" && event.methodName === "pause" && !paused) {
          paused = true;
          const args = event.args as Record<string, unknown> | undefined;
          const reason = (args?.["reason"] as string | undefined) || "Execution interrupted";

          // Call user's pause handler
          await options.onPause?.(reason);

          // Publish pause event to UI
          await options.client.publish(
            "execution-pause",
            {
              messageId: options.messageId,
              status: "paused",
              reason,
            },
            { persist: true }
          );

          // Stop listening after pause is handled
          break;
        }
      }
    } catch (err) {
      // Only log unexpected errors (not stream closed errors)
      if (!(err instanceof Error && err.message.includes("closed"))) {
        console.error("[Interrupt Handler] Error:", err);
      }
    } finally {
      eventIterator = null;
    }
  };

  return {
    monitor,
    isPaused: () => paused,
    cleanup: () => {
      monitoringActive = false;
      // Properly close the iterator to unblock any pending await
      // This prevents the monitor from hanging until the next event arrives
      eventIterator?.return?.();
    },
  };
}
