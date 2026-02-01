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
 */

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
  // Lifecycle
  // ==================

  /**
   * Cleanup and reset state.
   * Aborts any current operation and resets pause state.
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
 */
export function createInterruptController(): InterruptController {
  let paused = false;
  let currentAbortController: AbortController | null = null;

  const pauseHandlers = new Set<() => void>();
  const resumeHandlers = new Set<() => void>();

  return {
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

    // Lifecycle
    cleanup(): void {
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
}
