/**
 * Interrupt Controller Pattern
 *
 * Provides pause/resume control for message queues and abort signals
 * for individual operations. Used by agents to support user interruption.
 *
 * Key design decision: AbortSignal cannot be "resumed" after abort.
 * Therefore, the controller provides:
 * - Queue-level pause/resume (affects the message queue)
 * - Per-operation abort signals (new signal per AI call)
 * - Optional pubsub monitoring for pause RPC events
 */

import type { AgenticClient, AgenticParticipantMetadata, EventStreamItem } from "@natstack/agentic-messaging";

/**
 * Options for creating an interrupt controller with pubsub monitoring.
 */
export interface InterruptControllerOptions<T extends AgenticParticipantMetadata = AgenticParticipantMetadata> {
  /**
   * Pubsub client for monitoring pause events.
   * If provided, the controller will automatically listen for pause RPC calls
   * and publish execution-pause events to the UI.
   */
  client?: AgenticClient<T>;

  /**
   * Message ID being processed.
   * Required when client is provided, used for publishing pause status.
   */
  messageId?: string;

  /**
   * Optional callback when pause is triggered via pubsub.
   * Called after internal pause() but before publishing to UI.
   */
  onPubsubPause?: (reason: string) => void | Promise<void>;

  /**
   * Optional logger function.
   */
  log?: (message: string) => void;
}

/**
 * Interrupt controller interface.
 */
export interface InterruptController {
  // ==================
  // Queue Control
  // ==================

  /**
   * Check if processing is paused.
   */
  isPaused(): boolean;

  /**
   * Pause processing.
   * The message queue should stop processing new events.
   * Currently processing events may complete.
   */
  pause(): void;

  /**
   * Resume processing after pause.
   * The message queue should resume processing events.
   */
  resume(): void;

  /**
   * Register a handler to be called when paused.
   * @returns Unsubscribe function
   */
  onPause(handler: () => void): () => void;

  /**
   * Register a handler to be called when resumed.
   * @returns Unsubscribe function
   */
  onResume(handler: () => void): () => void;

  // ==================
  // Operation Abort
  // ==================

  /**
   * Create a new abort signal for an operation.
   * Each AI call should get its own signal.
   * The signal is aborted when abortCurrent() is called.
   *
   * @returns A new AbortSignal linked to this controller
   */
  createAbortSignal(): AbortSignal;

  /**
   * Abort the current operation's signal.
   * Does not affect queue paused state - only the current signal.
   */
  abortCurrent(): void;

  /**
   * Check if the current operation has been aborted.
   */
  isAborted(): boolean;

  // ==================
  // Pubsub Monitoring
  // ==================

  /**
   * Start monitoring pubsub for pause events.
   * Only available when client was provided in options.
   * Call this at the start of message processing.
   * Returns a promise that resolves when monitoring stops (on pause or cleanup).
   */
  startMonitoring(): Promise<void>;

  /**
   * Check if pubsub monitoring is active.
   */
  isMonitoring(): boolean;

  // ==================
  // Lifecycle
  // ==================

  /**
   * Cleanup and reset state.
   * Aborts any current operation, stops monitoring, and resets pause state.
   */
  cleanup(): void;
}

/**
 * Create an interrupt controller for agent operation control.
 *
 * The interrupt controller provides two levels of control:
 *
 * 1. **Queue-level pause/resume**: Affects the message queue.
 *    - Use pause() to stop processing new messages
 *    - Use resume() to continue processing
 *    - Currently processing messages may complete
 *
 * 2. **Operation-level abort**: Affects individual AI calls.
 *    - Call createAbortSignal() before each AI call
 *    - Pass the signal to the AI streaming function
 *    - Call abortCurrent() to cancel the current call
 *
 * NOTE: AbortSignal cannot be "un-aborted". Each AI call needs a fresh
 * signal. The controller manages this by creating new AbortControllers.
 *
 * @example
 * ```typescript
 * const interrupt = createInterruptController();
 *
 * // Connect to message queue
 * const queue = createMessageQueue({
 *   onProcess: (event) => processMessage(event),
 * });
 *
 * interrupt.onPause(() => queue.pause());
 * interrupt.onResume(() => queue.resume());
 *
 * // In message processing
 * async function processMessage(event: EventStreamItem) {
 *   // Check if paused before starting
 *   if (interrupt.isPaused()) {
 *     // Optionally wait for resume or skip
 *     return;
 *   }
 *
 *   // Create fresh signal for this AI call
 *   const signal = interrupt.createAbortSignal();
 *
 *   try {
 *     const stream = ai.streamText({
 *       model: 'claude-3-opus',
 *       prompt: event.content,
 *       signal, // Pass to AI SDK
 *     });
 *
 *     for await (const chunk of stream) {
 *       // Stream chunks...
 *     }
 *   } catch (err) {
 *     if (err.name === 'AbortError') {
 *       // User interrupted - this is expected
 *       console.log('AI call aborted');
 *     } else {
 *       throw err;
 *     }
 *   }
 * }
 *
 * // When user clicks pause/stop
 * function onUserPause() {
 *   interrupt.pause();
 *   interrupt.abortCurrent(); // Cancel current AI call
 * }
 * ```
 *
 * @example With pubsub monitoring (unified pattern)
 * ```typescript
 * const interrupt = createInterruptController({
 *   client: ctx.client,
 *   messageId: incoming.id,
 *   onPubsubPause: async (reason) => {
 *     // Optional: additional pause handling (e.g., SDK interrupt)
 *     await queryInstance?.interrupt();
 *   },
 * });
 *
 * // Wire to queue
 * interrupt.onPause(() => queue.pause());
 * interrupt.onResume(() => queue.resume());
 *
 * // Start monitoring in background (fire and forget)
 * void interrupt.startMonitoring();
 *
 * // Process message...
 * const signal = interrupt.createAbortSignal();
 * // ... AI call with signal ...
 *
 * // Cleanup stops monitoring
 * interrupt.cleanup();
 * ```
 */
