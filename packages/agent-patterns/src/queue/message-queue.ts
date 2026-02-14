/**
 * Message Queue Pattern
 *
 * Provides a message queue with backpressure support for processing
 * events asynchronously. Used by agents to serialize event processing
 * and handle graceful shutdown.
 */

import type { EventStreamItem } from "@natstack/agentic-messaging";

/**
 * Statistics about the queue state.
 */
export interface MessageQueueStats {
  /** Number of events waiting to be processed */
  pending: number;
  /** Whether an event is currently being processed */
  processing: boolean;
  /** Whether the queue has been stopped */
  stopped: boolean;
  /** Whether the queue is paused */
  paused: boolean;
}

/**
 * Options for creating a message queue.
 */
export interface MessageQueueOptions<T extends EventStreamItem = EventStreamItem> {
  /**
   * Callback invoked for each event to process.
   * Events are processed sequentially (one at a time) unless
   * concurrency is increased.
   */
  onProcess: (event: T) => Promise<void>;

  /**
   * Maximum number of events to process concurrently.
   * @default 1
   */
  concurrency?: number;

  /**
   * Callback invoked when an error occurs during processing.
   * If not provided, errors are logged to console.
   */
  onError?: (error: Error, event: T) => void;

  /**
   * Callback invoked before processing each event (for UI updates like queue position).
   * Receives the event and current queue position (0 = first in queue).
   */
  onDequeue?: (event: T, queuePosition: number) => void | Promise<void>;

  /**
   * Callback invoked periodically during long processing operations.
   * Used to emit heartbeat messages to prevent inactivity timeout.
   */
  onHeartbeat?: () => void | Promise<void>;

  /**
   * Interval in milliseconds for heartbeat callbacks during processing.
   * @default 60000 (1 minute)
   */
  heartbeatIntervalMs?: number;

  /**
   * Fires when an item is enqueued while processing is active.
   * Useful for signaling that new messages arrived during an agentic loop.
   */
  onNewItem?: (event: T) => void;
}

/**
 * Message queue interface for agent event processing.
 */
export interface MessageQueue<T extends EventStreamItem = EventStreamItem> {
  /**
   * Add an event to the queue for processing.
   * @param event - The event to enqueue
   * @returns false if the queue is stopped, true otherwise
   */
  enqueue(event: T): boolean;

  /**
   * Wait for all pending events to complete processing.
   * Returns immediately if no events are pending or processing.
   */
  drain(): Promise<void>;

  /**
   * Stop accepting new events.
   * Already enqueued events will continue to be processed.
   * Call drain() after stop() to wait for completion.
   */
  stop(): void;

  /**
   * Get current queue statistics.
   */
  getStats(): MessageQueueStats;

  /**
   * Pause processing (still accepts new events).
   * Events continue to accumulate but won't be processed
   * until resume() is called.
   */
  pause(): void;

  /**
   * Resume processing after pause().
   */
  resume(): void;

  /**
   * Check if the queue is currently paused.
   */
  isPaused(): boolean;

  /**
   * Get the number of pending events in the queue.
   * Useful for queue position tracking in typing indicators.
   */
  getPendingCount(): number;

  /**
   * Check if any event is currently being processed.
   */
  isProcessing(): boolean;

  /**
   * Atomically drain and return all pending items.
   * Items taken this way bypass onDequeue/onProcess — they're consumed
   * directly by the active processor (e.g., for message interleaving).
   */
  takePending(): T[];
}

/**
 * Create a message queue for agent event processing.
 *
 * The queue provides:
 * - Sequential event processing (configurable concurrency)
 * - Backpressure through enqueue() return value
 * - Graceful shutdown via stop() + drain()
 * - Pause/resume for flow control
 *
 * @example
 * ```typescript
 * const queue = createMessageQueue({
 *   onProcess: async (event) => {
 *     if (event.type === 'message') {
 *       await handleMessage(event);
 *     }
 *   },
 *   onError: (err, event) => {
 *     log.error(`Failed to process event ${event.type}:`, err);
 *   },
 * });
 *
 * // In onEvent
 * async onEvent(event: EventStreamItem) {
 *   queue.enqueue(event);
 * }
 *
 * // In onSleep
 * async onSleep() {
 *   queue.stop();
 *   await queue.drain();
 * }
 * ```
 */
