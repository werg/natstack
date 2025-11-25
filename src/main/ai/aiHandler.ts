/**
 * AI Handler for managing LLM API calls.
 *
 * This handler:
 * - Routes AI SDK requests from panels through IPC to the main process
 * - Manages provider registration and model discovery
 * - Handles streaming and error propagation
 * - Provides structured logging and error codes
 *
 * Security:
 * - Derives panel identity from Electron sender, not from request parameters
 * - Validates all responses from AI SDK
 * - Implements stream resource limits and cleanup
 */

import { handle } from "../ipc/handlers.js";
import type { PanelManager } from "../panelManager.js";
import type {
  AICallOptions,
  AIGenerateResult,
  AIRoleRecord,
  AIModelInfo,
  AIStreamPart,
  AIMessage,
  AIToolDefinition,
  AITextPart,
  AIFilePart,
  AIReasoningPart,
  AIToolCallPart,
  AIToolResultPart,
  AIFinishReason,
} from "@natstack/ai";
import { createAIError, mapAISDKError, type AIError } from "../../shared/errors.js";
import { Logger, generateRequestId } from "../../shared/logging.js";
import {
  validatePrompt,
  validateToolDefinitions,
  validateSDKResponse,
} from "../../shared/validation.js";

// =============================================================================
// AI SDK Types
// =============================================================================

// Support both v2 and v3 language models from the AI SDK
interface LanguageModel {
  specificationVersion: "v2" | "v3";
  provider: string;
  modelId: string;
  doGenerate(options: unknown): PromiseLike<unknown>;
  doStream(options: unknown): PromiseLike<{ stream: ReadableStream<unknown> }>;
}

type AISDKProvider = (modelId: string) => LanguageModel;

// =============================================================================
// Type Converters
// =============================================================================

/**
 * Convert our serializable AIMessage format to AI SDK's LanguageModelV2Prompt format.
 * Validates all message content before conversion.
 * @throws AIError if message format is invalid
 */
