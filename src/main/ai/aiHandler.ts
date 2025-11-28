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
import type {
  ClaudeCodeConversationInfo,
  ClaudeCodeToolResult,
  ClaudeCodeToolExecuteRequest,
} from "../../shared/ipc/types.js";
import { createAIError, mapAISDKError, type AIError } from "../../shared/errors.js";
import { Logger, generateRequestId } from "../../shared/logging.js";
import {
  validatePrompt,
  validateToolDefinitions,
  validateSDKResponse,
} from "../../shared/validation.js";
import {
  getClaudeCodeConversationManager,
  type ClaudeCodeConversationManager,
} from "./claudeCodeConversationManager.js";
import { getMcpToolNames, type ToolExecutionResult } from "./claudeCodeToolProxy.js";

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
                    input: part.args, // AI SDK expects "input", not "args"
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
            // AI SDK expects output: { type: ..., value: ... } format
            output: {
              type: part.isError ? "error-json" : "json",
              value: part.result,
            },
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
    inputSchema: tool.parameters, // AI SDK uses inputSchema, not parameters
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
  private ccConversationManager: ClaudeCodeConversationManager;
  private ccConversationEndUnsub: (() => void) | null = null;

  // Pending tool executions: executionId -> { resolve, reject }
  private pendingToolExecutions = new Map<
    string,
    {
      resolve: (result: ToolExecutionResult) => void;
      reject: (error: Error) => void;
      timeoutId: NodeJS.Timeout;
      conversationId: string;
      panelId: string;
    }
  >();
  private readonly TOOL_EXECUTION_TIMEOUT = 5 * 60 * 1000; // 5 minutes

  constructor(private panelManager: PanelManager) {
    this.ccConversationManager = getClaudeCodeConversationManager();
    // Reject any outstanding tool executions when conversations are torn down elsewhere (e.g., panel removal)
    this.ccConversationEndUnsub = this.ccConversationManager.addConversationEndListener(
      (conversationId, panelId) => {
        this.rejectPendingToolExecutions(conversationId, panelId, "Conversation ended");
      }
    );
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
    const { createProviderFromConfig, getSupportedProviders } = await import(
      "./providerFactory.js"
    );
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
    const getModelInfo = (role: "smart" | "coding" | "fast" | "cheap"): AIModelInfo | null => {
      const spec = this.modelRoleResolver?.resolveSpec(role);
      if (!spec) return null;

      // The spec.model is just the model name (e.g., "claude-haiku-4-5-20251001")
      // The registry stores models with this ID format
      const modelInfo = allModels.find((m) => m.id === spec.model && m.provider === spec.provider);
      if (!modelInfo) return null;

      return {
        modelId: spec.modelId, // Keep the full format "provider:model"
        provider: modelInfo.provider,
        displayName: modelInfo.displayName,
        description: modelInfo.description,
      };
    };

    // Get explicitly configured roles
    const smart = getModelInfo("smart");
    const coding = getModelInfo("coding");
    const fast = getModelInfo("fast");
    const cheap = getModelInfo("cheap");

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
        console.warn(
          "[AI] Using fallback model for unconfigured roles. Consider configuring all standard roles in ~/.config/natstack/config.yml"
        );
        console.warn(`[AI] Fallback model: ${fallback.displayName} (${fallback.modelId})`);
        return {
          smart: fallback,
          coding: fallback,
          fast: fallback,
          cheap: fallback,
        };
      }
      // No models available at all
      throw new Error("No AI models available. Please configure at least one provider.");
    }

    // Log if any roles are using fallback defaults
    const usedFallback =
      (smart === null && smartFinal !== null) ||
      (coding === null && codingFinal !== null) ||
      (fast === null && fastFinal !== null) ||
      (cheap === null && cheapFinal !== null);

    if (usedFallback) {
      const unconfiguredRoles = [];
      if (smart === null) unconfiguredRoles.push("smart");
      if (coding === null) unconfiguredRoles.push("coding");
      if (fast === null) unconfiguredRoles.push("fast");
      if (cheap === null) unconfiguredRoles.push("cheap");
      console.warn(
        `[AI] Using fallback models for unconfigured roles: ${unconfiguredRoles.join(", ")}`
      );
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
        void this.streamToPanel(
          event.sender,
          requestId,
          panelId,
          resolvedModelId,
          options,
          streamId
        );
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

    // =========================================================================
    // Claude Code Conversation Handlers
    // =========================================================================

    handle(
      "ai:cc-conversation-start",
      async (
        event,
        modelId: string,
        tools: AIToolDefinition[]
      ): Promise<ClaudeCodeConversationInfo> => {
        const requestId = generateRequestId();
        const panelId = this.getPanelId(event, requestId);

        this.logger.info(requestId, "Starting Claude Code conversation", {
          panelId,
          modelId,
          toolCount: tools.length,
        });

        // Validate tools
        const validatedTools = validateToolDefinitions(tools);
        if (!validatedTools || validatedTools.length === 0) {
          throw createAIError(
            "api_error",
            "At least one tool is required for Claude Code conversations"
          );
        }

        // Extract the model name from the modelId (e.g., "claude-code:sonnet" -> "sonnet")
        const ccModelId = modelId.startsWith("claude-code:")
          ? modelId.substring("claude-code:".length)
          : modelId;

        // Use an object reference so the callback can access the correct conversation ID
        // after createConversation() sets it (the callback is created before we know the ID)
        const conversationRef = { id: "" };

        // Create a tool execution callback that sends requests to the panel via IPC
        const executeCallback = async (
          toolName: string,
          args: Record<string, unknown>
        ): Promise<ToolExecutionResult> => {
          const executionId = crypto.randomUUID();

          // Strip MCP prefix from tool name (mcp__serverName__toolName -> toolName)
          let simpleToolName = toolName;
          const mcpMatch = toolName.match(/^mcp__[^_]+__(.+)$/);
          if (mcpMatch) {
            simpleToolName = mcpMatch[1]!;
          }

          this.logger.debug(requestId, "Executing tool via panel", {
            executionId,
            toolName: simpleToolName,
            conversationId: conversationRef.id,
          });

          return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
              this.pendingToolExecutions.delete(executionId);
              reject(new Error(`Tool execution timed out: ${simpleToolName}`));
            }, this.TOOL_EXECUTION_TIMEOUT);

            this.pendingToolExecutions.set(executionId, {
              resolve,
              reject,
              timeoutId,
              conversationId: conversationRef.id,
              panelId,
            });

            const request: ClaudeCodeToolExecuteRequest = {
              panelId,
              executionId,
              conversationId: conversationRef.id,
              toolName: simpleToolName,
              args,
            };

            const panelWebContents = this.panelManager.getWebContentsForPanel(panelId);
            if (!panelWebContents || panelWebContents.isDestroyed()) {
              this.pendingToolExecutions.delete(executionId);
              clearTimeout(timeoutId);
              reject(new Error("Panel is not available"));
              return;
            }

            panelWebContents.send("ai:cc-tool-execute", request);
          });
        };

        // Create the conversation
        let conversationHandle: { conversationId: string };
        try {
          conversationHandle = this.ccConversationManager.createConversation({
            panelId,
            modelId: ccModelId,
            tools: validatedTools,
            executeCallback,
          });
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          this.logger.error(
            requestId,
            "Failed to create Claude Code conversation",
            { message: err.message },
            err
          );
          throw createAIError("api_error", err.message);
        }

        // Update the reference so the callback uses the correct conversation ID
        conversationRef.id = conversationHandle.conversationId;

        // Get the registered MCP tool names for debugging
        const registeredTools = getMcpToolNames(conversationHandle.conversationId, validatedTools);

        this.logger.info(requestId, "Claude Code conversation started", {
          conversationId: conversationHandle.conversationId,
          registeredTools,
        });

        return {
          conversationId: conversationHandle.conversationId,
          registeredTools,
        };
      }
    );

    handle(
      "ai:cc-generate",
      async (event, conversationId: string, options: AICallOptions): Promise<AIGenerateResult> => {
        const requestId = generateRequestId();
        const panelId = this.getPanelId(event, requestId);

        this.logger.info(requestId, "Claude Code generate", { panelId, conversationId });

        const conversation = this.ccConversationManager.getConversation(conversationId);
        if (!conversation) {
          throw createAIError("api_error", `Conversation not found: ${conversationId}`);
        }

        if (conversation.panelId !== panelId) {
          throw createAIError("unauthorized", "Conversation belongs to a different panel");
        }

        const model = this.ccConversationManager.getModel(conversationId);
        if (!model) {
          throw createAIError("internal_error", "Failed to get model for conversation");
        }

        // Convert request to SDK format (tools are already configured in the conversation)
        let prompt: unknown[];
        try {
          prompt = convertPromptToSDK(options.prompt);
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
          providerOptions: options.providerOptions,
          // Note: tools and toolChoice are handled by the conversation's MCP server
        };

        try {
          const result = (await model.doGenerate(sdkOptions)) as {
            content?: unknown[];
            finishReason?: string;
            usage?: { promptTokens?: number; completionTokens?: number };
            warnings?: Array<{ type: string; message: string; details?: unknown }>;
            response?: { id?: string; modelId?: string; timestamp?: Date };
          };

          const response = validateSDKResponse(result);

          this.logger.info(requestId, "Claude Code generation completed", {
            conversationId,
            finishReason: response.finishReason,
          });

          return response;
        } catch (error) {
          const aiError = mapAISDKError(error);
          this.logger.error(
            requestId,
            "Claude Code generation failed",
            { conversationId, code: aiError.code, message: aiError.message },
            error as Error
          );
          throw aiError;
        }
      }
    );

    handle(
      "ai:cc-stream-start",
      async (event, conversationId: string, options: AICallOptions, streamId: string) => {
        const requestId = generateRequestId();
        const panelId = this.getPanelId(event, requestId);

        this.logger.info(requestId, "Claude Code stream start", {
          panelId,
          conversationId,
          streamId,
        });

        const conversation = this.ccConversationManager.getConversation(conversationId);
        if (!conversation) {
          throw createAIError("api_error", `Conversation not found: ${conversationId}`);
        }

        if (conversation.panelId !== panelId) {
          throw createAIError("unauthorized", "Conversation belongs to a different panel");
        }

        // Run the stream in the background
        void this.ccStreamToPanel(
          event.sender,
          requestId,
          panelId,
          conversationId,
          options,
          streamId
        );
      }
    );

    handle("ai:cc-conversation-end", async (event, conversationId: string) => {
      const requestId = generateRequestId();
      const panelId = this.getPanelId(event, requestId);

      this.logger.info(requestId, "Ending Claude Code conversation", { panelId, conversationId });

      const conversation = this.ccConversationManager.getConversation(conversationId);
      if (!conversation) {
        this.logger.warn(requestId, "Conversation not found (may have already ended)", {
          conversationId,
        });
        return;
      }

      if (conversation.panelId !== panelId) {
        throw createAIError("unauthorized", "Conversation belongs to a different panel");
      }

      this.rejectPendingToolExecutions(conversationId, panelId, "Conversation ended");
      this.ccConversationManager.endConversation(conversationId);
    });

    handle(
      "ai:cc-tool-result",
      async (event, executionId: string, result: ClaudeCodeToolResult) => {
        const requestId = generateRequestId();
        this.getPanelId(event, requestId); // Validate authorization

        this.logger.debug(requestId, "Received tool result", {
          executionId,
          isError: result.isError,
        });

        const pending = this.pendingToolExecutions.get(executionId);
        if (!pending) {
          this.logger.warn(requestId, "No pending execution found for tool result", {
            executionId,
          });
          return;
        }

        clearTimeout(pending.timeoutId);
        this.pendingToolExecutions.delete(executionId);

        // Convert to ToolExecutionResult format
        pending.resolve({
          content: result.content,
          isError: result.isError,
        });
      }
    );
  }

  /**
   * Reject and clean up any pending tool executions for a conversation.
   */
  private rejectPendingToolExecutions(
    conversationId: string,
    panelId: string,
    reason: string
  ): void {
    for (const [executionId, pending] of this.pendingToolExecutions) {
      if (pending.conversationId === conversationId) {
        clearTimeout(pending.timeoutId);
        this.pendingToolExecutions.delete(executionId);
        pending.reject(new Error(reason));
        this.logger.debug("cleanup", "Rejected pending tool execution", {
          executionId,
          conversationId,
          panelId,
        });
      }
    }
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

    // Claude Code with tools requires the streaming conversation API
    const isClaudeCode = modelId.startsWith("claude-code:");
    const hasTools = options.tools && options.tools.length > 0;
    if (isClaudeCode && hasTools) {
      throw createAIError(
        "api_error",
        "Claude Code with tools requires streaming. Use doStream() with registerToolCallbacks() instead of doGenerate()."
      );
    }

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
    // Check if this is a Claude Code model with tools - needs special handling via MCP
    const isClaudeCode = modelId.startsWith("claude-code:");
    const hasTools = options.tools && options.tools.length > 0;

    if (isClaudeCode && hasTools) {
      // Route to Claude Code conversation-based streaming for tool support
      await this.streamClaudeCodeWithTools(sender, requestId, panelId, modelId, options, streamId);
      return;
    }

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

  /**
   * Stream with Claude Code model when tools are present.
   * Creates a temporary conversation with MCP proxy for tool execution.
   */
  private async streamClaudeCodeWithTools(
    sender: Electron.WebContents,
    requestId: string,
    panelId: string,
    modelId: string,
    options: AICallOptions,
    streamId: string
  ): Promise<void> {
    this.logger.info(requestId, "Claude Code stream with tools started", {
      panelId,
      modelId,
      streamId,
      toolCount: options.tools?.length ?? 0,
    });

    const abortController = new AbortController();
    this.streamManager.startTracking(streamId, abortController, requestId);

    const onDestroyed = (): void => {
      this.logger.info(requestId, "Panel destroyed, cancelling Claude Code stream", { streamId });
      this.streamManager.cleanup(streamId);
    };

    sender.on("destroyed", onDestroyed);

    // Extract the model name (e.g., "claude-code:sonnet" -> "sonnet")
    const ccModelId = modelId.startsWith("claude-code:")
      ? modelId.substring("claude-code:".length)
      : modelId;

    // Validate and convert tools
    const validatedTools = validateToolDefinitions(options.tools);
    if (!validatedTools || validatedTools.length === 0) {
      this.sendStreamError(
        sender,
        panelId,
        streamId,
        new Error("Tools are required for Claude Code")
      );
      return;
    }

    // Track pending tool executions for this specific stream
    const streamPendingTools = new Map<
      string,
      {
        resolve: (result: ToolExecutionResult) => void;
        reject: (error: Error) => void;
        timeoutId: NodeJS.Timeout;
      }
    >();

    // Use an object reference so the callback can access the correct conversation ID
    // after createConversation() sets it (the callback is created before we know the ID)
    const conversationRef = { id: "" };

    // Create tool execution callback
    const executeCallback = async (
      toolName: string,
      args: Record<string, unknown>
    ): Promise<ToolExecutionResult> => {
      const executionId = crypto.randomUUID();

      // Strip MCP prefix from tool name (mcp__serverName__toolName -> toolName)
      // The MCP server uses prefixed names internally, but panel callbacks use simple names
      let simpleToolName = toolName;
      const mcpMatch = toolName.match(/^mcp__[^_]+__(.+)$/);
      if (mcpMatch) {
        simpleToolName = mcpMatch[1]!;
      }

      this.logger.debug(requestId, "Executing tool via panel (inline)", {
        executionId,
        toolName,
        simpleToolName,
        conversationId: conversationRef.id,
      });

      return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          streamPendingTools.delete(executionId);
          reject(new Error(`Tool execution timed out: ${simpleToolName}`));
        }, this.TOOL_EXECUTION_TIMEOUT);

        streamPendingTools.set(executionId, { resolve, reject, timeoutId });

        // Also track in the main map so ai:cc-tool-result can find it
        this.pendingToolExecutions.set(executionId, {
          resolve,
          reject,
          timeoutId,
          conversationId: conversationRef.id,
          panelId,
        });

        const request: ClaudeCodeToolExecuteRequest = {
          panelId,
          executionId,
          conversationId: conversationRef.id,
          toolName: simpleToolName, // Use the simple name for panel callbacks
          args,
        };

        if (sender.isDestroyed()) {
          streamPendingTools.delete(executionId);
          this.pendingToolExecutions.delete(executionId);
          clearTimeout(timeoutId);
          reject(new Error("Panel is not available"));
          return;
        }

        sender.send("ai:cc-tool-execute", request);
      });
    };

    let actualConversationId: string | null = null;

    try {
      // Create the conversation
      const conversationHandle = this.ccConversationManager.createConversation({
        panelId,
        modelId: ccModelId,
        tools: validatedTools,
        executeCallback,
      });

      // Update the reference so the callback uses the correct conversation ID
      conversationRef.id = conversationHandle.conversationId;
      actualConversationId = conversationHandle.conversationId;

      this.logger.info(requestId, "Created inline Claude Code conversation", {
        conversationId: actualConversationId,
        toolCount: validatedTools.length,
      });

      // Get the model and stream
      const model = conversationHandle.getModel();

      // Convert prompt
      let prompt: unknown[];
      try {
        prompt = convertPromptToSDK(options.prompt);
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
        providerOptions: options.providerOptions,
        abortSignal: abortController.signal,
        // Tools are handled by the MCP server, not passed directly
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
        this.logger.info(requestId, "Claude Code stream with tools completed", { streamId });
      }
    } catch (error) {
      this.logger.error(
        requestId,
        "Claude Code stream with tools error",
        { streamId },
        error as Error
      );
      this.sendStreamError(sender, panelId, streamId, error);
    } finally {
      if (actualConversationId) {
        this.rejectPendingToolExecutions(actualConversationId, panelId, "Conversation ended");
        this.ccConversationManager.endConversation(actualConversationId);
      }

      // Clean up pending tool executions for this stream
      for (const [executionId, pending] of streamPendingTools) {
        clearTimeout(pending.timeoutId);
        this.pendingToolExecutions.delete(executionId);
      }
      streamPendingTools.clear();

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
      case "tool-input-start": {
        // Strip MCP prefix from tool name (mcp__serverName__toolName -> toolName)
        let toolName = part["toolName"] as string;
        const mcpMatch = toolName.match(/^mcp__[^_]+__(.+)$/);
        if (mcpMatch) {
          toolName = mcpMatch[1]!;
        }
        return {
          type: "tool-input-start",
          toolCallId: part["id"] as string, // AI SDK uses "id", not "toolCallId"
          toolName,
        };
      }
      case "tool-input-delta":
        return {
          type: "tool-input-delta",
          toolCallId: part["id"] as string, // AI SDK uses "id", not "toolCallId"
          inputTextDelta: part["delta"] as string, // AI SDK uses "delta", not "inputTextDelta"
        };
      case "tool-input-end":
        return { type: "tool-input-end", toolCallId: part["id"] as string }; // AI SDK uses "id"
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

  /**
   * Stream Claude Code conversation results to a panel.
   * Similar to streamToPanel but uses the conversation's model.
   */
  private async ccStreamToPanel(
    sender: Electron.WebContents,
    requestId: string,
    panelId: string,
    conversationId: string,
    options: AICallOptions,
    streamId: string
  ): Promise<void> {
    this.logger.info(requestId, "Claude Code stream started", {
      panelId,
      conversationId,
      streamId,
    });

    const abortController = new AbortController();
    this.streamManager.startTracking(streamId, abortController, requestId);

    const onDestroyed = (): void => {
      this.logger.info(requestId, "Panel destroyed, cancelling Claude Code stream", { streamId });
      this.streamManager.cleanup(streamId);
    };

    sender.on("destroyed", onDestroyed);

    try {
      const model = this.ccConversationManager.getModel(conversationId);
      if (!model) {
        throw createAIError("internal_error", "Failed to get model for conversation");
      }

      // Convert request to SDK format (tools are handled by the conversation's MCP server)
      let prompt: unknown[];
      try {
        prompt = convertPromptToSDK(options.prompt);
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
        providerOptions: options.providerOptions,
        abortSignal: abortController.signal,
        // Note: tools and toolChoice are handled by the conversation's MCP server
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
        this.logger.info(requestId, "Claude Code stream completed", { streamId });
      }
    } catch (error) {
      this.logger.error(requestId, "Claude Code stream error", { streamId }, error as Error);
      this.sendStreamError(sender, panelId, streamId, error);
    } finally {
      sender.removeListener("destroyed", onDestroyed);
      this.streamManager.cleanup(streamId);
    }
  }
}
