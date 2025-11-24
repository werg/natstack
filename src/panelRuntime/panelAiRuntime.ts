/**
 * Panel AI Runtime - Proxy models for the Vercel AI SDK
 *
 * This module provides AI SDK-compatible model objects that route requests
 * through IPC to the main process where API credentials are securely stored.
 *
 * Usage:
 * ```typescript
 * import { models, getAvailableModels } from 'natstack/ai';
 * import { generateText, streamText } from 'ai';
 *
 * // List available models
 * const available = await getAvailableModels();
 *
 * // Use with AI SDK
 * const result = await generateText({
 *   model: models['claude-sonnet'],
 *   prompt: 'Hello!'
 * });
 * ```
 */

import type {
  AIModelInfo,
  AICallOptions,
  AIGenerateResult,
  AIStreamPart,
  AIMessage,
  AITextPart,
  AIFilePart,
  AIToolResultPart,
  AIReasoningPart,
  AIToolCallPart,
} from "../shared/ipc/index.js";
import { encodeBase64 } from "../shared/base64.js";

// =============================================================================
// Bridge Interface
// =============================================================================

interface AIBridge {
  generate(modelId: string, options: AICallOptions): Promise<AIGenerateResult>;
  streamStart(modelId: string, options: AICallOptions, streamId: string): Promise<void>;
  streamCancel(streamId: string): Promise<void>;
  listModels(): Promise<AIModelInfo[]>;
  onStreamChunk(listener: (streamId: string, chunk: AIStreamPart) => void): () => void;
  onStreamEnd(listener: (streamId: string) => void): () => void;
}

interface PanelBridgeWithAI {
  panelId: string;
  ai: AIBridge;
}

