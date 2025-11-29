/**
 * AI proxy for workers.
 *
 * This module uses the unified __serviceCall global and __servicePush handler
 * to access AI capabilities just like panels.
 */

import type {
  AICallOptions,
  AIGenerateResult,
  AIRoleRecord,
  AIStreamPart,
  AIToolDefinition,
} from "@natstack/ai";

// Declare the unified service call global
declare const __serviceCall: (
  service: string,
  method: string,
  ...args: unknown[]
) => Promise<unknown>;

/**
 * Claude Code conversation info.
 */
export interface ClaudeCodeConversationInfo {
  conversationId: string;
  registeredTools: string[];
}

/**
 * Claude Code tool result.
 */
export interface ClaudeCodeToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

// Stream event listeners
const streamChunkListeners = new Set<(streamId: string, chunk: AIStreamPart) => void>();
const streamEndListeners = new Set<(streamId: string) => void>();

// Tool callbacks for Claude Code conversations
const ccToolCallbacks = new Map<
  string,
  Map<string, (args: Record<string, unknown>) => Promise<ClaudeCodeToolResult>>
>();

// Default tool callbacks for inline streaming
const defaultToolCallbacks = new Map<
  string,
  (args: Record<string, unknown>) => Promise<ClaudeCodeToolResult>
>();

// Handle push events from main process via __servicePush
type ServicePushHandler = (service: string, event: string, payload: unknown) => void;

(globalThis as { __servicePush?: ServicePushHandler }).__servicePush = (
  service: string,
  event: string,
  payload: unknown
) => {
  if (service !== "ai") return;

  switch (event) {
    case "stream-chunk": {
      const { streamId, chunk } = payload as { streamId: string; chunk: AIStreamPart };
      for (const listener of streamChunkListeners) {
        try {
          listener(streamId, chunk);
        } catch (error) {
          console.error("Error in AI stream chunk listener:", error);
        }
      }
      break;
    }
    case "stream-end": {
      const { streamId } = payload as { streamId: string };
      for (const listener of streamEndListeners) {
        try {
          listener(streamId);
        } catch (error) {
          console.error("Error in AI stream end listener:", error);
        }
      }
      break;
    }
    case "tool-execute": {
      const { executionId, conversationId, toolName, args } = payload as {
        executionId: string;
        conversationId: string;
        toolName: string;
        args: unknown;
      };
      void handleToolExecute(executionId, conversationId, toolName, args);
      break;
    }
  }
};

async function handleToolExecute(
  executionId: string,
  conversationId: string,
  toolName: string,
  args: unknown
): Promise<void> {
  try {
    // First try conversation-specific callbacks
    let callback:
      | ((args: Record<string, unknown>) => Promise<ClaudeCodeToolResult>)
      | undefined;

    const conversationCallbacks = ccToolCallbacks.get(conversationId);
    if (conversationCallbacks) {
      callback = conversationCallbacks.get(toolName);
    }

    // Fall back to default callbacks
    if (!callback) {
      callback = defaultToolCallbacks.get(toolName);
    }

    if (!callback) {
      throw new Error(`No callback registered for tool: ${toolName}`);
    }

    const result = await callback(args as Record<string, unknown>);
    await __serviceCall("ai", "ccToolResult", executionId, result);
  } catch (error) {
    const errorResult: ClaudeCodeToolResult = {
      content: [
        {
          type: "text",
          text: error instanceof Error ? error.message : String(error),
        },
      ],
      isError: true,
    };
    await __serviceCall("ai", "ccToolResult", executionId, errorResult);
  }
}

/**
 * AI API for workers.
 */
