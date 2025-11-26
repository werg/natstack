/**
 * Panel AI Runtime - Proxy models for the Vercel AI SDK
 *
 * This module provides AI SDK-compatible model objects that route requests
 * through IPC to the main process where API credentials are securely stored.
 *
 * Panels access models by role (fast, smart, coding, cheap) rather than by
 * provider-specific model IDs. All four standard roles are always available
 * with intelligent defaults applied when not explicitly configured.
 *
 * Usage:
 * ```typescript
 * import { models, getRoles } from '@natstack/ai';
 * import { generateText, streamText } from 'ai';
 *
 * // Load role-to-model mappings (includes all standard roles)
 * const roles = await getRoles();
 * console.log(roles.fast); // { modelId: "...", provider: "...", displayName: "..." }
 *
 * // Use models by role name
 * const result = await generateText({
 *   model: models.fast,
 *   prompt: 'Hello!'
 * });
 * ```
 */

import type {
  AICallOptions,
  AIGenerateResult,
  AIStreamPart,
  AIMessage,
  AITextPart,
  AIFilePart,
  AIToolResultPart,
  AIReasoningPart,
  AIToolCallPart,
  AIResponseContent,
  AIRoleRecord,
  AIModelInfo,
  AIToolDefinition,
} from "./types.js";
import { encodeBase64 } from "./base64.js";

// =============================================================================
// Claude Code Conversation Types
// =============================================================================

/** Information about a started Claude Code conversation */
export interface ClaudeCodeConversationInfo {
  conversationId: string;
  /** MCP tool names that were registered (for debugging) */
  registeredTools: string[];
}

/** Tool execution result */
export interface ClaudeCodeToolResult {
  /** Text content of the result */
  content: Array<{ type: "text"; text: string }>;
  /** Whether the tool execution resulted in an error */
  isError?: boolean;
}

/** Tool callback function type */
export type ClaudeCodeToolCallback = (
  args: Record<string, unknown>
) => Promise<ClaudeCodeToolResult>;

/** Tool definition with callback for Claude Code conversations */
export interface ClaudeCodeToolWithCallback {
  description?: string;
  parameters: Record<string, unknown>;
  execute: ClaudeCodeToolCallback;
}

// Re-export all AI IPC and model types for consumers
export type * from "./types.js";

// =============================================================================
// Bridge Interface
// =============================================================================

interface AIBridge {
  generate(modelId: string, options: AICallOptions): Promise<AIGenerateResult>;
  streamStart(modelId: string, options: AICallOptions, streamId: string): Promise<void>;
  streamCancel(streamId: string): Promise<void>;
  listRoles(): Promise<AIRoleRecord>;
  onStreamChunk(listener: (streamId: string, chunk: AIStreamPart) => void): () => void;
  onStreamEnd(listener: (streamId: string) => void): () => void;

  // Claude Code conversation API
  ccConversationStart(
    modelId: string,
    tools: AIToolDefinition[],
    callbacks: Record<string, (args: Record<string, unknown>) => Promise<ClaudeCodeToolResult>>
  ): Promise<ClaudeCodeConversationInfo>;
  ccGenerate(conversationId: string, options: AICallOptions): Promise<AIGenerateResult>;
  ccStreamStart(conversationId: string, options: AICallOptions, streamId: string): Promise<void>;
  ccConversationEnd(conversationId: string): Promise<void>;

  // Register tool callbacks for inline Claude Code streaming
  registerToolCallbacks(
    callbacks: Record<string, (args: Record<string, unknown>) => Promise<ClaudeCodeToolResult>>
  ): () => void;
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
  responseFormat?:
    | { type: "text" }
    | { type: "json"; schema?: unknown; name?: string; description?: string };
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
  | {
      role: "assistant";
      content: Array<
        | LanguageModelV2TextPart
        | LanguageModelV2FilePart
        | LanguageModelV2ReasoningPart
        | LanguageModelV2ToolCallPart
      >;
    }
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
  content: Array<
    | { type: "text"; text: string }
    | { type: "reasoning"; text: string }
    | { type: "tool-call"; toolCallId: string; toolName: string; args: unknown }
  >;
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
  | {
      type: "finish";
      finishReason: string;
      usage: { promptTokens: number; completionTokens: number };
    }
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
            throw new Error(
              `Unsupported user content type: ${(part as { type?: string }).type ?? "unknown"}`
            );
          }),
        };

      case "assistant":
        return {
          role: "assistant",
          content: msg.content.map(
            (part): AITextPart | AIFilePart | AIReasoningPart | AIToolCallPart => {
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
                  throw new Error(
                    `Unsupported assistant content type: ${(part as { type?: string }).type ?? "unknown"}`
                  );
              }
            }
          ),
        };

      case "tool":
        return {
          role: "tool",
          content: msg.content.map((part: AIToolResultPart) => ({
            type: "tool-result",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            result: part.result,
            isError: part.isError,
          })),
        };

      default:
        throw new Error(
          `Unsupported message role: ${(msg as { role?: string }).role ?? "unknown"}`
        );
    }
  });
}

