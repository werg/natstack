/**
 * Panel AI Runtime - Unified streamText API
 *
 * This module provides a high-level streamText function that works identically
 * for all model types (regular providers and Claude Code). The agent loop runs
 * server-side, and tool callbacks execute panel-side via IPC.
 *
 * Compatible with Vercel AI SDK patterns where possible.
 *
 * Usage:
 * ```typescript
 * import { streamText, tool, getRoles } from '@natstack/ai';
 * import { z } from 'zod';
 *
 * // Define tools with Zod schemas (like Vercel AI SDK)
 * const tools = {
 *   get_time: tool({
 *     description: "Get current time",
 *     parameters: z.object({}),
 *     execute: async () => ({ time: new Date().toISOString() })
 *   })
 * };
 *
 * // Stream with callbacks
 * const result = streamText({
 *   model: "fast",
 *   messages: [{ role: "user", content: "What time is it?" }],
 *   tools,
 *   onChunk: (chunk) => console.log(chunk),
 *   onFinish: (result) => console.log("Done!", result),
 * });
 *
 * // Multiple access patterns:
 * // 1. AsyncIterable (for await)
 * for await (const event of result) { ... }
 *
 * // 2. Specific streams
 * for await (const text of result.textStream) { ... }
 * for await (const event of result.fullStream) { ... }
 *
 * // 3. Awaitable promises
 * const text = await result.text;
 * const toolCalls = await result.toolCalls;
 * ```
 */

import type {
  AIRoleRecord,
  Message,
  StreamEvent,
  StreamTextOptions,
  StreamTextResult,
  ToolDefinition,
} from "./types.js";
import { encodeBase64 } from "./base64.js";

// Re-export types for consumers
export type {
  // Model metadata
  AIRoleRecord,
  AIModelInfo,
  // Tool definition (used by server for validation)
  AIToolDefinition,
  // streamText API types
  MessageRole,
  TextPart,
  FilePart,
  ToolCallPart,
  ToolResultPart,
  SystemMessage,
  UserMessage,
  AssistantMessage,
  ToolMessage,
  Message,
  ToolDefinition,
  OnChunkCallback,
  OnFinishCallback,
  OnStepFinishCallback,
  OnErrorCallback,
  StepFinishResult,
  StreamTextFinishResult,
  StreamTextOptions,
  StreamEvent,
  ToolExecutionResult,
  StreamTextResult,
} from "./types.js";

// =============================================================================
// Zod Schema Support
// =============================================================================

import { zodToJsonSchema as convertZodToJsonSchema } from "zod-to-json-schema";
import { z } from "zod";
import { StreamTextSession } from "./StreamTextSession.js";

/**
 * Type guard to check if something is a Zod schema.
 * Uses instanceof check for robust detection.
 */
function isZodSchema(schema: unknown): schema is z.ZodTypeAny {
  return schema instanceof z.ZodType;
}

/**
 * Convert a Zod schema to JSON Schema using the zod-to-json-schema library.
 */
function zodToJsonSchema(zodSchema: unknown): Record<string, unknown> {
  if (!isZodSchema(zodSchema)) {
    // Already JSON Schema
    return zodSchema as Record<string, unknown>;
  }

  // Use the library for proper conversion
  // TypeScript doesn't know the full Zod type, so we cast
  return convertZodToJsonSchema(zodSchema as Parameters<typeof convertZodToJsonSchema>[0], { target: "openApi3" }) as Record<string, unknown>;
}

/**
 * Input type for the tool() helper - accepts Zod schemas or JSON Schema.
 */
export interface ToolInput<TParams = Record<string, unknown>> {
  description?: string;
  /** Parameters schema - can be a Zod schema or JSON Schema object */
  parameters: TParams;
  /** Execute function called when the tool is invoked. Receives an optional AbortSignal for cancellation. */
  execute: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
}

/**
 * Create a tool definition with Zod schema support.
 *
 * This helper provides Vercel AI SDK compatibility by accepting Zod schemas
 * and converting them to JSON Schema internally.
 *
 * @example
 * ```typescript
 * import { tool } from '@natstack/ai';
 * import { z } from 'zod';
 *
 * const weatherTool = tool({
 *   description: 'Get the weather for a location',
 *   parameters: z.object({
 *     city: z.string().describe('City name'),
 *     units: z.enum(['celsius', 'fahrenheit']).optional(),
 *   }),
 *   execute: async ({ city, units }) => {
 *     return { temperature: 72, units: units ?? 'fahrenheit' };
 *   },
 * });
 * ```
 */
