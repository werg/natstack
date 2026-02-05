/**
 * Tracker Manager Pattern
 *
 * Provides a unified manager for typing, thinking, and action trackers.
 * Simplifies cleanup and provides consistent tracking across agent implementations.
 */

import {
  createTypingTracker,
  createThinkingTracker,
  createActionTracker,
  type TypingTracker,
  type ThinkingTracker,
  type ActionTracker,
  type AgenticClient,
  type AgenticParticipantMetadata,
} from "@natstack/agentic-messaging";

/**
 * Options for creating a tracker manager.
 */
export interface TrackerManagerOptions {
  /**
   * Agentic client for sending tracker messages.
   */
  client: AgenticClient<AgenticParticipantMetadata>;

  /**
   * Message ID to use as replyTo for all trackers.
   */
  replyTo?: string;

  /**
   * Sender information for typing indicators.
   */
  senderInfo?: {
    senderId: string;
    senderName?: string;
    senderType?: string;
  };

  /**
   * Logger function for debug output.
   */
  log?: (message: string) => void;
}

/**
 * Tracker manager interface providing unified access to all trackers.
 */
export interface TrackerManager {
  /** Typing indicator tracker (ephemeral) */
  typing: TypingTracker;

  /** Thinking/reasoning message tracker */
  thinking: ThinkingTracker;

  /** Action/tool-use message tracker */
  action: ActionTracker;

  /**
   * Set the replyTo message ID for all trackers.
   * Call this at the start of each message handling to associate
   * tracker messages with the incoming message.
   *
   * @param id - Message ID to reply to
   */
  setReplyTo(id: string | undefined): void;

  /**
   * Cleanup all trackers at once.
   * Call this in error handlers or when processing completes.
   *
   * @returns true if all cleanups succeeded
   */
  cleanupAll(): Promise<boolean>;
}

/**
 * Create a tracker manager for unified tracker access.
 *
 * The tracker manager wraps the individual typing, thinking, and action
 * trackers from agentic-messaging, providing:
 * - Unified configuration (same replyTo, client, logger)
 * - Batch cleanup via cleanupAll()
 * - Convenient access to all three trackers
 *
 * @example
 * ```typescript
 * const trackers = createTrackerManager({
 *   client: ctx.client,
 *   replyTo: event.id,
 *   senderInfo: {
 *     senderId: ctx.client.clientId ?? '',
 *     senderName: 'My Agent',
 *     senderType: 'agent',
 *   },
 * });
 *
 * try {
 *   await trackers.typing.startTyping('preparing response');
 *
 *   // Process and show thinking
 *   await trackers.thinking.startThinking();
 *   await trackers.thinking.updateThinking('analyzing...');
 *   await trackers.thinking.endThinking();
 *
 *   // Show action indicator
 *   await trackers.action.startAction({
 *     type: 'Read',
 *     description: 'Reading file.ts',
 *   });
 *   await trackers.action.completeAction();
 *
 * } catch (err) {
 *   await trackers.cleanupAll();
 *   throw err;
 * }
 * ```
 */
export function createTrackerManager(options: TrackerManagerOptions): TrackerManager {
  const { client, replyTo, senderInfo, log } = options;

  // Create individual trackers with shared configuration
  const typing = createTypingTracker({
    client,
    replyTo,
    senderInfo,
    log,
  });

  const thinking = createThinkingTracker({
    client,
    replyTo,
    log,
  });

  const action = createActionTracker({
    client,
    replyTo,
    log,
  });

  return {
    typing,
    thinking,
    action,

    setReplyTo(id: string | undefined): void {
      typing.setReplyTo(id);
      thinking.setReplyTo(id);
      action.setReplyTo(id);
    },

    async cleanupAll(): Promise<boolean> {
      const results = await Promise.all([
        typing.cleanup(),
        thinking.cleanup(),
        action.cleanup(),
      ]);

      return results.every((r) => r);
    },
  };
}