/**
 * Convert our IPC result back to AI SDK format.
 */
function convertResultFromIPC(result: AIGenerateResult): LanguageModelV2GenerateResult {
  return {
    content: result.content.map((item: AIResponseContent) => {
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
          throw new Error(
            `Unsupported response content type: ${(item as { type?: string }).type ?? "unknown"}`
          );
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

/** Cache of available role-to-model mappings */
let roleRecordCache: AIRoleRecord | null = null;

/**
 * Get the record of configured roles and their assigned models.
 *
 * All four standard roles (smart, fast, coding, cheap) are always present with
 * intelligent defaults applied when not explicitly configured:
 * - smart ↔ coding (both prefer fast if available)
 * - cheap ↔ fast (both prefer smart if available)
 *
 * @returns Record mapping role names to model info (always includes all standard roles)
 *
 * Usage:
 * ```typescript
 * const roles = await getRoles();
 * console.log(roles.fast); // { modelId: "anthropic:claude-haiku-...", provider: "anthropic", ... }
 * console.log(roles.smart); // Always available (with defaults if not configured)
 * ```
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
 * Get a proxy model by role name.
 * Call getRoles() first to ensure roles are loaded.
 *
 * @param role - The role name (e.g., "fast", "smart", "coding", "cheap")
 * @returns A proxy model for this role, or null if role is not configured
 *
 * Usage:
 * ```typescript
 * import { getModelByRole, getRoles } from '@natstack/ai';
 *
 * // Load roles first
 * await getRoles();
 *
 * // Get model by role
 * const fastModel = getModelByRole('fast');
 * if (fastModel) {
 *   const result = await generateText({
 *     model: fastModel,
 *     prompt: 'Hello!'
 *   });
 * }
 * ```
 */
export function getModelByRole(role: string): LanguageModelV2 | null {
  if (!roleRecordCache) {
    throw new Error(
      "Roles not loaded. Call getRoles() first to load role information."
    );
  }

  const modelInfo = roleRecordCache[role];
  if (!modelInfo) {
    return null;
  }

  // Get or create proxy model for this model ID
  let model = modelCache.get(modelInfo.modelId);
  if (!model) {
    model = createProxyModel(modelInfo.modelId, modelInfo.provider);
    modelCache.set(modelInfo.modelId, model);
  }
  return model;
}

/**
 * Proxy record of AI models, keyed by role name.
 *
 * Access models by standard role names (fast, smart, coding, cheap) or custom roles.
 * Call getRoles() first to ensure roles are loaded.
 *
 * Usage:
 * ```typescript
 * import { models, getRoles } from '@natstack/ai';
 * import { generateText } from 'ai';
 *
 * // Load roles first
 * await getRoles();
 *
 * // Access models by role - all standard roles are guaranteed to exist
 * const result = await generateText({
 *   model: models.fast,  // Fast/cheap model
 *   prompt: 'Quick summary'
 * });
 *
 * const analysis = await generateText({
 *   model: models.smart,  // Smart/reasoning model
 *   prompt: 'Detailed analysis'
 * });
 * ```
 */
export const models: Record<string, LanguageModelV2> = new Proxy(
  {} as Record<string, LanguageModelV2>,
  {
    get(_target, prop: string) {
      return getModelByRole(prop);
    },
    has(_target, prop: string) {
      if (!roleRecordCache) return false;
      return prop in roleRecordCache;
    },
    ownKeys() {
      // Return role names if available
      return roleRecordCache ? Object.keys(roleRecordCache) : [];
    },
    getOwnPropertyDescriptor(_target, prop) {
      if (typeof prop === "string" && roleRecordCache && prop in roleRecordCache) {
        return {
          enumerable: true,
          configurable: true,
          value: getModelByRole(prop),
        };
      }
      return undefined;
    },
  }
);

/**
 * Clear the model cache. Useful if role configuration changes.
 */
export function clearModelCache(): void {
  modelCache.clear();
  roleRecordCache = null;
}

/**
 * Register tool callbacks for inline Claude Code streaming.
 *
 * When using a Claude Code model with tools via the regular `models[role].doStream()` API,
 * these callbacks will be invoked when Claude calls tools. This enables tool use without
 * explicitly creating a Claude Code conversation.
 *
 * @param callbacks - Map of tool name to callback function. Each callback receives the
 *   tool arguments and should return a ClaudeCodeToolResult.
 * @returns A cleanup function to unregister the callbacks
 *
 * @example
 * ```typescript
 * import { models, registerToolCallbacks, ClaudeCodeToolResult } from '@natstack/ai';
 *
 * // Register tool callbacks before streaming
 * const cleanup = registerToolCallbacks({
 *   get_current_time: async () => ({
 *     content: [{ type: 'text', text: new Date().toISOString() }]
 *   }),
 *   calculate: async ({ expression }) => ({
 *     content: [{ type: 'text', text: String(eval(expression)) }]
 *   })
 * });
 *
 * // Use the model with tools - callbacks will be invoked automatically
 * const { stream } = await models.fast.doStream({
 *   prompt: [{ role: 'user', content: [{ type: 'text', text: 'What time is it?' }] }],
 *   tools: [{ type: 'function', name: 'get_current_time', ... }]
 * });
 *
 * // Clean up when done
 * cleanup();
 * ```
 */
export function registerToolCallbacks(
  callbacks: Record<string, ClaudeCodeToolCallback>
): () => void {
  const bridge = getBridge();
  return bridge.ai.registerToolCallbacks(callbacks);
}

// =============================================================================
// Claude Code Conversation API
// =============================================================================

/**
 * Claude Code conversation handle for interacting with a conversation.
 */
export interface ClaudeCodeConversation {
  /** Unique ID for this conversation */
  readonly conversationId: string;
  /** MCP tool names that were registered */
  readonly registeredTools: string[];

  /**
   * Get a proxy model for this conversation.
   * Use this with AI SDK's generateText/streamText.
   */
  getModel(): LanguageModelV2;

  /**
   * Generate text using this conversation.
   */
  generate(options: Omit<LanguageModelV2CallOptions, "tools" | "toolChoice">): Promise<LanguageModelV2GenerateResult>;

  /**
   * Stream text using this conversation.
   */
  stream(options: Omit<LanguageModelV2CallOptions, "tools" | "toolChoice">): Promise<LanguageModelV2StreamResult>;

  /**
   * End the conversation and clean up resources.
   */
  end(): Promise<void>;
}

/**
 * Options for creating a Claude Code conversation.
 */
export interface CreateClaudeCodeConversationOptions {
  /**
   * Model to use (e.g., "claude-code:sonnet", "claude-code:opus", "claude-code:haiku")
   * or just the model name ("sonnet", "opus", "haiku")
   */
  model: string;

  /**
   * Tools with callbacks that will be executed when Claude calls them.
   */
  tools: Record<string, ClaudeCodeToolWithCallback>;
}

/**
 * Create a Claude Code conversation with tools.
 *
 * This creates a dedicated Claude Code session where tools are executed via
 * callbacks in your panel code. This enables Claude Code to use your custom
 * tools while leveraging its CLI-based authentication.
 *
 * @example
 * ```typescript
 * import { createClaudeCodeConversation } from '@natstack/ai';
 * import { generateText } from 'ai';
 *
 * const conversation = await createClaudeCodeConversation({
 *   model: 'sonnet',
 *   tools: {
 *     search: {
 *       description: 'Search the database',
 *       parameters: {
 *         type: 'object',
 *         properties: {
 *           query: { type: 'string', description: 'Search query' }
 *         },
 *         required: ['query']
 *       },
 *       execute: async ({ query }) => {
 *         const results = await searchDatabase(query);
 *         return {
 *           content: [{ type: 'text', text: JSON.stringify(results) }]
 *         };
 *       }
 *     }
 *   }
 * });
 *
 * // Use with AI SDK
 * const { text } = await generateText({
 *   model: conversation.getModel(),
 *   prompt: 'Search for cats in the database'
 * });
 *
 * // Clean up when done
 * await conversation.end();
 * ```
 */
export async function createClaudeCodeConversation(
  options: CreateClaudeCodeConversationOptions
): Promise<ClaudeCodeConversation> {
  const bridge = getBridge();

  // Normalize model ID
  let modelId = options.model;
  if (!modelId.includes(":")) {
    modelId = `claude-code:${modelId}`;
  }

  // Convert tools to the format expected by the bridge
  const toolDefinitions: AIToolDefinition[] = [];
  const callbacks: Record<string, (args: Record<string, unknown>) => Promise<ClaudeCodeToolResult>> = {};

  for (const [name, toolDef] of Object.entries(options.tools)) {
    toolDefinitions.push({
      type: "function",
      name,
      description: toolDef.description,
      parameters: toolDef.parameters,
    });
    callbacks[name] = toolDef.execute;
  }

  // Start the conversation
  const info = await bridge.ai.ccConversationStart(modelId, toolDefinitions, callbacks);

  // Create a proxy model for this conversation
  const createConversationModel = (): LanguageModelV2 => ({
    specificationVersion: "v2",
    provider: "claude-code-conversation",
    modelId: info.conversationId,
    supportedUrls: {},

    async doGenerate(callOptions: LanguageModelV2CallOptions): Promise<LanguageModelV2GenerateResult> {
      const ipcOptions: AICallOptions = {
        prompt: convertPromptToIPC(callOptions.prompt),
        maxOutputTokens: callOptions.maxOutputTokens,
        temperature: callOptions.temperature,
        topP: callOptions.topP,
        topK: callOptions.topK,
        presencePenalty: callOptions.presencePenalty,
        frequencyPenalty: callOptions.frequencyPenalty,
        stopSequences: callOptions.stopSequences,
        seed: callOptions.seed,
        responseFormat: callOptions.responseFormat as AICallOptions["responseFormat"],
        providerOptions: callOptions.providerOptions,
        // Note: tools are configured in the conversation, not passed here
      };

      const result = await bridge.ai.ccGenerate(info.conversationId, ipcOptions);
      return convertResultFromIPC(result);
    },

    async doStream(callOptions: LanguageModelV2CallOptions): Promise<LanguageModelV2StreamResult> {
      const streamId = crypto.randomUUID();
      registerUnloadCancelHook();

      const ipcOptions: AICallOptions = {
        prompt: convertPromptToIPC(callOptions.prompt),
        maxOutputTokens: callOptions.maxOutputTokens,
        temperature: callOptions.temperature,
        topP: callOptions.topP,
        topK: callOptions.topK,
        presencePenalty: callOptions.presencePenalty,
        frequencyPenalty: callOptions.frequencyPenalty,
        stopSequences: callOptions.stopSequences,
        seed: callOptions.seed,
        responseFormat: callOptions.responseFormat as AICallOptions["responseFormat"],
        providerOptions: callOptions.providerOptions,
      };

      const cancelStream = () => {
        const cancel = activeStreamCancelers.get(streamId);
        if (cancel) {
          cancel();
        }
      };

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

          if (callOptions.abortSignal) {
            callOptions.abortSignal.addEventListener("abort", () => {
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

      const cancelWrapper = () => {
        activeStreamCancelers.delete(streamId);
        void bridge.ai.streamCancel(streamId).catch((error) => {
          console.error("Failed to cancel Claude Code stream", error);
        });
      };
      activeStreamCancelers.set(streamId, cancelWrapper);

      try {
        await bridge.ai.ccStreamStart(info.conversationId, ipcOptions, streamId);
      } catch (error) {
        activeStreamCancelers.delete(streamId);
        throw error;
      }

      return { stream };
    },
  });

  const model = createConversationModel();

  return {
    conversationId: info.conversationId,
    registeredTools: info.registeredTools,

    getModel: () => model,

    async generate(callOptions) {
      return model.doGenerate({
        ...callOptions,
        tools: undefined,
        toolChoice: undefined,
      });
    },

    async stream(callOptions) {
      return model.doStream({
        ...callOptions,
        tools: undefined,
        toolChoice: undefined,
      });
    },

    async end() {
      await bridge.ai.ccConversationEnd(info.conversationId);
    },
  };
}
