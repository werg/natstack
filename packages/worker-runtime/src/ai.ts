/**
 * AI proxy for workers - Unified streamText API.
 *
 * This module provides the same streamText API as @natstack/ai for panels,
 * but routes through the unified RPC mechanism.
 *
 * Uses the unified rpc.call("main", ...) for service calls and rpc.expose()
 * for tool execution callbacks.
 */

import type {
  AIRoleRecord,
  Message,
  StreamEvent,
  StreamTextOptions,
  ToolDefinition,
  ToolExecutionResult,
} from "@natstack/ai";
import { rpc } from "./rpc.js";

export type {
  Message,
  StreamEvent,
  StreamTextOptions,
  ToolDefinition,
  ToolExecutionResult,
  SystemMessage,
  UserMessage,
  AssistantMessage,
  ToolMessage,
  TextPart,
  FilePart,
  ToolCallPart,
  ToolResultPart,
} from "@natstack/ai";

// =============================================================================
// Serialization Types (for IPC)
// =============================================================================

interface SerializableMessage {
  role: string;
  content: string | SerializableContentPart[];
}

interface SerializableContentPart {
  type: string;
  text?: string;
  mimeType?: string;
  data?: string;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
}

interface SerializableToolDefinition {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

interface SerializableStreamEvent {
  type: string;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  stepNumber?: number;
  finishReason?: string;
  totalSteps?: number;
  usage?: { promptTokens: number; completionTokens: number };
  error?: string;
}

// =============================================================================
// Event Listeners (using unified RPC)
// =============================================================================

const streamChunkListeners = new Set<(streamId: string, chunk: SerializableStreamEvent) => void>();
const streamEndListeners = new Set<(streamId: string) => void>();

// Tool callbacks registered per stream (streamId -> toolName -> callback)
const registeredToolCallbacks = new Map<
  string,
  Map<string, (args: Record<string, unknown>) => Promise<unknown>>
>();

// Listen for stream events from main process via unified RPC events
rpc.onEvent("ai:stream-text-chunk", (_fromId, payload) => {
  const { streamId, chunk } = payload as { streamId: string; chunk: SerializableStreamEvent };
  for (const listener of streamChunkListeners) {
    try {
      listener(streamId, chunk);
    } catch (error) {
      console.error("Error in AI stream chunk listener:", error);
    }
  }
});

rpc.onEvent("ai:stream-text-end", (_fromId, payload) => {
  const { streamId } = payload as { streamId: string };
  for (const listener of streamEndListeners) {
    try {
      listener(streamId);
    } catch (error) {
      console.error("Error in AI stream end listener:", error);
    }
  }
});

// Expose tool execution method via unified RPC
// Main process calls this when it needs to execute a tool
rpc.expose({
  "ai.executeTool": async (
    streamId: unknown,
    toolName: unknown,
    toolArgs: unknown
  ): Promise<ToolExecutionResult> => {
    const sid = streamId as string;
    const name = toolName as string;
    const args = toolArgs as Record<string, unknown>;

    const streamCallbacks = registeredToolCallbacks.get(sid);
    const callback = streamCallbacks?.get(name);

    if (!callback) {
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }

    try {
      const result = await callback(args);
      // Safely stringify non-string results (handles circular references)
      let resultText: string;
      if (typeof result === "string") {
        resultText = result;
      } else {
        try {
          resultText = JSON.stringify(result);
        } catch {
          // Fallback for circular references or non-serializable values
          resultText = String(result);
        }
      }
      return {
        content: [{ type: "text", text: resultText }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      };
    }
  },
});

// =============================================================================
// Helper Functions
// =============================================================================

function encodeBase64(data: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]!);
  }
  return btoa(binary);
}

