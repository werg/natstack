/**
 * Subagent Connection Module
 *
 * Provides utilities for creating and managing subagent pubsub connections,
 * and translating SDK stream events to pubsub messages.
 *
 * Used by SubagentManager for Task tool subagent event routing.
 */

import { connect } from "./client.js";
import type { AgenticClient, AgenticParticipantMetadata } from "./types.js";
import {
  createThinkingTracker,
  createActionTracker,
  getDetailedActionDescription,
  type TrackerClient,
} from "./responder-utils.js";

/**
 * Configuration for creating a subagent connection.
 */
export interface SubagentConnectionConfig {
  /** Parent client for context */
  parentClient: AgenticClient;
  /** Short description of the task (shown in participant name) */
  taskDescription: string;
  /** Type of subagent (e.g., "Explore", "Plan", "Bash", "Eval") */
  subagentType?: string;
  /** Tool use ID that triggered this subagent (for unrestricted mode tracking) */
  parentToolUseId?: string;
}

/**
 * Connection options for creating subagent pubsub connections.
 * These must be captured from the parent's connection config.
 */
export interface SubagentConnectionOptions {
  /** Pubsub server URL */
  serverUrl: string;
  /** Auth token */
  token: string;
  /** Channel name */
  channel: string;
  /** Context ID for channel authorization (required if channel was created with contextId) */
  contextId?: string;
}

/**
 * SDK stream event types (subset of Anthropic's RawMessageStreamEvent).
 * These match the structure emitted by the Claude SDK.
 */
export interface SDKStreamEvent {
  type: string;
  index?: number;
  content_block?: {
    type: string;
    id?: string;
    name?: string;
    text?: string;
    thinking?: string;
  };
  delta?: {
    type: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
  };
  message?: {
    id?: string;
    role?: string;
  };
}

/**
 * Subagent connection wrapper providing streaming helpers.
 * Manages message lifecycle similar to main agent thinking/action/text handling.
 */
export interface SubagentConnection {
  /** The underlying pubsub client */
  client: AgenticClient;
  /** Unique handle for this subagent */
  handle: string;

  /**
   * Start a new message from this subagent.
   * @param replyTo - Optional message ID to reply to
   * @returns The message ID
   */
  startMessage(replyTo?: string): Promise<string>;

  /**
   * Start a thinking block.
   */
  startThinking(): Promise<void>;

  /**
   * Update the current thinking content.
   * @param delta - Content to append
   */
  updateThinking(delta: string): Promise<void>;

  /**
   * Start a text block.
   */
  startText(): Promise<void>;

  /**
   * Update the current text content.
   * @param delta - Content to append
   */
  updateText(delta: string): Promise<void>;

  /**
   * Report a tool use action.
   * @param toolName - Name of the tool being used
   * @param args - Tool arguments (for generating description)
   */
  reportAction(toolName: string, args: unknown): Promise<void>;

  /**
   * Complete the current content block.
   */
  completeCurrentBlock(): Promise<void>;

  /**
   * Complete the current message successfully.
   */
  complete(): Promise<void>;

  /**
   * Mark the subagent as errored.
   * @param message - Error message to display
   */
  error(message: string): Promise<void>;

  /**
   * Close the subagent connection (participant leaves channel).
   */
  close(): Promise<void>;
}

/** Metadata type for subagent participants */
interface SubagentMetadata extends AgenticParticipantMetadata {
  name: string;
  type: "subagent";
  handle: string;
  parentId?: string | null;
  subagentType?: string;
  parentToolUseId?: string;
}

/**
 * Create a subagent pubsub connection.
 *
 * This creates a new participant in the channel that appears as a subagent.
 * The connection includes streaming helpers that mirror main agent behavior.
 *
 * @param config - Subagent configuration
 * @param connectionOptions - Pubsub connection options (serverUrl, token, channel)
 * @returns A SubagentConnection wrapper
 */