export function tool<TParams>(input: ToolInput<TParams>): ToolDefinition {
  return {
    description: input.description,
    parameters: zodToJsonSchema(input.parameters),
    execute: input.execute,
  };
}

// =============================================================================
// Bridge Interface
// =============================================================================

// Bridge types - simplified to use Message types directly
interface StreamTextBridgeOptions {
  model: string;
  messages: Message[];
  tools?: Array<{ name: string; description?: string; parameters: Record<string, unknown> }>;
  maxSteps?: number;
  maxOutputTokens?: number;
  temperature?: number;
  system?: string;
}

interface AIBridge {
  listRoles(): Promise<AIRoleRecord>;
  streamTextStart(options: StreamTextBridgeOptions, streamId: string): Promise<void>;
  streamCancel(streamId: string): Promise<void>;
  onStreamChunk(listener: (streamId: string, chunk: StreamEvent) => void): () => void;
  onStreamEnd(listener: (streamId: string) => void): () => void;
  /**
   * Register tool callbacks for a stream. Main process invokes these via panel:execute-tool.
   * Note: Uses plain object instead of Map because contextBridge cannot pass Maps with functions.
   */
  registerTools(streamId: string, callbacks: Record<string, (args: Record<string, unknown>) => Promise<unknown>>): () => void;
}

interface PanelBridgeWithAI {
  panelId: string;
  ai: AIBridge;
}

const getBridge = (): PanelBridgeWithAI => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bridge = (window as any).__natstackPanelBridge as PanelBridgeWithAI | undefined;
  if (!bridge) {
    throw new Error("NatStack panel bridge is not available");
  }
  if (!bridge.ai) {
    throw new Error("NatStack AI bridge is not available");
  }
  return bridge;
};

// =============================================================================
// Helpers
// =============================================================================

const activeStreamCancelers = new Map<string, () => void>();
let unloadCancelRegistered = false;

function registerUnloadCancelHook(): void {
  if (unloadCancelRegistered) return;
  unloadCancelRegistered = true;
  window.addEventListener("beforeunload", () => {
    for (const cancel of activeStreamCancelers.values()) {
      cancel();
    }
    activeStreamCancelers.clear();
  });
}

// =============================================================================
// Message Serialization (Uint8Array → base64 for IPC)
// =============================================================================

/**
 * Prepare messages for IPC by encoding any Uint8Array data to base64.
 * Only user messages with file parts need conversion.
 */
function prepareMessagesForIPC(messages: Message[]): Message[] {
  return messages.map((msg): Message => {
    // Only user messages can have file parts with binary data
    if (msg.role === "user" && typeof msg.content !== "string") {
      return {
        ...msg,
        content: msg.content.map((part) => {
          if (part.type === "file" && part.data instanceof Uint8Array) {
            return { ...part, data: encodeBase64(part.data) };
          }
          return part;
        }),
      };
    }

    // All other message types pass through unchanged
    return msg;
  });
}

function serializeTools(tools: Record<string, ToolDefinition>): Array<{ name: string; description?: string; parameters: Record<string, unknown> }> {
  return Object.entries(tools).map(([name, t]) => ({
    name,
    description: t.description,
    parameters: t.parameters,
  }));
}

// StreamEvent is already the canonical event type, no conversion needed

// =============================================================================
// Public API
// =============================================================================

/** Cache of available role-to-model mappings */
let roleRecordCache: AIRoleRecord | null = null;

/**
 * Get the record of configured roles and their assigned models.
 *
 * All four standard roles (smart, fast, coding, cheap) are always present.
 *
 * @returns Record mapping role names to model info
 */
export async function getRoles(): Promise<AIRoleRecord> {
  if (roleRecordCache) {
    return roleRecordCache;
  }

  const bridge = getBridge();
  roleRecordCache = await bridge.ai.listRoles();
  return roleRecordCache;
}

/**
 * Clear the role cache. Useful if role configuration changes.
 */
export function clearRoleCache(): void {
  roleRecordCache = null;
}