function serializeMessages(messages: Message[]): SerializableMessage[] {
  return messages.map((msg): SerializableMessage => {
    switch (msg.role) {
      case "system":
        return { role: "system", content: msg.content };

      case "user": {
        if (typeof msg.content === "string") {
          return { role: "user", content: msg.content };
        }
        return {
          role: "user",
          content: msg.content.map((part): SerializableContentPart => {
            if (part.type === "text") {
              return { type: "text", text: part.text };
            }
            const data = part.data instanceof Uint8Array ? encodeBase64(part.data) : part.data;
            return { type: "file", mimeType: part.mimeType, data };
          }),
        };
      }

      case "assistant": {
        if (typeof msg.content === "string") {
          return { role: "assistant", content: msg.content };
        }
        return {
          role: "assistant",
          content: msg.content.map((part): SerializableContentPart => {
            if (part.type === "text") {
              return { type: "text", text: part.text };
            }
            return {
              type: "tool-call",
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              args: part.args,
            };
          }),
        };
      }

      case "tool":
        return {
          role: "tool",
          content: msg.content.map((part): SerializableContentPart => ({
            type: "tool-result",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            result: part.result,
            isError: part.isError,
          })),
        };

      default:
        throw new Error(`Unsupported message role: ${(msg as { role?: string }).role ?? "unknown"}`);
    }
  });
}

