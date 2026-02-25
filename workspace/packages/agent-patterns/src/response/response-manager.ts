/**
 * Response Manager Pattern
 *
 * Handles the common pattern of lazy response message creation,
 * checkpoint commits, and message completion that appears in all agents.
 */

import type { AgenticClient, ChatParticipantMetadata } from "@workspace/agentic-protocol";
import type { TrackerManager } from "../trackers/tracker-manager.js";

/**
 * Options for creating a response manager.
 */
export interface ResponseManagerOptions {
  /** Agentic client for sending messages */
  client: AgenticClient<ChatParticipantMetadata>;
  /** Message ID to reply to */
  replyTo: string;
  /** Pubsub ID for checkpoint commits (from incoming message) */
  pubsubId?: number;
  /** Tracker manager for stopping typing indicator */
  trackers?: TrackerManager;
  /** Callback to commit checkpoint (e.g., this.commitCheckpoint) */
  commitCheckpoint?: (pubsubId: number) => void;
  /** Logger function */
  log?: (msg: string) => void;
}

/**
 * Response manager state and methods.
 */
export interface ResponseManager {
  /**
   * Ensures a response message exists, creating one if needed.
   * Stops typing indicator before creating the message.
   *
   * @param metadata - Optional metadata to attach to the message
   * @returns The message ID
   */
  ensureMessage: (metadata?: Record<string, unknown>) => Promise<string>;

  /**
   * Gets the current response message ID, or null if not created.
   */
  getMessageId: () => string | null;

  /**
   * Commits checkpoint if not already committed.
   * Called automatically on first text content, but can be called manually.
   */
  commitCheckpointIfNeeded: () => void;

  /**
   * Marks the response message as complete.
   * Should be called when streaming is finished.
   */
  complete: () => Promise<void>;

  /**
   * Cleans up if no response was created.
   * Stops typing indicator without creating a message.
   */
  cleanup: () => Promise<void>;

  /**
   * Whether the response message has been created.
   */
  hasMessage: () => boolean;

  /**
   * Whether the checkpoint has been committed.
   */
  isCheckpointCommitted: () => boolean;
}

/**
 * Creates a response manager for handling lazy message creation and checkpoints.
 *
 * The manager handles the common pattern found in all agents:
 * 1. Start with typing indicator
 * 2. Create message lazily when first content arrives
 * 3. Commit checkpoint on first content
 * 4. Complete message when done
 *
 * @example
 * ```typescript
 * const response = createResponseManager({
 *   client: this.client,
 *   replyTo: incoming.id,
 *   pubsubId: incoming.pubsubId,
 *   trackers,
 *   commitCheckpoint: (id) => this.commitCheckpoint(id),
 *   log: (msg) => this.log.debug(msg),
 * });
 *
 * // In streaming loop
 * case "text-delta": {
 *   const msgId = await response.ensureMessage();
 *   await client.update(msgId, event.text);
 *   response.commitCheckpointIfNeeded();
 *   break;
 * }
 *
 * // After streaming
 * await response.complete();
 * ```
 */
export function createResponseManager(options: ResponseManagerOptions): ResponseManager {
  const {
    client,
    replyTo,
    pubsubId,
    trackers,
    commitCheckpoint,
    log = () => {},
  } = options;

  let responseId: string | null = null;
  let checkpointCommitted = false;

  const ensureMessage = async (metadata?: Record<string, unknown>): Promise<string> => {
    // Stop typing indicator when transitioning to real content
    if (trackers?.typing.isTyping()) {
      await trackers.typing.stopTyping();
    }

    if (!responseId) {
      const sendOptions: Parameters<typeof client.send>[1] = { replyTo };
      if (metadata) {
        (sendOptions as { metadata?: Record<string, unknown> }).metadata = metadata;
      }
      const { messageId } = await client.send("", sendOptions);
      responseId = messageId;
      log(`Created response message: ${responseId}`);
    }

    return responseId;
  };

  const commitCheckpointIfNeeded = (): void => {
    if (!checkpointCommitted && pubsubId !== undefined && commitCheckpoint) {
      commitCheckpoint(pubsubId);
      checkpointCommitted = true;
      log(`Committed checkpoint at pubsubId: ${pubsubId}`);
    }
  };

  const complete = async (): Promise<void> => {
    if (responseId) {
      await client.complete(responseId);
      log(`Completed response: ${responseId}`);
    } else {
      // No response was created - cleanup typing indicator
      await cleanup();
      log(`No response content created`);
    }
  };

  const cleanup = async (): Promise<void> => {
    if (trackers?.typing.isTyping()) {
      await trackers.typing.cleanup();
    }
  };

  return {
    ensureMessage,
    getMessageId: () => responseId,
    commitCheckpointIfNeeded,
    complete,
    cleanup,
    hasMessage: () => responseId !== null,
    isCheckpointCommitted: () => checkpointCommitted,
  };
}