export function createInterruptController<T extends AgenticParticipantMetadata = AgenticParticipantMetadata>(
  options?: InterruptControllerOptions<T>
): InterruptController {
  const { client, messageId, onPubsubPause, log } = options ?? {};

  let paused = false;
  let currentAbortController: AbortController | null = null;
  let monitoringActive = false;
  let eventIterator: AsyncIterableIterator<EventStreamItem> | null = null;

  const pauseHandlers = new Set<() => void>();
  const resumeHandlers = new Set<() => void>();

  const controller: InterruptController = {
    // Queue control
    isPaused(): boolean {
      return paused;
    },

    pause(): void {
      if (paused) return;
      paused = true;

      for (const handler of pauseHandlers) {
        try {
          handler();
        } catch (err) {
          console.error("[InterruptController] Pause handler error:", err);
        }
      }
    },

    resume(): void {
      if (!paused) return;
      paused = false;

      for (const handler of resumeHandlers) {
        try {
          handler();
        } catch (err) {
          console.error("[InterruptController] Resume handler error:", err);
        }
      }
    },

    onPause(handler: () => void): () => void {
      pauseHandlers.add(handler);
      return () => pauseHandlers.delete(handler);
    },

    onResume(handler: () => void): () => void {
      resumeHandlers.add(handler);
      return () => resumeHandlers.delete(handler);
    },

    // Operation abort
    createAbortSignal(): AbortSignal {
      // Create new controller (old one may be aborted)
      currentAbortController = new AbortController();
      return currentAbortController.signal;
    },

    abortCurrent(): void {
      if (currentAbortController) {
        currentAbortController.abort();
        // Don't null it - signal may still be checked
      }
    },

    isAborted(): boolean {
      return currentAbortController?.signal.aborted ?? false;
    },

    // Pubsub monitoring
    async startMonitoring(): Promise<void> {
      if (!client) {
        log?.("[InterruptController] No client provided, monitoring not available");
        return;
      }

      if (monitoringActive) {
        log?.("[InterruptController] Monitoring already active");
        return;
      }

      monitoringActive = true;
      log?.("[InterruptController] Starting pause event monitoring");

      try {
        const iterator = client.events();
        eventIterator = iterator;

        for await (const event of iterator) {
          if (!monitoringActive) break;

          // Check if this is a pause method call targeted at us (not another agent in the channel)
          const isTargetedPause = event.type === "method-call" &&
            event.methodName === "pause" &&
            !paused &&
            // Only respond to pause calls targeted at our client (providerId is the target)
            (event.providerId === client.clientId || !event.providerId);

          if (isTargetedPause) {
            const args = event.args as Record<string, unknown> | undefined;
            const reason = (args?.["reason"] as string | undefined) || "Execution interrupted";
            log?.(`[InterruptController] Pause RPC received: ${reason}`);

            // Trigger internal pause
            controller.pause();

            // Abort current operation
            controller.abortCurrent();

            // Call user's pause handler
            await onPubsubPause?.(reason);

            // Publish pause event to UI
            if (messageId) {
              await client.publish(
                "execution-pause",
                {
                  messageId,
                  status: "paused",
                  reason,
                },
                { persist: true }
              );
            }

            // Stop listening after pause is handled
            break;
          }
        }
      } catch (err) {
        // Only log unexpected errors (not stream closed errors)
        if (!(err instanceof Error && err.message.includes("closed"))) {
          console.error("[InterruptController] Monitoring error:", err);
        }
      } finally {
        eventIterator = null;
        monitoringActive = false;
      }
    },

    isMonitoring(): boolean {
      return monitoringActive;
    },

    // Lifecycle
    cleanup(): void {
      // Stop monitoring
      monitoringActive = false;
      eventIterator?.return?.();
      eventIterator = null;

      // Abort any current operation
      if (currentAbortController) {
        currentAbortController.abort();
        currentAbortController = null;
      }

      // Reset pause state (but don't fire handlers)
      paused = false;

      // Clear handlers
      pauseHandlers.clear();
      resumeHandlers.clear();
    },
  };

  return controller;
}