const getBridge = (): PanelBridgeWithAI => {
  // Access the bridge from the global window object
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
// AI SDK Compatible Types
// =============================================================================

/**
 * Minimal LanguageModelV2 interface for AI SDK compatibility.
 * This matches the Vercel AI SDK's LanguageModelV2 specification.
 */
export interface LanguageModelV2 {
  readonly specificationVersion: "v2";
  readonly provider: string;
  readonly modelId: string;
  readonly supportedUrls: Record<string, RegExp[]>;

  doGenerate(options: LanguageModelV2CallOptions): Promise<LanguageModelV2GenerateResult>;
  doStream(options: LanguageModelV2CallOptions): Promise<LanguageModelV2StreamResult>;
}

export interface LanguageModelV2CallOptions {
  prompt: LanguageModelV2Prompt;
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  stopSequences?: string[];
  seed?: number;
  responseFormat?: { type: "text" } | { type: "json"; schema?: unknown; name?: string; description?: string };
  tools?: LanguageModelV2Tool[];
  toolChoice?: LanguageModelV2ToolChoice;
  abortSignal?: AbortSignal;
  headers?: Record<string, string>;
  providerOptions?: Record<string, Record<string, unknown>>;
}

export type LanguageModelV2Prompt = LanguageModelV2Message[];

export type LanguageModelV2Message =
  | { role: "system"; content: string }
  | { role: "user"; content: Array<LanguageModelV2TextPart | LanguageModelV2FilePart> }
  | { role: "assistant"; content: Array<LanguageModelV2TextPart | LanguageModelV2FilePart | LanguageModelV2ReasoningPart | LanguageModelV2ToolCallPart> }
  | { role: "tool"; content: LanguageModelV2ToolResultPart[] };

export interface LanguageModelV2TextPart {
  type: "text";
  text: string;
}

export interface LanguageModelV2FilePart {
  type: "file";
  mimeType: string;
  data: Uint8Array | string;
}

export interface LanguageModelV2ReasoningPart {
  type: "reasoning";
  text: string;
}

export interface LanguageModelV2ToolCallPart {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  args: unknown;
}

export interface LanguageModelV2ToolResultPart {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  result: unknown;
  isError?: boolean;
}

export interface LanguageModelV2Tool {
  type: "function";
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

export type LanguageModelV2ToolChoice =
  | { type: "auto" }
  | { type: "none" }
  | { type: "required" }
  | { type: "tool"; toolName: string };

export interface LanguageModelV2GenerateResult {
  content: Array<{ type: "text"; text: string } | { type: "reasoning"; text: string } | { type: "tool-call"; toolCallId: string; toolName: string; args: unknown }>;
  finishReason: "stop" | "length" | "content-filter" | "tool-calls" | "error" | "other" | "unknown";
  usage: { promptTokens: number; completionTokens: number };
  warnings: Array<{ type: string; message: string; details?: unknown }>;
  response?: { id?: string; modelId?: string; timestamp?: Date };
  request?: { body?: unknown };
  providerMetadata?: Record<string, Record<string, unknown>>;
}

export interface LanguageModelV2StreamResult {
  stream: ReadableStream<LanguageModelV2StreamPart>;
  request?: { body?: unknown };
  response?: { headers?: Record<string, string> };
}

export type LanguageModelV2StreamPart =
  | { type: "text-start"; id: string }
  | { type: "text-delta"; id: string; delta: string }
  | { type: "text-end"; id: string }
  | { type: "reasoning-start"; id: string }
  | { type: "reasoning-delta"; id: string; delta: string }
  | { type: "reasoning-end"; id: string }
  | { type: "tool-input-start"; toolCallId: string; toolName: string }
  | { type: "tool-input-delta"; toolCallId: string; inputTextDelta: string }
  | { type: "tool-input-end"; toolCallId: string }
  | { type: "stream-start"; warnings: Array<{ type: string; message: string; details?: unknown }> }
  | { type: "response-metadata"; id?: string; modelId?: string; timestamp?: Date }
  | { type: "finish"; finishReason: string; usage: { promptTokens: number; completionTokens: number } }
  | { type: "error"; error: unknown };

// =============================================================================
// Type Converters
// =============================================================================

/**
 * Convert AI SDK prompt to our serializable format.
 */
function convertPromptToIPC(prompt: LanguageModelV2Prompt): AIMessage[] {
  return prompt.map((msg): AIMessage => {
    switch (msg.role) {
      case "system":
        return { role: "system", content: msg.content };

      case "user":
        return {
          role: "user",
          content: msg.content.map((part): AITextPart | AIFilePart => {
            if (part.type === "text") {
              return { type: "text", text: part.text };
            }
            if (part.type === "file") {
              // File part - encode to base64
              const data = part.data instanceof Uint8Array ? encodeBase64(part.data) : part.data; // Already a string (URL or base64)
              return { type: "file", mimeType: part.mimeType, data };
            }
            throw new Error(`Unsupported user content type: ${(part as { type?: string }).type ?? "unknown"}`);
          }),
        };

      case "assistant":
        return {
          role: "assistant",
          content: msg.content.map((part): AITextPart | AIFilePart | AIReasoningPart | AIToolCallPart => {
            switch (part.type) {
              case "text":
                return { type: "text", text: part.text };
              case "file":
                return {
                  type: "file",
                  mimeType: part.mimeType,
                  data: part.data instanceof Uint8Array ? encodeBase64(part.data) : part.data,
                };
              case "reasoning":
                return { type: "reasoning", text: part.text };
              case "tool-call":
                return {
                  type: "tool-call",
                  toolCallId: part.toolCallId,
                  toolName: part.toolName,
                  args: part.args,
                };
              default:
                throw new Error(`Unsupported assistant content type: ${(part as { type?: string }).type ?? "unknown"}`);
            }
          }),
        };

      case "tool":
        return {
          role: "tool",
          content: msg.content.map((part): AIToolResultPart => ({
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

/**
 * Convert our IPC result back to AI SDK format.
 */
function convertResultFromIPC(result: AIGenerateResult): LanguageModelV2GenerateResult {
  return {
    content: result.content.map((item) => {
      switch (item.type) {
        case "text":
          return { type: "text" as const, text: item.text };
        case "reasoning":
          return { type: "reasoning" as const, text: item.text };
        case "tool-call":
          return {
            type: "tool-call" as const,
            toolCallId: item.toolCallId,
            toolName: item.toolName,
            args: item.args,
          };
        default:
          throw new Error(`Unsupported response content type: ${(item as { type?: string }).type ?? "unknown"}`);
      }
    }),
    finishReason: result.finishReason,
    usage: result.usage,
    warnings: result.warnings,
    response: result.response
      ? {
          id: result.response.id,
          modelId: result.response.modelId,
          timestamp: result.response.timestamp ? new Date(result.response.timestamp) : undefined,
        }
      : undefined,
  };
}

/**
 * Convert IPC stream chunk to AI SDK format.
 */
function convertStreamPartFromIPC(chunk: AIStreamPart): LanguageModelV2StreamPart {
  if (chunk.type === "response-metadata") {
    return {
      type: "response-metadata",
      id: chunk.id,
      modelId: chunk.modelId,
      timestamp: chunk.timestamp ? new Date(chunk.timestamp) : undefined,
    };
  }
  // Most types are already compatible
  return chunk as LanguageModelV2StreamPart;
}

// =============================================================================
// Proxy Model Factory
// =============================================================================

/**
 * Create a proxy language model that routes requests through IPC.
 */
function createProxyModel(modelId: string, provider: string): LanguageModelV2 {
  const bridge = getBridge();

  return {
    specificationVersion: "v2",
    provider: `natstack-proxy:${provider}`,
    modelId,
    supportedUrls: {},

    async doGenerate(options: LanguageModelV2CallOptions): Promise<LanguageModelV2GenerateResult> {
      const ipcOptions: AICallOptions = {
        prompt: convertPromptToIPC(options.prompt),
        maxOutputTokens: options.maxOutputTokens,
        temperature: options.temperature,
        topP: options.topP,
        topK: options.topK,
        presencePenalty: options.presencePenalty,
        frequencyPenalty: options.frequencyPenalty,
        stopSequences: options.stopSequences,
        seed: options.seed,
        responseFormat: options.responseFormat as AICallOptions["responseFormat"],
        tools: options.tools?.map((t) => ({
          type: "function" as const,
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
        toolChoice: options.toolChoice as AICallOptions["toolChoice"],
        providerOptions: options.providerOptions,
      };

      const result = await bridge.ai.generate(modelId, ipcOptions);
      return convertResultFromIPC(result);
    },

    async doStream(options: LanguageModelV2CallOptions): Promise<LanguageModelV2StreamResult> {
      const streamId = crypto.randomUUID();
      registerUnloadCancelHook();

      const ipcOptions: AICallOptions = {
        prompt: convertPromptToIPC(options.prompt),
        maxOutputTokens: options.maxOutputTokens,
        temperature: options.temperature,
        topP: options.topP,
        topK: options.topK,
        presencePenalty: options.presencePenalty,
        frequencyPenalty: options.frequencyPenalty,
        stopSequences: options.stopSequences,
        seed: options.seed,
        responseFormat: options.responseFormat as AICallOptions["responseFormat"],
        tools: options.tools?.map((t) => ({
          type: "function" as const,
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
        toolChoice: options.toolChoice as AICallOptions["toolChoice"],
        providerOptions: options.providerOptions,
      };

      const cancelStream = () => {
        const cancel = activeStreamCancelers.get(streamId);
        if (cancel) {
          cancel();
        }
      };

      // Create a ReadableStream that receives chunks from IPC events
      const stream = new ReadableStream<LanguageModelV2StreamPart>({
        start(controller) {
          let ended = false;

          const unsubChunk = bridge.ai.onStreamChunk((sid, chunk) => {
            if (sid === streamId && !ended) {
              controller.enqueue(convertStreamPartFromIPC(chunk));
            }
          });

          const unsubEnd = bridge.ai.onStreamEnd((sid) => {
            if (sid === streamId && !ended) {
              ended = true;
              unsubChunk();
              unsubEnd();
              controller.close();
              activeStreamCancelers.delete(streamId);
            }
          });

          // Handle abort signal
          if (options.abortSignal) {
            options.abortSignal.addEventListener("abort", () => {
              if (!ended) {
                ended = true;
                unsubChunk();
                unsubEnd();
                cancelStream();
                controller.error(new Error("Aborted"));
              }
            });
          }
        },
      });

      // Start the stream on the main process
      const cancelWrapper = () => {
        activeStreamCancelers.delete(streamId);
        void bridge.ai.streamCancel(streamId).catch((error) => {
          console.error("Failed to cancel AI stream", error);
        });
      };
      activeStreamCancelers.set(streamId, cancelWrapper);

      try {
        await bridge.ai.streamStart(modelId, ipcOptions, streamId);
      } catch (error) {
        activeStreamCancelers.delete(streamId);
        throw error;
      }

      return { stream };
    },
  };
}

// =============================================================================
// Public API
// =============================================================================

/** Cache of proxy models by model ID */
const modelCache = new Map<string, LanguageModelV2>();

/** Cache of available models */
let availableModelsCache: AIModelInfo[] | null = null;

/**
 * Get the list of available AI models.
 * Models are configured in the main process based on user settings.
 */
export async function getAvailableModels(): Promise<AIModelInfo[]> {
  if (availableModelsCache) {
    return availableModelsCache;
  }

  const bridge = getBridge();
  availableModelsCache = await bridge.ai.listModels();
  return availableModelsCache;
}

/**
 * Get a proxy model by ID.
 * The model ID should match one returned by getAvailableModels().
 */
export function getModel(modelId: string): LanguageModelV2 {
  let model = modelCache.get(modelId);
  if (!model) {
    // Extract provider from model ID if present (format: "provider:model")
    const provider = modelId.includes(":") ? (modelId.split(":")[0] ?? "unknown") : "unknown";
    model = createProxyModel(modelId, provider);
    modelCache.set(modelId, model);
  }
  return model;
}

/**
 * Record of available models as proxy objects.
 * This is populated lazily - call getAvailableModels() first to ensure models are loaded.
 *
 * Usage:
 * ```typescript
 * import { models, getAvailableModels } from 'natstack/ai';
 *
 * // First, load available models
 * await getAvailableModels();
 *
 * // Then use them
 * const result = await generateText({
 *   model: models['claude-sonnet'],
 *   prompt: 'Hello!'
 * });
 * ```
 */
export const models: Record<string, LanguageModelV2> = new Proxy({} as Record<string, LanguageModelV2>, {
  get(_target, prop: string) {
    return getModel(prop);
  },
  has(_target, prop: string) {
    // Always return true - we create models on demand
    return typeof prop === "string";
  },
  ownKeys() {
    // Return cached model IDs if available
    return availableModelsCache?.map((m) => m.id) ?? [];
  },
  getOwnPropertyDescriptor(_target, prop) {
    if (typeof prop === "string") {
      return {
        enumerable: true,
        configurable: true,
        value: getModel(prop),
      };
    }
    return undefined;
  },
});

/**
 * Clear the model cache. Useful if model availability changes.
 */
export function clearModelCache(): void {
  modelCache.clear();
  availableModelsCache = null;
}

// Re-export types for convenience
export type { AIModelInfo };