export async function createSubagentConnection(
  config: SubagentConnectionConfig,
  connectionOptions: SubagentConnectionOptions
): Promise<SubagentConnection> {
  const handle = `subagent-${crypto.randomUUID().slice(0, 8)}`;

  // Create display name from task description
  const displayName = `${config.taskDescription.slice(0, 40)}`;

  // Create the pubsub connection for this subagent
  const client = await connect<SubagentMetadata>({
    serverUrl: connectionOptions.serverUrl,
    token: connectionOptions.token,
    channel: connectionOptions.channel,
    contextId: connectionOptions.contextId, // Required for channel authorization
    handle,
    name: displayName,
    type: "subagent",
    extraMetadata: {
      parentId: config.parentClient.clientId,
      subagentType: config.subagentType,
      parentToolUseId: config.parentToolUseId,
    },
    replayMode: "skip", // Subagents don't need historical messages
  });

  // State tracking
  let currentMessageId: string | null = null;
  let currentBlockType: "thinking" | "text" | "action" | null = null;
  let textBuffer = "";
  let currentToolName: string | null = null;

  // Tracker client adapter (uses the subagent's client)
  const trackerClient: TrackerClient = {
    send: async (content, options) => {
      const result = await client.send(content, {
        replyTo: options?.replyTo,
        contentType: options?.contentType,
        persist: options?.persist,
      });
      return { messageId: result.messageId };
    },
    update: async (messageId, content, options) => {
      await client.update(messageId, content, {
        complete: options?.complete,
        persist: options?.persist,
        contentType: options?.contentType,
      });
    },
    complete: async (messageId) => {
      await client.complete(messageId);
    },
  };

  // Create trackers for thinking and action
  const thinkingTracker = createThinkingTracker({
    client: trackerClient,
    log: () => {}, // Silent logging for subagents
  });

  const actionTracker = createActionTracker({
    client: trackerClient,
    log: () => {},
  });

  const subagentConnection: SubagentConnection = {
    client,
    handle,

    async startMessage(replyTo?: string): Promise<string> {
      // Clean up any previous state
      if (thinkingTracker.isThinking()) {
        await thinkingTracker.endThinking();
      }
      if (actionTracker.isActive()) {
        await actionTracker.completeAction();
      }

      // Send an initial empty message to establish the response
      const { messageId } = await client.send("", { replyTo });
      currentMessageId = messageId;
      textBuffer = "";
      currentBlockType = null;

      return messageId;
    },

    async startThinking(): Promise<void> {
      // End any active action block first
      if (actionTracker.isActive()) {
        await actionTracker.completeAction();
      }

      // Start thinking via tracker (creates a new message)
      await thinkingTracker.startThinking();
      currentBlockType = "thinking";
    },

    async updateThinking(delta: string): Promise<void> {
      if (currentBlockType === "thinking") {
        await thinkingTracker.updateThinking(delta);
      }
    },

    async startText(): Promise<void> {
      // End thinking if active
      if (thinkingTracker.isThinking()) {
        await thinkingTracker.endThinking();
      }

      // End any active action
      if (actionTracker.isActive()) {
        await actionTracker.completeAction();
      }

      currentBlockType = "text";
      textBuffer = "";

      // For text, we accumulate and then send at the end
      // Or we could stream updates to the message
    },

    async updateText(delta: string): Promise<void> {
      if (currentBlockType === "text") {
        textBuffer += delta;
        // Stream the text update to the current message
        if (currentMessageId) {
          await client.update(currentMessageId, delta);
        } else {
          // No message yet, create one
          const { messageId } = await client.send(delta);
          currentMessageId = messageId;
        }
      }
    },

    async reportAction(toolName: string, args: unknown): Promise<void> {
      // End thinking if active
      if (thinkingTracker.isThinking()) {
        await thinkingTracker.endThinking();
      }

      currentBlockType = "action";
      currentToolName = toolName;

      // Generate initial description (may be updated as args stream in)
      const description = getDetailedActionDescription(
        toolName,
        typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {}
      );

      await actionTracker.startAction({
        type: toolName,
        description,
      });
    },

    async completeCurrentBlock(): Promise<void> {
      if (currentBlockType === "thinking" && thinkingTracker.isThinking()) {
        await thinkingTracker.endThinking();
      } else if (currentBlockType === "action" && actionTracker.isActive()) {
        await actionTracker.completeAction();
      } else if (currentBlockType === "text" && currentMessageId) {
        // Text block complete, mark the message as complete
        await client.complete(currentMessageId);
        currentMessageId = null;
        textBuffer = "";
      }
      currentBlockType = null;
      currentToolName = null;
    },

    async complete(): Promise<void> {
      // Clean up all trackers
      await thinkingTracker.cleanup();
      await actionTracker.cleanup();

      // Complete any pending message
      if (currentMessageId) {
        await client.complete(currentMessageId);
        currentMessageId = null;
      }
    },

    async error(message: string): Promise<void> {
      // Clean up trackers
      await thinkingTracker.cleanup();
      await actionTracker.cleanup();

      // Send error message if we have a current message, otherwise create one
      if (currentMessageId) {
        await client.error(currentMessageId, message);
      } else {
        const { messageId } = await client.send(`Error: ${message}`);
        await client.error(messageId, message);
      }
      currentMessageId = null;
    },

    async close(): Promise<void> {
      await client.close();
    },
  };

  return subagentConnection;
}

/**
 * Forward an SDK stream event to a subagent connection.
 *
 * This translates the SDK's streaming protocol to the appropriate
 * subagent connection method calls.
 *
 * @param subagent - The subagent connection
 * @param streamEvent - The SDK stream event
 */
export async function forwardStreamEventToSubagent(
  subagent: SubagentConnection,
  streamEvent: SDKStreamEvent
): Promise<void> {
  if (streamEvent.type === "message_start") {
    await subagent.startMessage();
    return;
  }

  if (streamEvent.type === "content_block_start" && streamEvent.content_block) {
    const block = streamEvent.content_block;
    if (block.type === "thinking") {
      await subagent.startThinking();
    } else if (block.type === "text") {
      await subagent.startText();
    } else if (block.type === "tool_use") {
      await subagent.reportAction(block.name ?? "Unknown", {});
    }
    return;
  }

  if (streamEvent.type === "content_block_delta" && streamEvent.delta) {
    if (streamEvent.delta.type === "text_delta" && streamEvent.delta.text) {
      await subagent.updateText(streamEvent.delta.text);
    } else if (streamEvent.delta.type === "thinking_delta" && streamEvent.delta.thinking) {
      await subagent.updateThinking(streamEvent.delta.thinking);
    }
    return;
  }

  if (streamEvent.type === "content_block_stop") {
    await subagent.completeCurrentBlock();
    return;
  }

  if (streamEvent.type === "message_stop") {
    // Message complete - finalize the subagent's current message
    await subagent.complete();
  }
}
