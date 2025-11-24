import { handle } from "../ipc/handlers.js";
import type { PanelManager } from "../panelManager.js";
import type {
  AICallOptions,
  AIGenerateResult,
  AIModelInfo,
  AIStreamPart,
  AIMessage,
  AIToolDefinition,
  AIResponseContent,
} from "../../shared/ipc/index.js";

// =============================================================================
// AI SDK Types (imported dynamically to avoid bundling issues)
// =============================================================================

// We'll use dynamic imports for the AI SDK since it may not be installed
// For now, define the minimal types we need
interface LanguageModelV2 {
  specificationVersion: "v2";
  provider: string;
  modelId: string;
  doGenerate(options: unknown): PromiseLike<unknown>;
  doStream(options: unknown): PromiseLike<{ stream: ReadableStream<unknown> }>;
}

type AISDKProvider = (modelId: string) => LanguageModelV2;

// =============================================================================
// Type Converters
// =============================================================================

/**
 * Convert our serializable AIMessage format to AI SDK's LanguageModelV2Prompt format.
 */
function convertPromptToSDK(messages: AIMessage[]): unknown[] {
  return messages.map((msg) => {
    switch (msg.role) {
      case "system":
        return { role: "system", content: msg.content };

      case "user":
        return {
          role: "user",
          content: msg.content.map((part) => {
            if (part.type === "text") {
              return { type: "text", text: part.text };
            } else {
              // File part - decode base64 to Uint8Array
              const data = Buffer.from(part.data, "base64");
              return {
                type: "file",
                mimeType: part.mimeType,
                data: new Uint8Array(data),
              };
            }
          }),
        };

      case "assistant":
        return {
          role: "assistant",
          content: msg.content.map((part) => {
            switch (part.type) {
              case "text":
                return { type: "text", text: part.text };
              case "file": {
                const data = Buffer.from(part.data, "base64");
                return {
                  type: "file",
                  mimeType: part.mimeType,
                  data: new Uint8Array(data),
                };
              }
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
          }),
        };

      case "tool":
        return {
          role: "tool",
          content: msg.content.map((part) => ({
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
 */
function convertToolsToSDK(tools: AIToolDefinition[] | undefined): unknown[] | undefined {
  if (!tools) return undefined;
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

/**
 * Convert AI SDK response content to our serializable format.
 */
function convertResponseContent(content: unknown[]): AIResponseContent[] {
  return content.map((item: unknown) => {
    const part = item as { type: string; text?: string; toolCallId?: string; toolName?: string; args?: unknown };
    switch (part.type) {
      case "text":
        return { type: "text" as const, text: part.text ?? "" };
      case "reasoning":
        return { type: "reasoning" as const, text: part.text ?? "" };
      case "tool-call":
        return {
          type: "tool-call" as const,
          toolCallId: part.toolCallId ?? "",
          toolName: part.toolName ?? "",
          args: part.args,
        };
      default:
        return { type: "text" as const, text: String(part) };
    }
  });
}

// =============================================================================
// AI Handler
// =============================================================================

export interface AIProviderConfig {
  /** Provider ID (e.g., "anthropic", "openai") */
  id: string;
  /** Human-readable name */
  name: string;
  /** Function to create a language model */
  createModel: AISDKProvider;
  /** Available models for this provider */
  models: Array<{
    id: string;
    displayName: string;
    description?: string;
  }>;
}

export class AIHandler {
  private providers = new Map<string, AIProviderConfig>();
  private activeStreams = new Map<string, AbortController>();

  constructor(private panelManager: PanelManager) {
    this.registerHandlers();
  }

  /**
   * Register an AI provider with available models.
   */
  registerProvider(config: AIProviderConfig): void {
    this.providers.set(config.id, config);
    console.log(`[AIHandler] Registered provider: ${config.id} with ${config.models.length} models`);
  }

  /**
   * Get all available models across all providers.
   */
  getAvailableModels(): AIModelInfo[] {
    const models: AIModelInfo[] = [];
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

  private registerHandlers(): void {
    handle("ai:generate", async (event, panelId: string, modelId: string, options: AICallOptions) => {
      this.assertAuthorized(event, panelId);
      return this.generate(modelId, options);
    });

    handle("ai:stream-start", async (event, panelId: string, modelId: string, options: AICallOptions, streamId: string) => {
      this.assertAuthorized(event, panelId);
      // Start streaming in background, send chunks via events
      void this.streamToPanel(event.sender, panelId, modelId, options, streamId);
    });

    handle("ai:stream-cancel", async (event, panelId: string, streamId: string) => {
      this.assertAuthorized(event, panelId);
      this.cancelStream(streamId);
    });

    handle("ai:list-models", async (event, panelId: string) => {
      this.assertAuthorized(event, panelId);
      return this.getAvailableModels();
    });
  }

  private assertAuthorized(event: Electron.IpcMainInvokeEvent, panelId: string): void {
    const senderPanelId = this.panelManager.getPanelIdForWebContents(event.sender);
    if (senderPanelId !== panelId) {
      throw new Error(`Unauthorized: Sender ${senderPanelId} cannot act as ${panelId}`);
    }
  }

  private getModel(modelId: string): LanguageModelV2 {
    // Model ID format: "providerId:modelName" or just "modelName" (searches all providers)
    let providerId: string | undefined;
    let modelName: string;

    if (modelId.includes(":")) {
      const parts = modelId.split(":", 2);
      providerId = parts[0];
      modelName = parts[1] ?? modelId;
    } else {
      modelName = modelId;
    }

    // If provider specified, use it directly
    if (providerId) {
      const provider = this.providers.get(providerId);
      if (!provider) {
        throw new Error(`AI provider not found: ${providerId}`);
      }
      return provider.createModel(modelName);
    }

    // Otherwise, search all providers for a model with this ID
    for (const [, config] of this.providers) {
      const found = config.models.find((m) => m.id === modelName || m.id === modelId);
      if (found) {
        return config.createModel(found.id);
      }
    }

    throw new Error(`AI model not found: ${modelId}`);
  }

  private async generate(modelId: string, options: AICallOptions): Promise<AIGenerateResult> {
    const model = this.getModel(modelId);

    const sdkOptions = {
      prompt: convertPromptToSDK(options.prompt),
      maxOutputTokens: options.maxOutputTokens,
      temperature: options.temperature,
      topP: options.topP,
      topK: options.topK,
      presencePenalty: options.presencePenalty,
      frequencyPenalty: options.frequencyPenalty,
      stopSequences: options.stopSequences,
      seed: options.seed,
      responseFormat: options.responseFormat,
      tools: convertToolsToSDK(options.tools),
      toolChoice: options.toolChoice,
      providerOptions: options.providerOptions,
    };

    let result;
    try {
      result = await model.doGenerate(sdkOptions) as {
        content: unknown[];
        finishReason: string;
        usage: { promptTokens: number; completionTokens: number };
        warnings?: Array<{ type: string; message: string; details?: unknown }>;
        response?: { id?: string; modelId?: string; timestamp?: Date };
      };
    } catch (error) {
      console.error("[AIHandler] generate error", error);
      throw error;
    }

    return {
      content: convertResponseContent(result.content),
      finishReason: result.finishReason as AIGenerateResult["finishReason"],
      usage: {
        promptTokens: result.usage?.promptTokens ?? 0,
        completionTokens: result.usage?.completionTokens ?? 0,
      },
      warnings: (result.warnings ?? []).map((w) => ({
        type: w.type,
        message: w.message,
        details: w.details,
      })),
      response: result.response
        ? {
            id: result.response.id,
            modelId: result.response.modelId,
            timestamp: result.response.timestamp?.toISOString(),
          }
        : undefined,
    };
  }

  private async streamToPanel(
    sender: Electron.WebContents,
    panelId: string,
    modelId: string,
    options: AICallOptions,
    streamId: string
  ): Promise<void> {
    const abortController = new AbortController();
    this.activeStreams.set(streamId, abortController);

    const onDestroyed = (): void => {
      abortController.abort();
    };
    sender.on("destroyed", onDestroyed);

    try {
      const model = this.getModel(modelId);

      const sdkOptions = {
        prompt: convertPromptToSDK(options.prompt),
        maxOutputTokens: options.maxOutputTokens,
        temperature: options.temperature,
        topP: options.topP,
        topK: options.topK,
        presencePenalty: options.presencePenalty,
        frequencyPenalty: options.frequencyPenalty,
        stopSequences: options.stopSequences,
        seed: options.seed,
        responseFormat: options.responseFormat,
        tools: convertToolsToSDK(options.tools),
        toolChoice: options.toolChoice,
        providerOptions: options.providerOptions,
        abortSignal: abortController.signal,
      };

      const { stream } = await model.doStream(sdkOptions);
      const reader = stream.getReader();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (sender.isDestroyed()) {
            abortController.abort();
            break;
          }
          if (done) break;

          // Convert and send chunk to panel
          const chunk = this.convertStreamPart(value as Record<string, unknown>);
          if (chunk && !sender.isDestroyed()) {
            sender.send("ai:stream-chunk", { panelId, streamId, chunk });
          }
        }
      } finally {
        reader.releaseLock();
      }

      // Send stream end
      if (!sender.isDestroyed()) {
        sender.send("ai:stream-end", { panelId, streamId });
      }
    } catch (error) {
      console.error("[AIHandler] stream error", error);
      // Send error chunk
      if (!sender.isDestroyed()) {
        const errorChunk: AIStreamPart = {
          type: "error",
          error: error instanceof Error ? `${error.message}` : String(error),
        };
        // Attempt to surface extra context for debugging
        if (error && typeof error === "object") {
          const errObj = error as Record<string, unknown>;
          if (errObj["stack"]) {
            errorChunk.error += ` | stack: ${String(errObj["stack"])}`;
          }
          if (errObj["data"]) {
            try {
              errorChunk.error += ` | data: ${JSON.stringify(errObj["data"])}`;
            } catch {
              /* ignore */
            }
          }
        }
        sender.send("ai:stream-chunk", { panelId, streamId, chunk: errorChunk });
        sender.send("ai:stream-end", { panelId, streamId });
      }
    } finally {
      sender.removeListener("destroyed", onDestroyed);
      this.activeStreams.delete(streamId);
    }
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
        return { type: "reasoning-delta", id: part["id"] as string, delta: part["delta"] as string };
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
            ? (part["timestamp"] as Date).toISOString?.() ?? String(part["timestamp"])
            : undefined,
        };
      case "finish":
        return {
          type: "finish",
          finishReason: part["finishReason"] as AIStreamPart & { type: "finish" } extends { finishReason: infer R } ? R : never,
          usage: {
            promptTokens: (part["usage"] as { promptTokens?: number })?.promptTokens ?? 0,
            completionTokens: (part["usage"] as { completionTokens?: number })?.completionTokens ?? 0,
          },
        };
      case "error": {
        const err = part["error"];
        return {
          type: "error",
          error: err instanceof Error ? err.message : String(err),
        };
      }
      default:
        // Unknown chunk type, skip
        return null;
    }
  }

  /**
   * Cancel an active stream.
   */
  cancelStream(streamId: string): void {
    const controller = this.activeStreams.get(streamId);
    if (controller) {
      controller.abort();
      this.activeStreams.delete(streamId);
    }
  }
}
