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

import type { AIRoleRecord, AIModelInfo, AIToolDefinition } from "@natstack/ai";
import type {
  StreamTextOptions,
  StreamTextEvent,
} from "../../shared/types.js";
import { createAIError } from "../../shared/errors.js";
import { Logger, generateRequestId } from "../../shared/logging.js";
import { validateToolDefinitions } from "../../shared/validation.js";
import { MAX_STREAM_DURATION_MS } from "../../shared/constants.js";
import {
  getClaudeCodeConversationManager,
  type ClaudeCodeConversationManager,
} from "./claudeCodeConversationManager.js";
import { type ToolExecutionResult } from "./claudeCodeToolProxy.js";

export interface StreamTarget {
  targetId: string;
  isAvailable(): boolean;
  sendChunk(event: StreamTextEvent): void;
  sendEnd(): void;
  executeTool(toolName: string, args: Record<string, unknown>): Promise<ToolExecutionResult>;
  onUnavailable?(listener: () => void): () => void;
}

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
// Utilities
// =============================================================================

function decodeBinary(data: string, context: string): Uint8Array {
  try {
    return new Uint8Array(Buffer.from(data, "base64"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw createAIError("internal_error", `${context}: invalid base64 data (${message})`);
  }
}

/**
 * Safely parse JSON with fallback to raw string on error.
 * @param jsonString - String to parse
 * @param fallback - Value to return on parse error (default: original string)
 * @returns Parsed object or fallback
 */
function safeJsonParse(jsonString: string, fallback?: unknown): unknown {
  try {
    return JSON.parse(jsonString);
  } catch {
    return fallback !== undefined ? fallback : jsonString;
  }
}

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
  private readonly logger = new Logger("AIStreamManager");

  startTracking(streamId: string, abortController: AbortController, requestId: string): void {
    this.activeStreams.set(streamId, abortController);

    // Set timeout to prevent runaway streams
    const timeout = setTimeout(() => {
      this.logger.warn(requestId, "Stream exceeded maximum duration", { streamId });
      this.cancelStream(streamId);
    }, MAX_STREAM_DURATION_MS);

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

  constructor() {
    this.ccConversationManager = getClaudeCodeConversationManager();
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
    const skippedProviders: string[] = [];
    for (const providerId of getSupportedProviders()) {
      const providerRegistration = createProviderFromConfig(providerId);
      if (providerRegistration) {
        this.registerProvider(providerRegistration);
        registeredCount++;
      } else {
        skippedProviders.push(providerId);
      }
    }

    // Log skipped providers in one line (cleaner than per-provider logging)
    if (skippedProviders.length > 0) {
      this.logger.debug(requestId, `Providers skipped (no API key): ${skippedProviders.join(", ")}`);
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

  /**
   * Start a stream to an arbitrary StreamTarget (for agents, workers, etc).
   * This is the public entry point for non-panel streaming.
   */
  startTargetStream(
    target: StreamTarget,
    options: StreamTextOptions,
    streamId: string,
    requestId: string = generateRequestId()
  ): void {
    this.logger.info(requestId, "[Main AI] stream-text-start for target", {
      targetId: target.targetId,
      model: options.model,
      messageCount: options.messages?.length,
      toolCount: options.tools?.length,
      streamId,
    });

    const resolvedModelId = this.resolveModelId(options.model);

    void this.streamTextToTarget(target, requestId, resolvedModelId, options, streamId);
  }

  // ===========================================================================
  // Unified streamText Implementation
  // ===========================================================================

  private async streamTextToTarget(
    target: StreamTarget,
    requestId: string,
    modelId: string,
    options: StreamTextOptions,
    streamId: string
  ): Promise<void> {
    const isClaudeCode = modelId.startsWith("claude-code:");
    const hasTools = options.tools && options.tools.length > 0;
    const maxSteps = options.maxSteps ?? 10;

    this.logger.info(requestId, "streamText started", {
      targetId: target.targetId,
      modelId,
      streamId,
      hasTools,
      maxSteps,
      isClaudeCode,
    });

    const abortController = new AbortController();
    this.streamManager.startTracking(streamId, abortController, requestId);

    const unsubscribe = target.onUnavailable?.(() => {
      this.logger.info(requestId, "Target unavailable, cancelling streamText", { streamId });
      this.streamManager.cleanup(streamId);
    });

    try {
      if (isClaudeCode && hasTools) {
        await this.streamTextClaudeCodeToTarget(
          target,
          requestId,
          modelId,
          options,
          streamId,
          abortController
        );
      } else if (hasTools) {
        await this.streamTextWithAgentLoopToTarget(
          target,
          requestId,
          modelId,
          options,
          maxSteps,
          abortController
        );
      } else {
        await this.streamTextSimpleToTarget(target, modelId, options, abortController);
      }

      target.sendEnd();
      this.logger.info(requestId, "streamText completed", { streamId });
    } catch (error) {
      this.logger.error(requestId, "streamText error", { streamId }, error as Error);
      target.sendChunk({
        type: "error",
        error: error instanceof Error ? error.message : String(error),
      });
      target.sendEnd();
    } finally {
      unsubscribe?.();
      this.streamManager.cleanup(streamId);
    }
  }

  /**
   * Simple streaming without tools - single model call.
   */
  private async streamTextSimpleToTarget(
    target: StreamTarget,
    modelId: string,
    options: StreamTextOptions,
    abortController: AbortController
  ): Promise<void> {
    const model = this.registry.getModel(modelId);

    // Convert messages to SDK format
    const prompt = this.convertStreamTextMessagesToSDK(options.messages);

    const sdkOptions = {
      prompt,
      maxOutputTokens: options.maxOutputTokens,
      temperature: options.temperature,
      abortSignal: abortController.signal,
      ...(options.thinking && { thinking: options.thinking }),
    };

    const { stream } = (await model.doStream(sdkOptions)) as { stream: ReadableStream<unknown> };
    const reader = stream.getReader();

    let totalUsage = { promptTokens: 0, completionTokens: 0 };

    try {
      while (true) {
        if (!target.isAvailable() || abortController.signal.aborted) {
          abortController.abort();
          break;
        }

        const { done, value } = await reader.read();
        if (done) break;

        const part = value as Record<string, unknown>;
        const type = part["type"] as string;

        // Convert to unified event format
        switch (type) {
          case "text-delta":
            target.sendChunk({ type: "text-delta", text: part["delta"] as string });
            break;
          case "reasoning-start":
            target.sendChunk({ type: "reasoning-start" });
            break;
          case "reasoning-delta":
            target.sendChunk({ type: "reasoning-delta", text: part["delta"] as string });
            break;
          case "reasoning-end":
            target.sendChunk({ type: "reasoning-end" });
            break;
          case "finish":
            totalUsage = {
              promptTokens: (part["usage"] as { promptTokens?: number })?.promptTokens ?? 0,
              completionTokens: (part["usage"] as { completionTokens?: number })?.completionTokens ?? 0,
            };
            break;
          default:
            // Ignore other event types (e.g., tool events handled elsewhere)
            break;
        }
      }
    } finally {
      reader.releaseLock();
    }

    target.sendChunk({ type: "step-finish", stepNumber: 1, finishReason: "stop" });
    target.sendChunk({ type: "finish", totalSteps: 1, usage: totalUsage });
  }

  /**
   * Streaming with agent loop for regular models with tools.
   */
  private async streamTextWithAgentLoopToTarget(
    target: StreamTarget,
    requestId: string,
    modelId: string,
    options: StreamTextOptions,
    maxSteps: number,
    abortController: AbortController
  ): Promise<void> {
    const model = this.registry.getModel(modelId);

    // Convert tools to SDK format (v3 API uses inputSchema, not parameters)
    const sdkTools = options.tools?.map((tool) => ({
      type: "function" as const,
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters,
    }));

    // Build conversation messages (will be extended with tool results)
    const conversationMessages = [...options.messages];
    const totalUsage = { promptTokens: 0, completionTokens: 0 };

    for (let step = 1; step <= maxSteps; step++) {
      if (!target.isAvailable() || abortController.signal.aborted) break;

      // Convert current conversation to SDK format
      const prompt = this.convertStreamTextMessagesToSDK(conversationMessages);

      const sdkOptions = {
        prompt,
        tools: sdkTools,
        toolChoice: { type: "auto" },
        maxOutputTokens: options.maxOutputTokens,
        temperature: options.temperature,
        abortSignal: abortController.signal,
        ...(options.thinking && { thinking: options.thinking }),
      };

      const { stream } = (await model.doStream(sdkOptions)) as { stream: ReadableStream<unknown> };
      const reader = stream.getReader();

      // Collect tool calls from this step
      const toolCalls: Array<{ toolCallId: string; toolName: string; args: unknown }> = [];
      const toolCallArgsBuffers = new Map<string, string>();
      let textContent = "";
      let finishReason: "stop" | "tool-calls" | "length" | "error" = "stop";

      try {
        while (true) {
          if (!target.isAvailable() || abortController.signal.aborted) {
            abortController.abort();
            break;
          }

          const { done, value } = await reader.read();
          if (done) break;

          const part = value as Record<string, unknown>;
          const type = part["type"] as string;

          switch (type) {
            case "text-delta":
              textContent += part["delta"] as string;
              target.sendChunk({ type: "text-delta", text: part["delta"] as string });
              break;

            case "reasoning-start":
              target.sendChunk({ type: "reasoning-start" });
              break;

            case "reasoning-delta":
              target.sendChunk({ type: "reasoning-delta", text: part["delta"] as string });
              break;

            case "reasoning-end":
              target.sendChunk({ type: "reasoning-end" });
              break;

            case "tool-input-start": {
              const toolCallId = part["id"] as string;
              const toolName = part["toolName"] as string;
              toolCallArgsBuffers.set(toolCallId, "");
              toolCalls.push({ toolCallId, toolName, args: {} });
              break;
            }

            case "tool-input-delta": {
              const toolCallId = part["id"] as string;
              const delta = part["delta"] as string;
              const current = toolCallArgsBuffers.get(toolCallId) ?? "";
              toolCallArgsBuffers.set(toolCallId, current + delta);
              break;
            }

            case "tool-input-end": {
              const toolCallId = part["id"] as string;
              const argsStr = toolCallArgsBuffers.get(toolCallId) ?? "{}";
              const tc = toolCalls.find((t) => t.toolCallId === toolCallId);
              if (tc) {
                tc.args = safeJsonParse(argsStr, { raw: argsStr });
                // Send tool-call event
                target.sendChunk({
                  type: "tool-call",
                  toolCallId: tc.toolCallId,
                  toolName: tc.toolName,
                  args: tc.args,
                });
              }
              break;
            }

            case "finish": {
              const reason = part["finishReason"] as string;
              if (reason === "tool-calls") finishReason = "tool-calls";
              else if (reason === "length") finishReason = "length";
              else if (reason === "error") finishReason = "error";
              else finishReason = "stop";

              const usage = part["usage"] as { promptTokens?: number; completionTokens?: number } | undefined;
              if (usage) {
                totalUsage.promptTokens += usage.promptTokens ?? 0;
                totalUsage.completionTokens += usage.completionTokens ?? 0;
              }
              break;
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      // Send step-finish event
      target.sendChunk({ type: "step-finish", stepNumber: step, finishReason });

      // If no tool calls or finish reason is stop, we're done
      if (toolCalls.length === 0 || finishReason === "stop") {
        target.sendChunk({ type: "finish", totalSteps: step, usage: totalUsage });
        return;
      }

      // Execute tools and collect results
      const toolResults: Array<{ toolCallId: string; toolName: string; result: unknown; isError?: boolean }> = [];

      for (const tc of toolCalls) {
        try {
          const result = await target.executeTool(tc.toolName, tc.args as Record<string, unknown>);
          const resultText = result.content[0]?.text;
          const parsedResult = resultText ? safeJsonParse(resultText) : resultText;

          // If the tool result includes structured data (e.g., code execution with components),
          // pass through the full result so the panel can access the data field.
          // Otherwise, just use the parsed text result.
          const eventResult = result.data !== undefined
            ? { content: result.content, isError: result.isError, data: result.data }
            : parsedResult;

          toolResults.push({
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            result: parsedResult, // For LLM conversation, just use parsed text
            isError: result.isError,
          });
          target.sendChunk({
            type: "tool-result",
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            result: eventResult, // For panel UI, include full result with data
            isError: result.isError,
          });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          toolResults.push({
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            result: { error: errorMessage },
            isError: true,
          });
          target.sendChunk({
            type: "tool-result",
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            result: { error: errorMessage },
            isError: true,
          });
        }
      }

      // Add assistant message with tool calls to conversation
      conversationMessages.push({
        role: "assistant",
        content: [
          ...(textContent ? [{ type: "text" as const, text: textContent }] : []),
          ...toolCalls.map((tc) => ({
            type: "tool-call" as const,
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            args: tc.args,
          })),
        ],
      });

      // Add tool results to conversation
      conversationMessages.push({
        role: "tool",
        content: toolResults.map((tr) => ({
          type: "tool-result" as const,
          toolCallId: tr.toolCallId,
          toolName: tr.toolName,
          result: tr.result,
          isError: tr.isError,
        })),
      });
    }

    // Hit max steps
    target.sendChunk({ type: "finish", totalSteps: maxSteps, usage: totalUsage });
  }

  /**
   * Streaming with Claude Code model and tools via MCP proxy.
   */
  private async streamTextClaudeCodeToTarget(
    target: StreamTarget,
    requestId: string,
    modelId: string,
    options: StreamTextOptions,
    streamId: string,
    abortController: AbortController
  ): Promise<void> {
    // Extract the model name (e.g., "claude-code:sonnet" -> "sonnet")
    const ccModelId = modelId.startsWith("claude-code:")
      ? modelId.substring("claude-code:".length)
      : modelId;

    // Validate tools
    if (!options.tools || options.tools.length === 0) {
      throw createAIError("api_error", "Tools are required for Claude Code streamText");
    }

    // Convert to AIToolDefinition format
    const aiTools: AIToolDefinition[] = options.tools.map((t) => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));

    const validatedTools = validateToolDefinitions(aiTools);
    if (!validatedTools || validatedTools.length === 0) {
      throw createAIError("api_error", "Tools validation failed");
    }

    // Use an object reference so the callback can access the correct conversation ID
    const conversationRef = { id: "" };

    // Create tool execution callback that wraps target.executeTool
    const mcpExecuteCallback = async (
      toolName: string,
      args: Record<string, unknown>
    ): Promise<ToolExecutionResult> => {
      // Strip MCP prefix from tool name
      let simpleToolName = toolName;
      const mcpMatch = toolName.match(/^mcp__[^_]+__(.+)$/);
      if (mcpMatch) {
        simpleToolName = mcpMatch[1]!;
      }

      // Send tool-call event
      const toolCallId = crypto.randomUUID();
      target.sendChunk({
        type: "tool-call",
        toolCallId,
        toolName: simpleToolName,
        args,
      });

      if (!target.isAvailable() || abortController.signal.aborted) {
        abortController.abort();
        throw new Error("Target is not available");
      }

      // Execute via panel/worker
      const result = await target.executeTool(simpleToolName, args);

      // Send tool-result event
      const resultText = result.content.map((c) => c.text).join("\n");
      const parsedResult = resultText ? safeJsonParse(resultText) : resultText;

      // If the tool result includes structured data, pass it through
      const eventResult = result.data !== undefined
        ? { content: result.content, isError: result.isError, data: result.data }
        : parsedResult;

      target.sendChunk({
        type: "tool-result",
        toolCallId,
        toolName: simpleToolName,
        result: eventResult,
        isError: result.isError,
      });

      return result;
    };

    // Create the conversation
    const conversationHandle = this.ccConversationManager.createConversation({
      panelId: target.targetId,
      modelId: ccModelId,
      tools: validatedTools,
      executeCallback: mcpExecuteCallback,
    });

    conversationRef.id = conversationHandle.conversationId;

    this.logger.info(requestId, "Created streamText Claude Code conversation", {
      conversationId: conversationRef.id,
      streamId,
      targetId: target.targetId,
      toolCount: validatedTools.length,
    });

    const totalUsage = { promptTokens: 0, completionTokens: 0 };

    try {
      const model = conversationHandle.getModel();

      // Convert messages
      const prompt = this.convertStreamTextMessagesToSDK(options.messages);

      const sdkOptions = {
        prompt,
        maxOutputTokens: options.maxOutputTokens,
        temperature: options.temperature,
        abortSignal: abortController.signal,
        // Tools are handled by MCP, not passed directly
      };

      const { stream } = (await model.doStream(sdkOptions)) as { stream: ReadableStream<unknown> };
      const reader = stream.getReader();

      try {
        while (true) {
          if (!target.isAvailable() || abortController.signal.aborted) {
            abortController.abort();
            break;
          }

          const { done, value } = await reader.read();
          if (done) break;

          const part = value as Record<string, unknown>;
          const type = part["type"] as string;

          // Convert to unified event format
          if (type === "text-delta") {
            target.sendChunk({ type: "text-delta", text: part["delta"] as string });
          } else if (type === "finish") {
            const usage = part["usage"] as { promptTokens?: number; completionTokens?: number } | undefined;
            if (usage) {
              totalUsage.promptTokens += usage.promptTokens ?? 0;
              totalUsage.completionTokens += usage.completionTokens ?? 0;
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      target.sendChunk({ type: "step-finish", stepNumber: 1, finishReason: "stop" });
      target.sendChunk({ type: "finish", totalSteps: 1, usage: totalUsage });
    } finally {
      // Clean up conversation
      this.ccConversationManager.endConversation(conversationRef.id);
    }
  }

  /**
   * Convert StreamTextOptions messages to SDK format with proper type safety.
   */
  private convertStreamTextMessagesToSDK(messages: StreamTextOptions["messages"]): unknown[] {
    return messages.map((msg) => {
      switch (msg.role) {
        case "system":
          return { role: "system", content: msg.content };

        case "user": {
          if (typeof msg.content === "string") {
            return { role: "user", content: [{ type: "text", text: msg.content }] };
          }
          // Array of content parts
          return {
            role: "user",
            content: msg.content.map((part) => {
              if (part.type === "text") {
                return { type: "text", text: part.text };
              }
              // File part
              if (part.type === "file") {
                return {
                  type: "file",
                  mimeType: part.mimeType,
                  data: typeof part.data === "string" ? decodeBinary(part.data, "user content") : part.data,
                };
              }
              throw createAIError("internal_error", `Unknown user content part type: ${(part as { type?: string }).type}`);
            }),
          };
        }

        case "assistant": {
          if (typeof msg.content === "string") {
            return { role: "assistant", content: [{ type: "text", text: msg.content }] };
          }
          return {
            role: "assistant",
            content: msg.content.map((part) => {
              if (part.type === "text") {
                return { type: "text", text: part.text };
              }
              if (part.type === "tool-call") {
                return {
                  type: "tool-call",
                  toolCallId: part.toolCallId,
                  toolName: part.toolName,
                  input: part.args, // SDK uses "input" not "args"
                };
              }
              throw createAIError("internal_error", `Unknown assistant content part type: ${(part as { type?: string }).type}`);
            }),
          };
        }

        case "tool":
          return {
            role: "tool",
            content: msg.content.map((part) => ({
              type: "tool-result",
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              output: {
                type: part.isError ? "error-json" : "json",
                value: part.result,
              },
            })),
          };

        default:
          // TypeScript should ensure this is never reached
          throw createAIError("internal_error", `Unknown message role: ${(msg as { role?: string }).role}`);
      }
    });
  }

  // ===========================================================================
  // Stream Management
  // ===========================================================================

  /**
   * Cancel a stream by ID.
   */
  public cancelStream(streamId: string): void {
    this.streamManager.cancelStream(streamId);
  }
}
