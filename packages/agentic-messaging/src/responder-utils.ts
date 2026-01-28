/**
 * Shared utilities for AI responder workers.
 *
 * These utilities provide common functionality used across different
 * responder implementations (Claude Code, Codex, etc.).
 */

import type { AgenticParticipantMetadata, IncomingNewMessage } from "./types.js";
import type { ContextWindowUsage } from "./context-tracker.js";

/**
 * Standard participant metadata for chat-style channels.
 * Used by responder workers and panels to identify participant types.
 */
export interface ChatParticipantMetadata extends AgenticParticipantMetadata {
  name: string;
  type: "panel" | "ai-responder" | "claude-code" | "codex" | "subagent";
  /** Runtime panel/worker ID - allows chat panel to link participant to child panel for focus/reload */
  panelId?: string;
  /** Agent type ID for identification/recovery (e.g., "claude-code-responder") */
  agentTypeId?: string;
  /** Context window usage tracking (updated by AI responders) */
  contextUsage?: ContextWindowUsage;
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
 * Content type constant for inline UI components.
 * Used for rendering dynamic MDX/React components inline in the conversation.
 * Unlike feedback_custom which renders at the bottom and waits for input,
 * inline_ui renders immediately in the message stream.
 */
export const CONTENT_TYPE_INLINE_UI = "inline_ui" as const;

/**
 * Inline UI data structure sent as message content (JSON stringified).
 */
export interface InlineUiData {
  /** Unique ID for this inline UI instance (allows updates with same ID) */
  id: string;
  /** The MDX/TSX code to compile and render */
  code: string;
  /** Optional props to pass to the component */
  props?: Record<string, unknown>;
}

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
  ): Promise<void | number | undefined>;
  complete(messageId: string): Promise<void | number | undefined>;
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
 * different responder implementations (claude-code-responder, codex-responder, etc.).
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
 * different responder implementations (claude-code-responder, codex-responder, etc.).
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
   * Update the description of the current action.
   * This completes the old action message and starts a new one with the updated description.
   * @param description - New description for the action
   */
  updateAction(description: string): Promise<void>;

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

    async updateAction(description: string): Promise<void> {
      if (state.actionMessageId && state.currentAction) {
        const oldMessageId = state.actionMessageId;

        // Update the action data with the new description
        const updatedAction: ActionData = {
          ...state.currentAction,
          description,
          status: "pending",
        };

        // Complete the old message
        await client.complete(oldMessageId);
        log(`Completed old action message for update: ${oldMessageId}`);

        // Start a new message with the updated description
        const { messageId } = await client.send(JSON.stringify(updatedAction), {
          replyTo,
          contentType: CONTENT_TYPE_ACTION,
        });

        state.actionMessageId = messageId;
        state.currentAction = updatedAction;
        log(`Updated action: ${updatedAction.type} - ${description}`);
      }
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
 * Truncate a file path for display, keeping the filename visible.
 */
function truncatePathForAction(path: string, maxLen = 40): string {
  if (path.length <= maxLen) return path;
  const parts = path.split("/");
  const filename = parts.pop() || "";
  if (filename.length >= maxLen - 3) return "..." + filename.slice(-(maxLen - 3));
  return "..." + path.slice(-(maxLen - 3));
}

/**
 * Truncate a string for display.
 */
function truncateStrForAction(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + "...";
}

/**
 * Generate informative action descriptions based on tool name and input.
 * Used by all responder workers for consistent action display.
 *
 * @example
 * ```typescript
 * getDetailedActionDescription("Read", { file_path: "/src/index.ts" })
 * // => "Reading index.ts"
 *
 * getDetailedActionDescription("pubsub_panel_eval", { code: "console.log('hi')" })
 * // => "Calling panel.eval"
 * ```
 */
export function getDetailedActionDescription(
  toolName: string,
  input: Record<string, unknown>
): string {
  // Extract base name (remove prefixes like "pubsub_providerId_")
  let baseName = toolName;
  if (toolName.startsWith("pubsub_")) {
    // pubsub_providerId_methodName -> methodName
    const parts = toolName.split("_");
    if (parts.length >= 3) {
      baseName = parts.slice(2).join("_");
    }
  }

  // Normalize to handle both PascalCase (SDK) and snake_case (pubsub) names
  // "Read" stays "Read", "file_read" becomes "file_read"
  switch (baseName) {
    // SDK tool names (PascalCase)
    case "Read":
    // Pubsub tool names (snake_case)
    case "file_read":
      return input["file_path"]
        ? `Reading ${truncatePathForAction(input["file_path"] as string)}`
        : "Reading file";

    case "Write":
    case "file_write":
      return input["file_path"]
        ? `Writing to ${truncatePathForAction(input["file_path"] as string)}`
        : "Writing file";

    case "Edit":
    case "file_edit":
      return input["file_path"]
        ? `Editing ${truncatePathForAction(input["file_path"] as string)}`
        : "Editing file";

    case "Bash":
      return input["command"]
        ? `Running: ${truncateStrForAction(input["command"] as string, 50)}`
        : "Running command";

    case "Glob":
    case "glob":
      return input["pattern"]
        ? `Finding files: ${truncateStrForAction(input["pattern"] as string, 40)}`
        : "Searching for files";

    case "Grep":
    case "grep": {
      const grepPath = input["path"] ? ` in ${truncatePathForAction(input["path"] as string, 20)}` : "";
      return input["pattern"]
        ? `Searching for '${truncateStrForAction(input["pattern"] as string, 25)}'${grepPath}`
        : "Searching file contents";
    }

    case "WebSearch":
      return input["query"]
        ? `Searching: ${truncateStrForAction(input["query"] as string, 40)}`
        : "Searching the web";

    case "WebFetch":
      return input["url"]
        ? `Fetching: ${truncateStrForAction(input["url"] as string, 40)}`
        : "Fetching web content";

    case "Task":
      return input["description"]
        ? `Task: ${truncateStrForAction(input["description"] as string, 40)}`
        : "Delegating to subagent";

    case "TodoWrite":
      return "Updating task list";

    case "AskUserQuestion":
    case "ask_user_question": {
      const questions = input["questions"];
      if (questions && Array.isArray(questions) && questions.length > 0) {
        const firstQuestion = questions[0] as { question?: string };
        return firstQuestion.question
          ? `Asking: ${truncateStrForAction(firstQuestion.question, 35)}`
          : "Asking user";
      }
      return "Asking user";
    }

    case "NotebookEdit":
      return input["notebook_path"]
        ? `Editing notebook: ${truncatePathForAction(input["notebook_path"] as string)}`
        : "Editing notebook";

    case "KillShell":
      return input["shell_id"]
        ? `Killing shell: ${input["shell_id"]}`
        : "Killing shell";

    // Git tools (pubsub names)
    case "git_status":
      return "Checking git status";
    case "git_diff":
      return "Getting git diff";
    case "git_log":
      return "Viewing git log";
    case "git_add":
      return input["files"]
        ? `Staging: ${truncateStrForAction(String(input["files"]), 40)}`
        : "Staging files";
    case "git_commit":
      return input["message"]
        ? `Committing: ${truncateStrForAction(input["message"] as string, 40)}`
        : "Creating commit";
    case "git_checkout":
      return input["branch"]
        ? `Checking out: ${input["branch"]}`
        : "Checking out";

    // Directory tools (pubsub names)
    case "tree":
    case "list_directory":
      return input["path"]
        ? `Listing ${truncatePathForAction(input["path"] as string)}`
        : "Listing directory";

    default:
      // For pubsub tools, show the method name cleanly
      if (toolName.startsWith("pubsub_")) {
        const methodName = toolName.replace("pubsub_", "").replace(/_/g, ".");
        return `Calling ${methodName}`;
      }
      return `Using ${toolName}`;
  }
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