export const ai = {
  /**
   * Generate text using an AI model.
   *
   * @param modelId - Role or model ID (e.g., "smart", "fast", "anthropic:claude-sonnet-4-20250514")
   * @param options - Call options including prompt, temperature, etc.
   */
  async generate(modelId: string, options: AICallOptions): Promise<AIGenerateResult> {
    return (await __serviceCall("ai", "generate", modelId, options)) as AIGenerateResult;
  },

  /**
   * Start a streaming generation.
   * Use onStreamChunk and onStreamEnd to receive stream events.
   *
   * @param modelId - Role or model ID
   * @param options - Call options
   * @param streamId - Unique ID to identify this stream
   */
  async streamStart(
    modelId: string,
    options: AICallOptions,
    streamId: string
  ): Promise<void> {
    await __serviceCall("ai", "streamStart", modelId, options, streamId);
  },

  /**
   * Cancel an active streaming generation.
   *
   * @param streamId - ID of the stream to cancel
   */
  async streamCancel(streamId: string): Promise<void> {
    await __serviceCall("ai", "streamCancel", streamId);
  },

  /**
   * Get the record of available AI roles and their assigned models.
   */
  async listRoles(): Promise<AIRoleRecord> {
    return (await __serviceCall("ai", "listRoles")) as AIRoleRecord;
  },

  /**
   * Subscribe to stream chunk events.
   *
   * @param listener - Callback for each chunk
   * @returns Unsubscribe function
   */
  onStreamChunk(listener: (streamId: string, chunk: AIStreamPart) => void): () => void {
    streamChunkListeners.add(listener);
    return () => {
      streamChunkListeners.delete(listener);
    };
  },

  /**
   * Subscribe to stream end events.
   *
   * @param listener - Callback when stream ends
   * @returns Unsubscribe function
   */
  onStreamEnd(listener: (streamId: string) => void): () => void {
    streamEndListeners.add(listener);
    return () => {
      streamEndListeners.delete(listener);
    };
  },

  // =========================================================================
  // Claude Code Conversation API
  // =========================================================================

  /**
   * Start a Claude Code conversation with tools.
   * Returns conversation info including the conversationId.
   *
   * @param modelId - Model to use
   * @param tools - Tool definitions
   * @param callbacks - Tool execution callbacks
   */
  async ccConversationStart(
    modelId: string,
    tools: AIToolDefinition[],
    callbacks: Record<string, (args: Record<string, unknown>) => Promise<ClaudeCodeToolResult>>
  ): Promise<ClaudeCodeConversationInfo> {
    const info = (await __serviceCall(
      "ai",
      "ccConversationStart",
      modelId,
      tools
    )) as ClaudeCodeConversationInfo;

    // Register the tool callbacks for this conversation
    const callbackMap = new Map<
      string,
      (args: Record<string, unknown>) => Promise<ClaudeCodeToolResult>
    >();
    for (const [name, callback] of Object.entries(callbacks)) {
      callbackMap.set(name, callback);
    }
    ccToolCallbacks.set(info.conversationId, callbackMap);

    return info;
  },

  /**
   * Generate with an existing Claude Code conversation.
   */
  async ccGenerate(conversationId: string, options: AICallOptions): Promise<AIGenerateResult> {
    return (await __serviceCall("ai", "ccGenerate", conversationId, options)) as AIGenerateResult;
  },

  /**
   * Start streaming with an existing Claude Code conversation.
   */
  async ccStreamStart(
    conversationId: string,
    options: AICallOptions,
    streamId: string
  ): Promise<void> {
    await __serviceCall("ai", "ccStreamStart", conversationId, options, streamId);
  },

  /**
   * End a Claude Code conversation and clean up resources.
   */
  async ccConversationEnd(conversationId: string): Promise<void> {
    ccToolCallbacks.delete(conversationId);
    await __serviceCall("ai", "ccConversationEnd", conversationId);
  },

  /**
   * Register tool callbacks for inline Claude Code streaming.
   * These callbacks are used when calling doStream with tools on a Claude Code model.
   *
   * @param callbacks - Map of tool name to callback function
   * @returns Cleanup function to unregister the callbacks
   */
  registerToolCallbacks(
    callbacks: Record<string, (args: Record<string, unknown>) => Promise<ClaudeCodeToolResult>>
  ): () => void {
    for (const [name, callback] of Object.entries(callbacks)) {
      defaultToolCallbacks.set(name, callback);
    }

    return () => {
      for (const name of Object.keys(callbacks)) {
        defaultToolCallbacks.delete(name);
      }
    };
  },
};