function convertPromptToSDK(messages: AIMessage[]): unknown[] {
  const prompt = validatePrompt(messages);

  return prompt.map((msg, msgIndex) => {
    switch (msg.role) {
      case "system":
        return { role: "system", content: msg.content };

      case "user":
        return {
          role: "user",
          content: msg.content.map((part: AITextPart | AIFilePart, partIndex: number) => {
            if (part.type === "text") {
              return { type: "text", text: part.text };
            }
            return {
              type: "file",
              mimeType: part.mimeType,
              data: decodeBinary(part.data, `prompt[${msgIndex}].content[${partIndex}]`),
            };
          }),
        };

      case "assistant":
        return {
          role: "assistant",
          content: msg.content.map(
            (
              part: AITextPart | AIFilePart | AIReasoningPart | AIToolCallPart,
              partIndex: number
            ) => {
              switch (part.type) {
                case "text":
                  return { type: "text", text: part.text };
                case "file":
                  return {
                    type: "file",
                    mimeType: part.mimeType,
                    data: decodeBinary(part.data, `prompt[${msgIndex}].content[${partIndex}]`),
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
                  return part;
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
        return msg;
    }
  });
}

/**
 * Convert our AIToolDefinition to AI SDK's tool format.
 * @throws AIError if tool definition is invalid
 */
function convertToolsToSDK(tools: AIToolDefinition[] | undefined): unknown[] | undefined {
  const validated = validateToolDefinitions(tools);
  if (!validated) return undefined;

  return validated.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

function decodeBinary(data: string, context: string): Uint8Array {
  try {
    return new Uint8Array(Buffer.from(data, "base64"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw createAIError("internal_error", `${context}: invalid base64 data (${message})`);
  }
}

/**
 * Convert AI SDK response content to our serializable format.
 */

// =============================================================================
// Stream Management
// =============================================================================

/**
 * Manages the lifecycle of active AI streams.
 * Ensures cleanup and prevents resource leaks.
 */
class AIStreamManager {
  private activeStreams = new Map<string, AbortController>();
  private streamTimeouts = new Map<string, NodeJS.Timeout>();
  private readonly MAX_STREAM_DURATION = 10 * 60 * 1000; // 10 minutes
  private readonly logger = new Logger("AIStreamManager");

  startTracking(streamId: string, abortController: AbortController, requestId: string): void {
    this.activeStreams.set(streamId, abortController);

    // Set timeout to prevent runaway streams
    const timeout = setTimeout(() => {
      this.logger.warn(requestId, "Stream exceeded maximum duration", { streamId });
      this.cancelStream(streamId);
    }, this.MAX_STREAM_DURATION);

    this.streamTimeouts.set(streamId, timeout);
  }

  cancelStream(streamId: string): void {
    const controller = this.activeStreams.get(streamId);
    if (controller) {
      controller.abort();
      this.activeStreams.delete(streamId);
    }

    const timeout = this.streamTimeouts.get(streamId);
    if (timeout) {
      clearTimeout(timeout);
      this.streamTimeouts.delete(streamId);
    }
  }

  cleanup(streamId: string): void {
    this.cancelStream(streamId);
  }

  isActive(streamId: string): boolean {
    return this.activeStreams.has(streamId);
  }
}

// =============================================================================
// Provider Registry
// =============================================================================

export interface AIProviderConfig {
  id: string;
  name: string;
  createModel: AISDKProvider;
  models: Array<{
    id: string;
    displayName: string;
    description?: string;
  }>;
}

/**
 * Internal model info with id field (not the same as AIModelInfo from types.ts)
 */
interface InternalModelInfo {
  id: string;
  provider: string;
  displayName: string;
  description?: string;
}

/**
 * Manages registered AI providers and model discovery.
 */
class AIProviderRegistry {
  private providers = new Map<string, AIProviderConfig>();
  private logger = new Logger("AIProviderRegistry");

  registerProvider(config: AIProviderConfig, requestId: string): void {
    this.providers.set(config.id, config);
    this.logger.info(requestId, "Provider registered", {
      providerId: config.id,
      modelCount: config.models.length,
    });
  }

  getAvailableModels(): InternalModelInfo[] {
    const models: InternalModelInfo[] = [];
    for (const [providerId, config] of this.providers) {
      for (const model of config.models) {
        models.push({
          id: model.id,
          provider: providerId,
          displayName: model.displayName,
          description: model.description,
        });
      }
    }
    return models;
  }

  getModel(modelId: string): LanguageModel {
    // Model ID format: "provider:modelName" or just "modelName"
    let providerId: string | undefined;
    let modelName: string;

    if (modelId.includes(":")) {
      const parts = modelId.split(":", 2);
      providerId = parts[0];
      modelName = parts[1] ?? "";
    } else {
      modelName = modelId;
    }

    // If provider specified, use it directly
    if (providerId) {
      const provider = this.providers.get(providerId);
      if (!provider) {
        throw createAIError("provider_not_found", `Provider not found: ${providerId}`);
      }

      // Validate model exists in this provider
      const model = provider.models.find((m) => m.id === modelName);
      if (!model) {
        throw createAIError(
          "model_not_found",
          `Model not found in provider ${providerId}: ${modelName}`
        );
      }

      return provider.createModel(modelName);
    }

    // Search all providers for model with this ID
    for (const [_providerId, config] of this.providers) {
      const model = config.models.find((m) => m.id === modelId);
      if (model) {
        return config.createModel(model.id);
      }
    }

    throw createAIError("model_not_found", `Model not found: ${modelId}`);
  }
}

// =============================================================================
// AI Handler
// =============================================================================

export class AIHandler {
  private registry = new AIProviderRegistry();
  private streamManager = new AIStreamManager();
  private logger = new Logger("AIHandler");
  private modelRoleResolver: import("./modelRoles.js").ModelRoleResolver | null = null;

  constructor(private panelManager: PanelManager) {
    this.registerHandlers();
  }

  registerProvider(config: AIProviderConfig): void {
    const requestId = generateRequestId();
    this.registry.registerProvider(config, requestId);
  }

  /**
   * Clear all registered providers
   */
  clearProviders(): void {
    this.registry = new AIProviderRegistry();
    const requestId = generateRequestId();
    this.logger.info(requestId, "All providers cleared");
  }

  /**
   * Initialize providers and model roles.
   * - Model roles come from central config (~/.config/natstack/config.yml)
   * - API keys come from central config (.secrets.yml or .env)
   */
  async initialize(): Promise<void> {
    const requestId = generateRequestId();
    this.logger.info(requestId, "Initializing AI handler");

    // Clear existing providers
    this.clearProviders();

    // Import dynamically to avoid circular dependencies at module load time
    const { createProviderFromConfig, getSupportedProviders } = await import("./providerFactory.js");
    const { ModelRoleResolver } = await import("./modelRoles.js");
    const { loadCentralConfig } = await import("../workspace/loader.js");

    // Load model roles from central config
    const centralConfig = loadCentralConfig();
    this.modelRoleResolver = new ModelRoleResolver(centralConfig.models);

    // Auto-detect providers from environment variables
    // API keys come from central .secrets.yml (loaded into env) or .env file
    let registeredCount = 0;
    for (const providerId of getSupportedProviders()) {
      const providerRegistration = createProviderFromConfig(providerId);
      if (providerRegistration) {
        this.registerProvider(providerRegistration);
        registeredCount++;
      }
    }

    this.logger.info(requestId, "AI handler initialization complete", { registeredCount });
  }

  /**
   * Resolve a model role or ID to the actual model ID
   */
  resolveModelId(roleOrId: string): string {
    if (this.modelRoleResolver) {
      return this.modelRoleResolver.getModel(roleOrId);
    }
    return roleOrId;
  }

  /**
   * Get role-to-model mappings with defaults applied.
   *
   * Defaulting rules (applied only when a role is not explicitly configured):
   * - smart <-> coding (both prefer fast if available)
   * - cheap <-> fast (both prefer smart if available)
   *
   * This ensures all four standard roles always have a model assigned
   * as long as at least one role is configured.
   */
  getAvailableRoles(): AIRoleRecord {
    if (!this.modelRoleResolver) {
      // Return empty record if no resolver - won't satisfy AIRoleRecord type
      // but this should only happen during initialization
      return {} as AIRoleRecord;
    }

    const allModels = this.registry.getAvailableModels();

    // Helper to get model info for a role
    const getModelInfo = (role: 'smart' | 'coding' | 'fast' | 'cheap'): AIModelInfo | null => {
      const spec = this.modelRoleResolver?.resolveSpec(role);
      if (!spec) return null;

      // The spec.model is just the model name (e.g., "claude-haiku-4-5-20251001")
      // The registry stores models with this ID format
      const modelInfo = allModels.find(m => m.id === spec.model && m.provider === spec.provider);
      if (!modelInfo) return null;

      return {
        modelId: spec.modelId, // Keep the full format "provider:model"
        provider: modelInfo.provider,
        displayName: modelInfo.displayName,
        description: modelInfo.description,
      };
    };

    // Get explicitly configured roles
    const smart = getModelInfo('smart');
    const coding = getModelInfo('coding');
    const fast = getModelInfo('fast');
    const cheap = getModelInfo('cheap');

    // Apply defaulting rules
    // smart <-> coding, both prefer fast
    const smartFinal = smart || coding || fast || cheap;
    const codingFinal = coding || smart || fast || cheap;

    // cheap <-> fast, both prefer smart
    const fastFinal = fast || cheap || smart || coding;
    const cheapFinal = cheap || fast || smart || coding;

    if (!smartFinal || !codingFinal || !fastFinal || !cheapFinal) {
      // This should not happen if at least one provider is configured
      // Return a minimal valid record using the first available model
      const fallback = smartFinal || codingFinal || fastFinal || cheapFinal;
      if (fallback) {
        console.warn('[AI] Using fallback model for unconfigured roles. Consider configuring all standard roles in ~/.config/natstack/config.yml');
        console.warn(`[AI] Fallback model: ${fallback.displayName} (${fallback.modelId})`);
        return {
          smart: fallback,
          coding: fallback,
          fast: fallback,
          cheap: fallback,
        };
      }
      // No models available at all
      throw new Error('No AI models available. Please configure at least one provider.');
    }

    // Log if any roles are using fallback defaults
    const usedFallback =
      (smart === null && smartFinal !== null) ||
      (coding === null && codingFinal !== null) ||
      (fast === null && fastFinal !== null) ||
      (cheap === null && cheapFinal !== null);

    if (usedFallback) {
      const unconfiguredRoles = [];
      if (smart === null) unconfiguredRoles.push('smart');
      if (coding === null) unconfiguredRoles.push('coding');
      if (fast === null) unconfiguredRoles.push('fast');
      if (cheap === null) unconfiguredRoles.push('cheap');
      console.warn(`[AI] Using fallback models for unconfigured roles: ${unconfiguredRoles.join(', ')}`);
    }

    // Build the final record with standard roles
    const roles: AIRoleRecord = {
      smart: smartFinal,
      coding: codingFinal,
      fast: fastFinal,
      cheap: cheapFinal,
    };

    // Add any custom roles (non-standard roles from config)
    // Note: Currently we only check standard roles, but this could be extended
    // to discover custom roles from the config if needed

    return roles;
  }

  private registerHandlers(): void {
    handle("ai:generate", async (event, modelId: string, options: AICallOptions) => {
      const requestId = generateRequestId();
      const panelId = this.getPanelId(event, requestId);
      // Resolve model role to actual model ID
      const resolvedModelId = this.resolveModelId(modelId);
      return this.generate(requestId, panelId, resolvedModelId, options);
    });

    handle(
      "ai:stream-start",
      async (event, modelId: string, options: AICallOptions, streamId: string) => {
        const requestId = generateRequestId();
        const panelId = this.getPanelId(event, requestId);
        // Resolve model role to actual model ID
        const resolvedModelId = this.resolveModelId(modelId);
        void this.streamToPanel(event.sender, requestId, panelId, resolvedModelId, options, streamId);
      }
    );

    handle("ai:stream-cancel", async (event, streamId: string) => {
      const requestId = generateRequestId();
      this.getPanelId(event, requestId); // Validate authorization
      this.streamManager.cancelStream(streamId);
    });

    handle("ai:list-roles", async (event) => {
      const requestId = generateRequestId();
      this.getPanelId(event, requestId); // Validate authorization
      return this.getAvailableRoles();
    });
  }

  /**
   * Get panel ID from sender and validate authorization.
   * @throws AIError if sender is not authorized
   */
  private getPanelId(event: Electron.IpcMainInvokeEvent, requestId: string): string {
    const panelId = this.panelManager.getPanelIdForWebContents(event.sender);
    if (!panelId) {
      this.logger.warn(requestId, "Unauthorized IPC call from unknown sender");
      throw createAIError("unauthorized", "Sender is not a registered panel");
    }
    this.logger.debug(requestId, "IPC call authorized", { panelId });
    return panelId;
  }

  private async generate(
    requestId: string,
    panelId: string,
    modelId: string,
    options: AICallOptions
  ): Promise<AIGenerateResult> {
    this.logger.info(requestId, "Generation request", { panelId, modelId });

    try {
      const model = this.registry.getModel(modelId);

      // Convert request to SDK format with validation
      let prompt: unknown[];
      let tools: unknown[] | undefined;

      try {
        prompt = convertPromptToSDK(options.prompt);
        tools = convertToolsToSDK(options.tools);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.logger.error(requestId, "Request conversion failed", { error: err.message }, err);
        throw error;
      }

      const sdkOptions = {
        prompt,
        maxOutputTokens: options.maxOutputTokens,
        temperature: options.temperature,
        topP: options.topP,
        topK: options.topK,
        presencePenalty: options.presencePenalty,
        frequencyPenalty: options.frequencyPenalty,
        stopSequences: options.stopSequences,
        seed: options.seed,
        responseFormat: options.responseFormat,
        tools,
        toolChoice: options.toolChoice,
        providerOptions: options.providerOptions,
      };

      // Call AI SDK with validation
      let result;
      try {
        result = (await model.doGenerate(sdkOptions)) as {
          content?: unknown[];
          finishReason?: string;
          usage?: { promptTokens?: number; completionTokens?: number };
          warnings?: Array<{ type: string; message: string; details?: unknown }>;
          response?: { id?: string; modelId?: string; timestamp?: Date };
        };
      } catch (error) {
        const aiError = mapAISDKError(error);
        this.logger.error(
          requestId,
          "AI SDK call failed",
          { code: aiError.code, message: aiError.message },
          error as Error
        );
        throw aiError;
      }

      // Validate and normalize SDK response
      const response = validateSDKResponse(result);

      this.logger.info(requestId, "Generation completed", {
        finishReason: response.finishReason,
        tokens: response.usage,
      });

      return response;
    } catch (error) {
      if (error instanceof Error && "code" in error) {
        throw error; // Re-throw AIError as-is
      }
      const aiError = createAIError("internal_error", "Unexpected error during generation");
      this.logger.error(requestId, "Unexpected error", { error: aiError.message }, error as Error);
      throw aiError;
    }
  }

  private async streamToPanel(
    sender: Electron.WebContents,
    requestId: string,
    panelId: string,
    modelId: string,
    options: AICallOptions,
    streamId: string
  ): Promise<void> {
    this.logger.info(requestId, "Stream started", { panelId, modelId, streamId });

    const abortController = new AbortController();
    this.streamManager.startTracking(streamId, abortController, requestId);

    const onDestroyed = (): void => {
      this.logger.info(requestId, "Panel destroyed, cancelling stream", { streamId });
      this.streamManager.cleanup(streamId);
    };

    sender.on("destroyed", onDestroyed);

    try {
      const model = this.registry.getModel(modelId);

      // Convert request to SDK format with validation
      let prompt: unknown[];
      let tools: unknown[] | undefined;

      try {
        prompt = convertPromptToSDK(options.prompt);
        tools = convertToolsToSDK(options.tools);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.logger.error(requestId, "Request conversion failed", { error: err.message }, err);
        this.sendStreamError(sender, panelId, streamId, error);
        return;
      }

      const sdkOptions = {
        prompt,
        maxOutputTokens: options.maxOutputTokens,
        temperature: options.temperature,
        topP: options.topP,
        topK: options.topK,
        presencePenalty: options.presencePenalty,
        frequencyPenalty: options.frequencyPenalty,
        stopSequences: options.stopSequences,
        seed: options.seed,
        responseFormat: options.responseFormat,
        tools,
        toolChoice: options.toolChoice,
        providerOptions: options.providerOptions,
        abortSignal: abortController.signal,
      };

      const { stream } = (await model.doStream(sdkOptions)) as { stream: ReadableStream<unknown> };
      const reader = stream.getReader();

      try {
        while (true) {
          if (sender.isDestroyed()) {
            abortController.abort();
            break;
          }

          const { done, value } = await reader.read();
          if (done) break;

          const chunk = this.convertStreamPart(value as Record<string, unknown>);
          if (chunk && !sender.isDestroyed()) {
            sender.send("ai:stream-chunk", { panelId, streamId, chunk });
          }
        }
      } finally {
        reader.releaseLock();
      }

      if (!sender.isDestroyed()) {
        sender.send("ai:stream-end", { panelId, streamId });
        this.logger.info(requestId, "Stream completed", { streamId });
      }
    } catch (error) {
      this.logger.error(requestId, "Stream error", { streamId }, error as Error);
      this.sendStreamError(sender, panelId, streamId, error);
    } finally {
      sender.removeListener("destroyed", onDestroyed);
      this.streamManager.cleanup(streamId);
    }
  }

  private sendStreamError(
    sender: Electron.WebContents,
    panelId: string,
    streamId: string,
    error: unknown
  ): void {
    if (sender.isDestroyed()) return;

    const aiError =
      error instanceof Error && "code" in error ? (error as AIError) : mapAISDKError(error);

    const errorChunk: AIStreamPart = {
      type: "error",
      error: aiError.message,
    };

    sender.send("ai:stream-chunk", { panelId, streamId, chunk: errorChunk });
    sender.send("ai:stream-end", { panelId, streamId });
  }

  private convertStreamPart(part: Record<string, unknown>): AIStreamPart | null {
    const type = part["type"] as string;

    switch (type) {
      case "text-start":
        return { type: "text-start", id: part["id"] as string };
      case "text-delta":
        return { type: "text-delta", id: part["id"] as string, delta: part["delta"] as string };
      case "text-end":
        return { type: "text-end", id: part["id"] as string };
      case "reasoning-start":
        return { type: "reasoning-start", id: part["id"] as string };
      case "reasoning-delta":
        return {
          type: "reasoning-delta",
          id: part["id"] as string,
          delta: part["delta"] as string,
        };
      case "reasoning-end":
        return { type: "reasoning-end", id: part["id"] as string };
      case "tool-input-start":
        return {
          type: "tool-input-start",
          toolCallId: part["toolCallId"] as string,
          toolName: part["toolName"] as string,
        };
      case "tool-input-delta":
        return {
          type: "tool-input-delta",
          toolCallId: part["toolCallId"] as string,
          inputTextDelta: part["inputTextDelta"] as string,
        };
      case "tool-input-end":
        return { type: "tool-input-end", toolCallId: part["toolCallId"] as string };
      case "stream-start":
        return {
          type: "stream-start",
          warnings: ((part["warnings"] as unknown[]) ?? []).map((w: unknown) => {
            const warn = w as { type: string; message: string; details?: unknown };
            return { type: warn.type, message: warn.message, details: warn.details };
          }),
        };
      case "response-metadata":
        return {
          type: "response-metadata",
          id: part["id"] as string | undefined,
          modelId: part["modelId"] as string | undefined,
          timestamp: part["timestamp"]
            ? ((part["timestamp"] as Date).toISOString?.() ?? String(part["timestamp"]))
            : undefined,
        };
      case "finish": {
        const finishReasonValue = part["finishReason"];
        const validFinishReasons: AIFinishReason[] = [
          "stop",
          "length",
          "content-filter",
          "tool-calls",
          "error",
          "other",
          "unknown",
        ];
        const finishReason = (
          typeof finishReasonValue === "string" &&
          validFinishReasons.includes(finishReasonValue as AIFinishReason)
            ? finishReasonValue
            : "unknown"
        ) as AIFinishReason;
        return {
          type: "finish",
          finishReason,
          usage: {
            promptTokens: (part["usage"] as { promptTokens?: number })?.promptTokens ?? 0,
            completionTokens:
              (part["usage"] as { completionTokens?: number })?.completionTokens ?? 0,
          },
        };
      }
      case "error": {
        const err = part["error"];
        return {
          type: "error",
          error: err instanceof Error ? err.message : String(err),
        };
      }
      default:
        return null;
    }
  }
}
