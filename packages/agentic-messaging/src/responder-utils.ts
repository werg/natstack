/**
 * Shared utilities for AI responder workers.
 *
 * These utilities provide common functionality used across different
 * responder implementations (Claude Code, Codex, etc.).
 */

import type { AgenticParticipantMetadata, IncomingNewMessage } from "./types.js";

/**
 * Standard participant metadata for chat-style channels.
 * Used by responder workers and panels to identify participant types.
 */
export interface ChatParticipantMetadata extends AgenticParticipantMetadata {
  name: string;
  type: "panel" | "ai-responder" | "claude-code" | "codex";
}

/**
 * Safely parse AGENT_CONFIG from environment.
 * Returns empty object if parsing fails or config is invalid.
 */
export function parseAgentConfig(): Record<string, unknown> {
  const raw = process.env["AGENT_CONFIG"];
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Create a prefixed logger function for responder workers.
 * @param prefix - The prefix to include in log messages (e.g., "Claude Code", "Codex")
 * @param workerId - Optional worker ID to include in logs
 */
export function createLogger(prefix: string, workerId?: string): (message: string) => void {
  const idPart = workerId ? ` ${workerId}` : "";
  return (message: string) => console.log(`[${prefix}${idPart}] ${message}`);
}

/**
 * Format arguments for logging, handling circular references and truncating long output.
 * @param args - The arguments to format
 * @param maxLen - Maximum length of the output string (default: 2000)
 */
export function formatArgsForLog(args: unknown, maxLen = 2000): string {
  const seen = new WeakSet();
  const serialized = JSON.stringify(
    args,
    (_key, value) => {
      if (typeof value === "object" && value !== null) {
        if (seen.has(value as object)) return "[Circular]";
        seen.add(value as object);
      }
      return value;
    },
    2
  );
  if (!serialized) return "<empty>";
  return serialized.length > maxLen ? `${serialized.slice(0, maxLen)}...` : serialized;
}

/**
 * Check if a message is targeted at a specific participant.
 * Returns true if:
 * - `at` is undefined or empty (broadcast to all)
 * - `at` includes the given participantId
 */
export function isMessageTargetedAt(msg: IncomingNewMessage, participantId: string): boolean {
  if (!msg.at || msg.at.length === 0) return true;
  return msg.at.includes(participantId);
}

/**
 * Content type constant for thinking/reasoning messages.
 * Use this when sending messages with `contentType` to ensure consistency.
 */
export const CONTENT_TYPE_THINKING = "thinking" as const;

/**
 * Content type constant for action messages.
 * Actions represent active agent operations (reading files, running commands, etc.)
 */
export const CONTENT_TYPE_ACTION = "action" as const;

/**
 * Action data structure sent as message content (JSON stringified).
 */
export interface ActionData {
  /** Action type identifier (e.g., "Read", "Edit", "Bash", "Grep") */
  type: string;
  /** Brief description of the action (e.g., "Reading src/index.ts") */
  description: string;
  /** Tool use ID for correlation with method calls */
  toolUseId?: string;
  /** Action status */
  status: "pending" | "complete";
}

/**
 * Interface for the client methods needed by trackers.
 * This allows trackers to work with any AgenticClient implementation.
 */
export interface TrackerClient {
  send(content: string, options?: { replyTo?: string; contentType?: string; persist?: boolean }): Promise<{ messageId: string }>;
  update(
    messageId: string,
    content: string,
    options?: { complete?: boolean; persist?: boolean; contentType?: string }
  ): Promise<void>;
  complete(messageId: string): Promise<void>;
}

/**
 * State managed by the thinking tracker.
 */
export interface ThinkingTrackerState {
  /** Current content type being streamed */
  currentContentType: "thinking" | "text" | null;
  /** Message ID for the current thinking message, if any */
  thinkingMessageId: string | null;
  /** Item ID for the current thinking block (for Codex SDK) */
  thinkingItemId: string | null;
}

/**
 * Options for creating a thinking tracker.
 */
export interface ThinkingTrackerOptions {
  /** Client to use for sending/updating messages */
  client: TrackerClient;
  /** Logger function for debug output */
  log?: (message: string) => void;
  /** Message ID to use as replyTo for thinking messages */
  replyTo?: string;
}

/**
 * ThinkingTracker manages the state of thinking/reasoning messages.
 *
 * This utility provides a consistent way to handle thinking content across
 * different responder implementations (Claude Code, Codex, pubsub-chat).
 *
 * It handles:
 * - Starting new thinking messages with proper contentType
 * - Streaming thinking content
 * - Completing thinking messages when transitioning to text
 * - Cleaning up orphaned thinking messages on error
 *
 * @example
 * ```typescript
 * const tracker = createThinkingTracker({ client, log, replyTo: incoming.id });
 *
 * // When thinking starts
 * await tracker.startThinking();
 *
 * // When thinking content arrives
 * await tracker.updateThinking("some reasoning...");
 *
 * // When transitioning to text
 * await tracker.endThinking();
 *
 * // In catch block
 * } catch (err) {
 *   await tracker.cleanup();
 *   // ... handle error
 * }
 * ```
 */
export interface ThinkingTracker {
  /** Current state of the tracker */
  readonly state: ThinkingTrackerState;

  /**
   * Start a new thinking message.
   * @param itemId - Optional item ID for tracking (used by Codex SDK)
   * @returns The message ID of the created thinking message
   */
  startThinking(itemId?: string): Promise<string>;

  /**
   * Update the current thinking message with new content.
   * @param content - Content to append to the thinking message
   */
  updateThinking(content: string): Promise<void>;

  /**
   * End the current thinking message and transition to text mode.
   * Safe to call even if not currently in thinking mode.
   */
  endThinking(): Promise<void>;

  /**
   * Check if we're currently in thinking mode.
   */
  isThinking(): boolean;

  /**
   * Check if an item ID matches the current thinking item.
   * Useful for Codex SDK where items have unique IDs.
   */
  isThinkingItem(itemId: string): boolean;

  /**
   * Set the current content type to text (without ending thinking).
   * Use this when starting text output that doesn't follow thinking.
   */
  setTextMode(): void;

  /**
   * Cleanup any pending thinking message.
   * Call this in error handlers to ensure thinking messages are completed.
   * @returns true if cleanup succeeded or no cleanup was needed, false if cleanup failed
   */
  cleanup(): Promise<boolean>;
}

/**
 * Create a ThinkingTracker for managing thinking/reasoning message state.
 */
export function createThinkingTracker(options: ThinkingTrackerOptions): ThinkingTracker {
  const { client, log = () => {}, replyTo } = options;

  const state: ThinkingTrackerState = {
    currentContentType: null,
    thinkingMessageId: null,
    thinkingItemId: null,
  };

  return {
    get state() {
      return state;
    },

    async startThinking(itemId?: string): Promise<string> {
      // End any existing thinking message first
      if (state.thinkingMessageId) {
        await this.endThinking();
      }

      const { messageId } = await client.send("", {
        replyTo,
        contentType: CONTENT_TYPE_THINKING,
      });

      state.thinkingMessageId = messageId;
      state.currentContentType = "thinking";
      state.thinkingItemId = itemId ?? null;

      log(`Started thinking message: ${messageId}`);
      return messageId;
    },

    async updateThinking(content: string): Promise<void> {
      if (state.thinkingMessageId && content) {
        await client.update(state.thinkingMessageId, content);
      }
    },

    async endThinking(): Promise<void> {
      if (state.thinkingMessageId) {
        await client.complete(state.thinkingMessageId);
        log(`Completed thinking message: ${state.thinkingMessageId}`);
        state.thinkingMessageId = null;
        state.thinkingItemId = null;
      }
      state.currentContentType = null;
    },

    isThinking(): boolean {
      return state.currentContentType === "thinking";
    },

    isThinkingItem(itemId: string): boolean {
      return state.thinkingItemId === itemId;
    },

    setTextMode(): void {
      state.currentContentType = "text";
    },

    async cleanup(): Promise<boolean> {
      // Complete any pending thinking message to avoid orphaned messages
      if (state.thinkingMessageId) {
        const messageId = state.thinkingMessageId;
        state.thinkingMessageId = null;
        state.thinkingItemId = null;
        state.currentContentType = null;
        try {
          await client.complete(messageId);
          log(`Cleanup: completed orphaned thinking message: ${messageId}`);
          return true;
        } catch (err) {
          log(`Cleanup: failed to complete thinking message ${messageId}: ${err}`);
          return false;
        }
      }
      state.currentContentType = null;
      return true;
    },
  };
}

/**
 * State managed by the action tracker.
 */
export interface ActionTrackerState {
  /** Current action message ID, if any */
  actionMessageId: string | null;
  /** Current action data */
  currentAction: ActionData | null;
}

/**
 * Options for creating an action tracker.
 */
export interface ActionTrackerOptions {
  /** Client to use for sending/updating messages */
  client: TrackerClient;
  /** Logger function for debug output */
  log?: (message: string) => void;
  /** Message ID to use as replyTo for action messages */
  replyTo?: string;
}

/**
 * ActionTracker manages the state of action messages.
 *
 * This utility provides a consistent way to handle action content across
 * different responder implementations (Claude Code, Codex, pubsub-chat).
 *
 * It handles:
 * - Starting new action messages with proper contentType
 * - Completing action messages when the action finishes
 * - Cleaning up orphaned action messages on error
 *
 * @example
 * ```typescript
 * const tracker = createActionTracker({ client, log, replyTo: incoming.id });
 *
 * // When a tool use starts
 * await tracker.startAction({ type: "Read", description: "Reading src/index.ts" });
 *
 * // When the action completes
 * await tracker.completeAction();
 *
 * // In catch block
 * } catch (err) {
 *   await tracker.cleanup();
 *   // ... handle error
 * }
 * ```
 */
export interface ActionTracker {
  /** Current state of the tracker */
  readonly state: ActionTrackerState;

  /**
   * Start a new action message.
   * @param action - The action data (type, description, optional toolUseId)
   * @returns The message ID of the created action message
   */
  startAction(action: Omit<ActionData, "status">): Promise<string>;

  /**
   * Complete the current action message.
   * Safe to call even if not currently tracking an action.
   */
  completeAction(): Promise<void>;

  /**
   * Check if there's an active action being tracked.
   */
  isActive(): boolean;

  /**
   * Cleanup any pending action message.
   * Call this in error handlers to ensure action messages are completed.
   * @returns true if cleanup succeeded or no cleanup was needed, false if cleanup failed
   */
  cleanup(): Promise<boolean>;
}

/**
 * Create an ActionTracker for managing action message state.
 */
export function createActionTracker(options: ActionTrackerOptions): ActionTracker {
  const { client, log = () => {}, replyTo } = options;

  const state: ActionTrackerState = {
    actionMessageId: null,
    currentAction: null,
  };

  return {
    get state() {
      return state;
    },

    async startAction(action: Omit<ActionData, "status">): Promise<string> {
      // Complete any existing action first
      if (state.actionMessageId) {
        await this.completeAction();
      }

      const actionData: ActionData = { ...action, status: "pending" };
      const { messageId } = await client.send(JSON.stringify(actionData), {
        replyTo,
        contentType: CONTENT_TYPE_ACTION,
      });

      state.actionMessageId = messageId;
      state.currentAction = actionData;

      log(`Started action: ${action.type} - ${action.description}`);
      return messageId;
    },

    async completeAction(): Promise<void> {
      if (state.actionMessageId && state.currentAction) {
        // Don't update content - just mark as complete.
        // The message's complete flag indicates the action is done.
        // (client.update appends content, which would duplicate the JSON)
        await client.complete(state.actionMessageId);
        log(`Completed action: ${state.currentAction.type}`);
        state.actionMessageId = null;
        state.currentAction = null;
      }
    },

    isActive(): boolean {
      return state.actionMessageId !== null;
    },

    async cleanup(): Promise<boolean> {
      if (state.actionMessageId) {
        const messageId = state.actionMessageId;
        state.actionMessageId = null;
        state.currentAction = null;
        try {
          await client.complete(messageId);
          log(`Cleanup: completed orphaned action: ${messageId}`);
          return true;
        } catch (err) {
          log(`Cleanup: failed to complete action ${messageId}: ${err}`);
          return false;
        }
      }
      return true;
    },
  };
}

/**
 * Content type constant for typing indicator messages.
 * Typing indicators are ephemeral (not persisted) and show that a participant is preparing a response.
 */
export const CONTENT_TYPE_TYPING = "typing" as const;

/**
 * Typing indicator data structure sent as message content (JSON stringified).
 */
export interface TypingData {
  /** Participant ID of who is typing */
  senderId: string;
  /** Display name of who is typing */
  senderName?: string;
  /** Participant type (e.g., "panel", "claude-code", "codex") */
  senderType?: string;
  /** Optional context (e.g., "preparing response", "searching files") */
  context?: string;
}

/**
 * State managed by the typing tracker.
 */
export interface TypingTrackerState {
  /** Message ID for the current typing indicator, if any */
  typingMessageId: string | null;
  /** Whether we're currently showing a typing indicator */
  isTyping: boolean;
}

/**
 * Options for creating a typing tracker.
 */
export interface TypingTrackerOptions {
  /** Client to use for sending messages */
  client: TrackerClient;
  /** Logger function for debug output */
  log?: (message: string) => void;
  /** Message ID to use as replyTo for typing indicators */
  replyTo?: string;
  /** Sender metadata to include in typing indicator */
  senderInfo?: {
    senderId: string;
    senderName?: string;
    senderType?: string;
  };
}

/**
 * TypingTracker manages ephemeral typing indicator messages.
 *
 * This utility provides a way to show that a participant is preparing a response
 * before actual content starts streaming. Unlike ThinkingTracker and ActionTracker,
 * typing indicators are ephemeral (not persisted) and disappear on reload.
 *
 * It handles:
 * - Starting ephemeral typing indicator messages
 * - Stopping typing indicators when content starts
 * - Cleaning up typing indicators on error
 *
 * @example
 * ```typescript
 * const tracker = createTypingTracker({
 *   client,
 *   log,
 *   replyTo: incoming.id,
 *   senderInfo: { senderId: client.clientId, senderName: "Codex", senderType: "codex" },
 * });
 *
 * // Show typing indicator while setting up
 * await tracker.startTyping("preparing response");
 *
 * // Stop typing when actual content starts
 * await tracker.stopTyping();
 *
 * // In catch block
 * } catch (err) {
 *   await tracker.cleanup();
 *   // ... handle error
 * }
 * ```
 */
export interface TypingTracker {
  /** Current state of the tracker */
  readonly state: TypingTrackerState;

  /**
   * Start showing a typing indicator (ephemeral, not persisted).
   * @param context - Optional context to show (e.g., "preparing response")
   * @returns The message ID of the created typing indicator
   */
  startTyping(context?: string): Promise<string>;

  /**
   * Stop and remove the typing indicator.
   * Safe to call even if not currently showing a typing indicator.
   */
  stopTyping(): Promise<void>;

  /**
   * Check if currently showing a typing indicator.
   */
  isTyping(): boolean;

  /**
   * Cleanup any pending typing indicator.
   * Call this in error handlers to ensure typing indicators are completed.
   * @returns true if cleanup succeeded or no cleanup was needed, false if cleanup failed
   */
  cleanup(): Promise<boolean>;
}

/**
 * Create a TypingTracker for managing ephemeral typing indicator messages.
 */
export function createTypingTracker(options: TypingTrackerOptions): TypingTracker {
  const { client, log = () => {}, replyTo, senderInfo } = options;

  const state: TypingTrackerState = {
    typingMessageId: null,
    isTyping: false,
  };

  return {
    get state() {
      return state;
    },

    async startTyping(context?: string): Promise<string> {
      // Stop any existing typing indicator first
      if (state.typingMessageId) {
        await this.stopTyping();
      }

      const typingData: TypingData = {
        senderId: senderInfo?.senderId ?? "",
        senderName: senderInfo?.senderName,
        senderType: senderInfo?.senderType,
        context,
      };

      const { messageId } = await client.send(JSON.stringify(typingData), {
        replyTo,
        contentType: CONTENT_TYPE_TYPING,
        persist: false, // EPHEMERAL - key difference from other trackers
      });

      state.typingMessageId = messageId;
      state.isTyping = true;

      log(`Started typing indicator: ${messageId}${context ? ` (${context})` : ""}`);
      return messageId;
    },

    async stopTyping(): Promise<void> {
      if (state.typingMessageId) {
        await client.update(state.typingMessageId, "", { complete: true, persist: false });
        log(`Stopped typing indicator: ${state.typingMessageId}`);
        state.typingMessageId = null;
        state.isTyping = false;
      }
    },

    isTyping(): boolean {
      return state.isTyping;
    },

    async cleanup(): Promise<boolean> {
      if (state.typingMessageId) {
        const messageId = state.typingMessageId;
        state.typingMessageId = null;
        state.isTyping = false;
        try {
          await client.update(messageId, "", { complete: true, persist: false });
          log(`Cleanup: stopped typing indicator: ${messageId}`);
          return true;
        } catch (err) {
          log(`Cleanup: failed to stop typing indicator ${messageId}: ${err}`);
          return false;
        }
      }
      return true;
    },
  };
}