/**
 * Stream text from an AI model with optional tool support.
 *
 * Returns a result object that provides multiple ways to consume the stream:
 * - As an AsyncIterable (for await...of)
 * - Via specific streams (textStream, fullStream)
 * - Via promises (text, toolCalls, etc.)
 *
 * @param options - Stream configuration
 * @returns StreamTextResult with multiple access patterns
 *
 * @example
 * ```typescript
 * // Using AsyncIterable
 * const result = streamText({
 *   model: "fast",
 *   messages: [{ role: "user", content: "Hello!" }],
 * });
 *
 * for await (const event of result) {
 *   if (event.type === "text-delta") console.log(event.text);
 * }
 *
 * // Using textStream
 * for await (const text of result.textStream) {
 *   process.stdout.write(text);
 * }
 *
 * // Using promises
 * const finalText = await result.text;
 * ```
 */
export function streamText(options: StreamTextOptions): StreamTextResult {
  const bridge = getBridge();
  const streamId = crypto.randomUUID();

  registerUnloadCancelHook();

  // Extract tool callbacks and serialize tools
  // Use plain object instead of Map because contextBridge cannot pass Maps with functions
  const toolCallbacks: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {};
  let serializedTools: Array<{ name: string; description?: string; parameters: Record<string, unknown> }> | undefined;

  if (options.tools) {
    for (const [name, t] of Object.entries(options.tools)) {
      toolCallbacks[name] = t.execute;
    }
    serializedTools = serializeTools(options.tools);
  }

  // Prepend system message if provided
  let messages = options.messages;
  if (options.system) {
    messages = [{ role: "system", content: options.system }, ...messages];
  }

  // Prepare messages for IPC (encode Uint8Array to base64)
  const ipcMessages = prepareMessagesForIPC(messages);

  // Build IPC options
  const bridgeOptions: StreamTextBridgeOptions = {
    model: options.model,
    messages: ipcMessages,
    tools: serializedTools,
    maxSteps: options.maxSteps,
    maxOutputTokens: options.maxOutputTokens,
    temperature: options.temperature,
  };

  // Create session - encapsulates all state and logic
  const session = new StreamTextSession(
    streamId,
    options,
    () => {
      void bridge.ai.streamCancel(streamId).catch(() => {
        // Stream cancellation failed, but cleanup already happened
      });
    }
  );

  // Register cancel handler
  activeStreamCancelers.set(streamId, () => session.cancel());

  // Handle abort signal
  if (options.abortSignal) {
    options.abortSignal.addEventListener("abort", () => {
      session.cancel();
    });
  }

  // Listen for stream chunks and forward to session
  const unsubChunk = bridge.ai.onStreamChunk((sid, chunk) => {
    if (sid !== streamId) return;
    void session.processEvent(chunk);
  });

  // Listen for stream end
  const unsubEnd = bridge.ai.onStreamEnd((sid) => {
    if (sid !== streamId) return;
    session.cleanup();
  });

  // Register tool callbacks with preload bridge
  const unsubTools = bridge.ai.registerTools(streamId, toolCallbacks);

  // Register unsubscribers with session for cleanup
  session.addUnsubscriber(unsubChunk);
  session.addUnsubscriber(unsubEnd);
  session.addUnsubscriber(unsubTools);
  session.addUnsubscriber(() => activeStreamCancelers.delete(streamId));

  // Start the stream
  void bridge.ai.streamTextStart(bridgeOptions, streamId).catch((err) => {
    const error = err instanceof Error ? err : new Error(String(err));
    void session.processEvent({ type: "error", error });
    session.cleanup();
  });

  // Return the result object from the session
  return session.toResult();
}

/**
 * Generate text (non-streaming) from an AI model.
 *
 * This is a convenience wrapper around streamText that collects all events
 * and returns the final text.
 *
 * @param options - Same as streamText options
 * @returns Promise with the generated text and usage info
 */
export async function generateText(options: StreamTextOptions): Promise<{
  text: string;
  toolCalls: Array<{ toolCallId: string; toolName: string; args: unknown }>;
  toolResults: Array<{ toolCallId: string; toolName: string; result: unknown; isError?: boolean }>;
  usage?: { promptTokens: number; completionTokens: number };
  finishReason: "stop" | "tool-calls" | "length" | "error";
}> {
  const result = streamText(options);

  // Consume the stream to trigger processing
  for await (const event of result) {
    if (event.type === "error") {
      throw event.error;
    }
  }

  return {
    text: await result.text,
    toolCalls: await result.toolCalls,
    toolResults: await result.toolResults,
    usage: await result.usage,
    finishReason: await result.finishReason,
  };
}