function serializeTools(tools: Record<string, ToolDefinition>): SerializableToolDefinition[] {
  return Object.entries(tools).map(([name, tool]) => ({
    name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

function deserializeStreamEvent(chunk: SerializableStreamEvent): StreamEvent {
  switch (chunk.type) {
    case "text-delta":
      return { type: "text-delta", text: chunk.text ?? "" };

    case "tool-call":
      return {
        type: "tool-call",
        toolCallId: chunk.toolCallId ?? "",
        toolName: chunk.toolName ?? "",
        args: chunk.args,
      };

    case "tool-result":
      return {
        type: "tool-result",
        toolCallId: chunk.toolCallId ?? "",
        toolName: chunk.toolName ?? "",
        result: chunk.result,
        isError: chunk.isError,
      };

    case "step-finish":
      return {
        type: "step-finish",
        stepNumber: chunk.stepNumber ?? 0,
        finishReason: (chunk.finishReason ?? "stop") as "stop" | "tool-calls" | "length" | "error",
      };

    case "finish":
      return {
        type: "finish",
        totalSteps: chunk.totalSteps ?? 1,
        usage: chunk.usage,
      };

    case "error":
      return {
        type: "error",
        error: new Error(chunk.error ?? "Unknown error"),
      };

    default:
      return { type: "error", error: new Error(`Unknown event type: ${chunk.type}`) };
  }
}

// =============================================================================
// Public API
// =============================================================================

/** Cache of available role-to-model mappings */
let roleRecordCache: AIRoleRecord | null = null;

/**
 * Get the record of configured roles and their assigned models.
 */
export async function getRoles(): Promise<AIRoleRecord> {
  if (roleRecordCache) {
    return roleRecordCache;
  }
  roleRecordCache = await rpc.call<AIRoleRecord>("main", "ai.listRoles");
  return roleRecordCache;
}

/**
 * Clear the role cache.
 */
export function clearRoleCache(): void {
  roleRecordCache = null;
}

/**
 * Stream text from an AI model with optional tool support.
 *
 * This is the main API for interacting with AI models from workers.
 * It matches the panel-side streamText API.
 */
export function streamText(options: StreamTextOptions): AsyncIterable<StreamEvent> {
  const streamId = crypto.randomUUID();

  // Extract tool callbacks and serialize tools
  const toolCallbacks = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
  let serializedTools: SerializableToolDefinition[] | undefined;

  if (options.tools) {
    for (const [name, tool] of Object.entries(options.tools)) {
      toolCallbacks.set(name, tool.execute);
    }
    serializedTools = serializeTools(options.tools);
  }

  // Prepend system message if provided
  let messages = options.messages;
  if (options.system) {
    messages = [{ role: "system", content: options.system }, ...messages];
  }

  // Serialize messages for IPC
  const serializedMessages = serializeMessages(messages);

  // Build IPC options
  const bridgeOptions = {
    model: options.model,
    messages: serializedMessages,
    tools: serializedTools,
    maxSteps: options.maxSteps,
    maxOutputTokens: options.maxOutputTokens,
    temperature: options.temperature,
  };

  // Create async generator
  return {
    [Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
      let ended = false;
      let error: Error | null = null;
      const eventQueue: StreamEvent[] = [];
      let resolveNext: ((value: IteratorResult<StreamEvent>) => void) | null = null;

      // Set up cleanup
      const cleanup = () => {
        ended = true;
        streamChunkListeners.delete(chunkListener);
        streamEndListeners.delete(endListener);
        registeredToolCallbacks.delete(streamId);
      };

      // Listen for stream chunks
      const chunkListener = (sid: string, chunk: SerializableStreamEvent) => {
        if (sid !== streamId || ended) return;

        const event = deserializeStreamEvent(chunk);
        if (resolveNext) {
          resolveNext({ done: false, value: event });
          resolveNext = null;
        } else {
          eventQueue.push(event);
        }
      };
      streamChunkListeners.add(chunkListener);

      // Listen for stream end
      const endListener = (sid: string) => {
        if (sid !== streamId || ended) return;
        cleanup();
        if (resolveNext) {
          resolveNext({ done: true, value: undefined });
          resolveNext = null;
        }
      };
      streamEndListeners.add(endListener);

      // Register tool callbacks for this stream
      // Main process will invoke these via service:invoke -> executeTool
      registeredToolCallbacks.set(streamId, toolCallbacks);

      // Start the stream
      void rpc.call("main", "ai.streamTextStart", bridgeOptions, streamId).catch((err) => {
        error = err instanceof Error ? err : new Error(String(err));
        cleanup();
        if (resolveNext) {
          resolveNext({ done: false, value: { type: "error", error } });
          resolveNext = null;
        } else {
          eventQueue.push({ type: "error", error });
        }
      });

      return {
        async next(): Promise<IteratorResult<StreamEvent>> {
          if (error) {
            return { done: true, value: undefined };
          }

          if (eventQueue.length > 0) {
            return { done: false, value: eventQueue.shift()! };
          }

          if (ended) {
            return { done: true, value: undefined };
          }

          return new Promise((resolve) => {
            resolveNext = resolve;
          });
        },

        async return(): Promise<IteratorResult<StreamEvent>> {
          cleanup();
          void rpc.call("main", "ai.streamCancel", streamId).catch(() => {
            // Stream cancellation failed, but cleanup already happened
          });
          return { done: true, value: undefined };
        },

        async throw(e: Error): Promise<IteratorResult<StreamEvent>> {
          error = e;
          cleanup();
          void rpc.call("main", "ai.streamCancel", streamId).catch(() => {
            // Stream cancellation failed, but cleanup already happened
          });
          return { done: true, value: undefined };
        },
      };
    },
  };
}

/**
 * Generate text (non-streaming) from an AI model.
 */
export async function generateText(options: StreamTextOptions): Promise<{
  text: string;
  toolCalls: Array<{ toolCallId: string; toolName: string; args: unknown }>;
  toolResults: Array<{ toolCallId: string; toolName: string; result: unknown; isError?: boolean }>;
  usage?: { promptTokens: number; completionTokens: number };
}> {
  let text = "";
  const toolCalls: Array<{ toolCallId: string; toolName: string; args: unknown }> = [];
  const toolResults: Array<{ toolCallId: string; toolName: string; result: unknown; isError?: boolean }> = [];
  let usage: { promptTokens: number; completionTokens: number } | undefined;

  for await (const event of streamText(options)) {
    switch (event.type) {
      case "text-delta":
        text += event.text;
        break;
      case "tool-call":
        toolCalls.push({
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
        });
        break;
      case "tool-result":
        toolResults.push({
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          result: event.result,
          isError: event.isError,
        });
        break;
      case "finish":
        usage = event.usage;
        break;
      case "error":
        throw event.error;
    }
  }

  return { text, toolCalls, toolResults, usage };
}

/**
 * AI API object for backward compatibility.
 * Prefer using streamText() and generateText() directly.
 */
export const ai = {
  listRoles: getRoles,
  streamText,
  generateText,
};
