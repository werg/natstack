/**
 * Message Queue Utilities
 *
 * Shared utilities for managing message queues with position tracking.
 * Used by responder workers to handle message interleaving with proper
 * queue position indicators for users.
 */

import { AsyncQueue } from "./async-queue.js";
import type { TypingTracker } from "./responder-utils.js";

/**
 * Base interface for queued messages.
 * Extend this with your own message-specific fields.
 */
export interface QueuedMessageBase {
  /** Timestamp when the message was enqueued */
  enqueuedAt: number;
}

/**
 * MessageQueue - FIFO queue with inspection capability for managing queued messages.
 *
 * Combines the async iteration capability of AsyncQueue with inspection of pending
 * items for queue position tracking. This allows showing users their position in
 * the queue while messages wait to be processed.
 *
 * @example
 * ```typescript
 * interface MyMessage extends QueuedMessageBase {
 *   content: string;
 *   replyTo: string;
 * }
 *
 * const queue = new MessageQueue<MyMessage>();
 *
 * // Producer - enqueue messages
 * queue.enqueue({ content: "hello", replyTo: "msg-1", enqueuedAt: Date.now() });
 *
 * // Consumer - process messages sequentially
 * for await (const msg of queue) {
 *   queue.dequeue(); // Remove from pending array
 *   await processMessage(msg);
 * }
 * ```
 */
export class MessageQueue<T extends QueuedMessageBase> implements AsyncIterable<T> {
  private queue = new AsyncQueue<T>();
  private _pending: T[] = [];

  /**
   * Add a message to the queue.
   * The message is immediately available for async iteration and
   * added to the pending array for inspection.
   */
  enqueue(msg: T): void {
    this._pending.push(msg);
    this.queue.push(msg);
  }

  /**
   * Remove the first message from the pending array.
   * Call this after receiving a message from the async iterator.
   */
  dequeue(): void {
    this._pending.shift();
  }

  /**
   * Get the current pending messages (read-only view).
   * Useful for updating queue position indicators.
   */
  get pending(): readonly T[] {
    return this._pending;
  }

  /**
   * Get the number of pending messages.
   */
  get length(): number {
    return this._pending.length;
  }

  /**
   * Close the queue. No more messages can be enqueued,
   * and async iteration will complete after draining.
   */
  close(): void {
    this.queue.close();
  }

  /**
   * Check if the queue is closed.
   */
  get isClosed(): boolean {
    return this.queue.isClosed;
  }

  /**
   * Async iterator for consuming messages.
   */
  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this.queue[Symbol.asyncIterator]();
  }
}

/**
 * Options for creating queue position text.
 */
export interface QueuePositionTextOptions {
  /** Number of messages currently in the queue (including the one about to be added) */
  queueLength: number;
  /** Whether a message is currently being processed */
  isProcessing: boolean;
  /** Text to show when waiting for another message to finish (default: "queued, waiting...") */
  waitingText?: string;
  /** Text to show when nothing is being processed (default: "preparing response") */
  preparingText?: string;
}

/**
 * Generate user-friendly text for queue position indicators.
 *
 * Returns appropriate text based on whether a message is being processed
 * and the queue position:
 * - If not processing: "preparing response" (or custom preparingText)
 * - If processing and position 0: "queued, waiting..." (or custom waitingText)
 * - If processing and position > 0: "queued (position X)"
 *
 * @example
 * ```typescript
 * // Message is next in line
 * createQueuePositionText({ queueLength: 0, isProcessing: true })
 * // => "queued, waiting..."
 *
 * // Message is 3rd in queue (2 ahead of it)
 * createQueuePositionText({ queueLength: 2, isProcessing: true })
 * // => "queued (position 3)"
 *
 * // No message processing, about to start
 * createQueuePositionText({ queueLength: 0, isProcessing: false })
 * // => "preparing response"
 * ```
 */
export function createQueuePositionText(options: QueuePositionTextOptions): string {
  const {
    queueLength,
    isProcessing,
    waitingText = "queued, waiting...",
    preparingText = "preparing response",
  } = options;

  if (!isProcessing) {
    return preparingText;
  }

  if (queueLength === 0) {
    return waitingText;
  }

  // Position is queue length + 1 (accounting for the currently processing message)
  return `queued (position ${queueLength + 1})`;
}

/**
 * Drain pending messages for interleaving, cleaning up their typing trackers.
 *
 * Handles the common pattern across all three responder agents:
 * 1. Iterate pending items and clean up their per-message typing trackers
 * 2. Remove them from the queuedMessages map
 * 3. Return the pending items and the last message ID (for replyTo update)
 *
 * @param pending - Array of pending messages (from queue.takePending())
 * @param queuedMessages - Map of message ID → entry with a `typingTracker` field
 * @returns The pending items and the last message ID, or null if empty
 */
export async function drainForInterleave<T extends { id: string }>(
  pending: T[],
  queuedMessages: Map<string, { typingTracker: TypingTracker }>,
): Promise<{ pending: T[]; lastMessageId: string | null }> {
  let lastMessageId: string | null = null;
  for (const p of pending) {
    const info = queuedMessages.get(p.id);
    if (info) {
      await info.typingTracker.cleanup();
      queuedMessages.delete(p.id);
    }
    lastMessageId = p.id;
  }
  return { pending, lastMessageId };
}

/**
 * Clean up typing indicators for all queued messages that were never processed.
 *
 * Call this in `onSleep()` to ensure no orphaned typing indicators remain
 * when the agent shuts down with messages still in the queue.
 *
 * @param queuedMessages - Map of message ID → entry with a `typingTracker` field
 * @param log - Optional warning logger for cleanup failures
 *
 * @example
 * ```typescript
 * async onSleep() {
 *   this.queue.stop();
 *   await this.queue.drain();
 *   await cleanupQueuedTypingTrackers(this.queuedMessages, (msg) => this.log.warn(msg));
 * }
 * ```
 */
export async function cleanupQueuedTypingTrackers(
  queuedMessages: Map<string, { typingTracker: TypingTracker }>,
  log?: (message: string) => void,
): Promise<void> {
  for (const [msgId, entry] of queuedMessages) {
    try {
      await entry.typingTracker.cleanup();
    } catch (err) {
      log?.(`Failed to cleanup typing tracker for queued message ${msgId}: ${err}`);
    }
  }
  queuedMessages.clear();
}