export function createMessageQueue<T extends EventStreamItem = EventStreamItem>(options: MessageQueueOptions<T>): MessageQueue<T> {
  const {
    onProcess,
    concurrency = 1,
    onError = (err) => console.error("[MessageQueue] Processing error:", err),
    onDequeue,
    onHeartbeat,
    heartbeatIntervalMs = 60_000,
    onNewItem,
  } = options;

  const pending: T[] = [];
  let activeCount = 0;
  let stopped = false;
  let paused = false;
  let drainResolvers: Array<() => void> = [];

  /**
   * Check if we're done (no pending, no active).
   */
  const checkDrain = () => {
    if (pending.length === 0 && activeCount === 0) {
      const resolvers = drainResolvers;
      drainResolvers = [];
      for (const resolve of resolvers) {
        resolve();
      }
    }
  };

  /**
   * Process the next event if available and under concurrency limit.
   */
  const processNext = async (): Promise<void> => {
    // Don't start new processing if paused
    if (paused) return;

    // Check if we can process more
    if (activeCount >= concurrency) return;
    if (pending.length === 0) return;

    // Get next event - position 0 means first in queue
    const queuePosition = 0;
    const event = pending.shift()!;
    activeCount++;

    // Call onDequeue before processing (for UI updates like queue position)
    if (onDequeue) {
      try {
        await onDequeue(event, queuePosition);
      } catch (err) {
        // Log but don't fail processing if onDequeue fails
        console.error("[MessageQueue] onDequeue error:", err);
      }
    }

    // Start heartbeat if configured
    let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
    if (onHeartbeat) {
      heartbeatInterval = setInterval(() => {
        void (async () => {
          try {
            await onHeartbeat();
          } catch (err) {
            console.error("[MessageQueue] onHeartbeat error:", err);
          }
        })();
      }, heartbeatIntervalMs);
    }

    try {
      await onProcess(event);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      onError(error, event);
    } finally {
      // Clear heartbeat interval
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
      }

      activeCount--;
      checkDrain();

      // Try to process next event
      void processNext();
    }
  };

  return {
    enqueue(event: T): boolean {
      if (stopped) return false;

      pending.push(event);

      // Notify listener when a new item arrives while processing is active
      if (onNewItem && activeCount > 0) {
        try {
          onNewItem(event);
        } catch (err) {
          console.error("[MessageQueue] onNewItem error:", err);
        }
      }

      // Start processing if not paused
      if (!paused) {
        void processNext();
      }

      return true;
    },

    async drain(): Promise<void> {
      // If paused, auto-resume to allow processing to complete
      if (paused) {
        this.resume();
      }

      // If nothing pending or processing, resolve immediately
      if (pending.length === 0 && activeCount === 0) {
        return;
      }

      // Wait for all processing to complete (including active work)
      return new Promise((resolve) => {
        drainResolvers.push(resolve);
      });
    },

    stop(): void {
      stopped = true;
    },

    getStats(): MessageQueueStats {
      return {
        pending: pending.length,
        processing: activeCount > 0,
        stopped,
        paused,
      };
    },

    pause(): void {
      paused = true;
    },

    resume(): void {
      if (!paused) return;

      paused = false;

      // Start processing queued events
      // Fire off up to concurrency workers
      for (let i = activeCount; i < concurrency && pending.length > 0; i++) {
        void processNext();
      }
    },

    isPaused(): boolean {
      return paused;
    },

    getPendingCount(): number {
      return pending.length;
    },

    isProcessing(): boolean {
      return activeCount > 0;
    },

    takePending(): T[] {
      const taken = pending.splice(0, pending.length);
      return taken;
    },
  };
}
