/**
 * Missed Context Manager Pattern
 *
 * Provides accumulation and formatting of missed messages during
 * reconnection scenarios. Used to provide context to AI models about
 * what happened while the agent was disconnected.
 */

import {
  formatMissedContext,
  type AgenticClient,
  type AgenticParticipantMetadata,
  type MissedContext,
} from "@workspace/agentic-protocol";

/**
 * Options for creating a missed context manager.
 */
export interface MissedContextManagerOptions {
  /**
   * Agentic client for accessing missed messages.
   */
  client: AgenticClient<AgenticParticipantMetadata>;

  /**
   * Maximum characters for formatted context.
   * @default 8000
   */
  maxChars?: number;

  /**
   * Initial pubsub ID to skip events already processed.
   * Events with pubsubId <= sinceId are excluded from missed context.
   * Typically set to the agent's last checkpoint on wake to avoid
   * including messages the agent already processed in a previous session.
   */
  sinceId?: number;

  /**
   * Sender types to exclude from missed context.
   * Messages from these sender types are filtered out.
   * Useful for excluding the agent's own responses (which are already
   * in the AI thread history) to prevent duplication.
   *
   * @example ["pi", "agent"] — exclude agent-sent messages
   */
  excludeSenderTypes?: string[];
}

/**
 * Managed missed context with metadata.
 */
export interface MissedContextResult {
  /** Formatted context string */
  formatted: string;
  /** Number of messages included */
  count: number;
  /** Last pubsub ID included (for checkpoint tracking) */
  lastPubsubId: number;
}

/**
 * Missed context manager interface.
 */
export interface MissedContextManager {
  /**
   * Get the current missed context.
   * Returns null if no missed context is available.
   */
  get(): MissedContextResult | null;

  /**
   * Rebuild missed context from client.
   * Call this after reconnection to refresh the context.
   */
  rebuild(): void;

  /**
   * Get and clear the missed context.
   * Use this when including context in a prompt.
   *
   * @returns The formatted context string, or null if none
   */
  consume(): string | null;

  /**
   * Check if there is pending missed context.
   */
  hasPending(): boolean;
}

/**
 * Create a missed context manager for reconnection scenarios.
 *
 * The missed context manager accumulates messages that arrived while
 * the agent was disconnected, formats them for inclusion in prompts,
 * and tracks the last processed pubsub ID for checkpoint updates.
 *
 * @example
 * ```typescript
 * const missedCtx = createMissedContextManager({
 *   client: ctx.client,
 *   maxChars: 8000,
 * });
 *
 * // On reconnect
 * ctx.client.onReconnect(() => {
 *   missedCtx.rebuild();
 * });
 *
 * // When processing a message
 * async processMessage(event: EventStreamItem) {
 *   let prompt = event.content;
 *
 *   // Include missed context if available
 *   const context = missedCtx.consume();
 *   if (context) {
 *     prompt = `<missed_context>\n${context}\n</missed_context>\n\n${prompt}`;
 *   }
 *
 *   await handlePrompt(prompt);
 * }
 * ```
 */
export function createMissedContextManager(
  options: MissedContextManagerOptions
): MissedContextManager {
  const { client, maxChars = 8000, sinceId, excludeSenderTypes } = options;

  let lastProcessedPubsubId = sinceId ?? 0;
  let pendingContext: MissedContext | null = null;
  let hasMissedFlag = false;

  /**
   * Build context from missed messages since last processed.
   */
  const buildContext = (): MissedContext | null => {
    let missed = client.missedMessages.filter(
      (event) => event.pubsubId > lastProcessedPubsubId
    );

    if (excludeSenderTypes && excludeSenderTypes.length > 0) {
      missed = missed.filter(
        (event) => !event.senderType || !excludeSenderTypes.includes(event.senderType)
      );
    }

    if (missed.length === 0) return null;

    return formatMissedContext(missed, { maxChars });
  };

  return {
    get(): MissedContextResult | null {
      if (!pendingContext || pendingContext.count === 0) {
        return null;
      }

      return {
        formatted: pendingContext.formatted,
        count: pendingContext.count,
        lastPubsubId: pendingContext.lastPubsubId,
      };
    },

    rebuild(): void {
      pendingContext = buildContext();
      hasMissedFlag = pendingContext !== null && pendingContext.count > 0;
    },

    consume(): string | null {
      // Build fresh if not already built
      if (!pendingContext) {
        pendingContext = buildContext();
      }

      if (!pendingContext || pendingContext.count === 0) {
        return null;
      }

      // Update last processed and clear pending
      lastProcessedPubsubId = pendingContext.lastPubsubId;
      const formatted = pendingContext.formatted;
      pendingContext = null;
      hasMissedFlag = false;

      return formatted;
    },

    hasPending(): boolean {
      if (pendingContext) {
        return pendingContext.count > 0;
      }
      // Use cached flag — missedMessages is only populated during reconnection
      // replay, so it doesn't grow between consume() and rebuild() cycles.
      return hasMissedFlag;
    },
  };
}
