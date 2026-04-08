/**
 * AI Handler — Pi-native AI runtime entrypoint for non-worker callers.
 *
 * The Vercel AI SDK provider stack and the Claude Agent CLI provider were
 * deleted in Phase 5. All AI calls now route through `@mariozechner/pi-coding-agent`
 * (`createAgentSession` + `SessionManager.inMemory()`), which in turn uses
 * `@mariozechner/pi-ai`'s built-in providers.
 *
 * This handler is used by panels and other in-process callers that need a
 * one-shot streaming text completion. The chat worker has its own dedicated
 * Pi runner; this is the lighter-weight, stateless path.
 *
 * Public surface (consumed by aiService.ts and renderer code):
 *   - new AIHandler(workspacePath?)
 *   - initialize() — load central config, set runtime API keys
 *   - resolveModelId(roleOrId) — resolve role names to provider:model
 *   - getAvailableRoles() — list configured model roles
 *   - startTargetStream(target, options, streamId, contextFolderPath)
 *   - cancelStream(streamId)
 */

import type { AIRoleRecord, AIModelInfo } from "@natstack/types";
import type {
  StreamTextOptions,
  StreamTextEvent,
  ToolExecutionResult,
} from "../types.js";
import { createAIError } from "../errors.js";
import { createDevLogger } from "@natstack/dev-log";
import { MAX_STREAM_DURATION_MS } from "../constants.js";
import {
  AuthStorage,
  SessionManager,
  createAgentSession,
  readOnlyTools,
  type AgentSession,
  type AgentSessionEvent,
} from "@mariozechner/pi-coding-agent";
import { resolveModelToPi } from "./resolve-model.js";
import {
  getProviderEnvVars,
  getSupportedProviders,
  hasProviderApiKey,
} from "./providerFactory.js";
import type { SupportedProvider } from "../workspace/types.js";

export interface StreamTarget {
  targetId: string;
  isAvailable(): boolean;
  sendChunk(event: StreamTextEvent): void;
  sendEnd(): void;
  executeTool(toolName: string, args: Record<string, unknown>): Promise<ToolExecutionResult>;
  onUnavailable?(listener: () => void): () => void;
}

// =============================================================================
// Utilities
// =============================================================================

function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

// =============================================================================
// Stream Management
// =============================================================================

/**
 * Manages the lifecycle of active AI streams.
 */
class AIStreamManager {
  private activeStreams = new Map<string, AbortController>();
  private streamTimeouts = new Map<string, NodeJS.Timeout>();
  private readonly logger = createDevLogger("AIStreamManager");

  startTracking(streamId: string, abortController: AbortController, requestId: string): void {
    this.activeStreams.set(streamId, abortController);

    const timeout = setTimeout(() => {
      this.logger.warn(`[${requestId}] Stream exceeded maximum duration ${JSON.stringify({ streamId })}`);
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
// AI Handler
// =============================================================================

export class AIHandler {
  private streamManager = new AIStreamManager();
  private logger = createDevLogger("AIHandler");
  private modelRoleResolver: import("./modelRoles.js").ModelRoleResolver | null = null;
  private workspacePath: string | undefined;
  private authStorage: AuthStorage;

  constructor(workspacePath?: string) {
    this.workspacePath = workspacePath;
    this.authStorage = AuthStorage.inMemory();
  }

  /**
   * Initialize model roles and runtime API keys.
   * - Model roles come from central config (~/.config/natstack/config.yml)
   * - API keys come from process.env (populated by .secrets.yml or .env loaders)
   */
  async initialize(): Promise<void> {
    const requestId = generateRequestId();
    this.logger.info(`[${requestId}] Initializing AI handler`);

    const { ModelRoleResolver } = await import("./modelRoles.js");
    const { loadCentralConfig } = await import("../workspace/loader.js");

    // Reset auth storage and load model roles from central config
    this.authStorage = AuthStorage.inMemory();
    const centralConfig = loadCentralConfig();
    this.modelRoleResolver = new ModelRoleResolver(centralConfig.models);

    // Push environment-derived API keys into Pi's runtime auth storage so the
    // resolved Pi model can find a key during prompt(). Pi consults runtime
    // overrides ahead of file-based auth, so this gives NatStack-supplied keys
    // first priority.
    const envVars = getProviderEnvVars();
    let registeredCount = 0;
    const skippedProviders: string[] = [];
    for (const providerId of getSupportedProviders()) {
      const envVarName = envVars[providerId];
      const value = envVarName ? process.env[envVarName] : undefined;
      if (value) {
        this.authStorage.setRuntimeApiKey(providerId, value);
        registeredCount++;
      } else {
        skippedProviders.push(providerId);
      }
    }

    if (skippedProviders.length > 0) {
      this.logger.verbose(`[${requestId}] Providers skipped (no API key): ${skippedProviders.join(", ")}`);
    }

    this.logger.info(
      `[${requestId}] AI handler initialization complete ${JSON.stringify({ registeredCount })}`,
    );
  }

  /**
   * Resolve a model role or ID to the actual model ID.
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
   * A role is "available" only if its provider has an API key in the
   * environment. Roles whose providers are missing keys are dropped.
   */
  getAvailableRoles(): AIRoleRecord {
    if (!this.modelRoleResolver) {
      return {} as AIRoleRecord;
    }

    const getModelInfo = (role: "smart" | "coding" | "fast" | "cheap"): AIModelInfo | null => {
      const spec = this.modelRoleResolver?.resolveSpec(role);
      if (!spec) return null;

      // Drop roles whose providers don't have an API key.
      const provider = spec.provider as SupportedProvider;
      if (!hasProviderApiKey(provider)) return null;

      return {
        modelId: spec.modelId,
        provider: spec.provider,
        displayName: `${spec.provider} ${spec.model}`,
      };
    };

    const smart = getModelInfo("smart");
    const coding = getModelInfo("coding");
    const fast = getModelInfo("fast");
    const cheap = getModelInfo("cheap");

    // Apply defaulting rules
    const smartFinal = smart || coding || fast || cheap;
    const codingFinal = coding || smart || fast || cheap;
    const fastFinal = fast || cheap || smart || coding;
    const cheapFinal = cheap || fast || smart || coding;

    if (!smartFinal || !codingFinal || !fastFinal || !cheapFinal) {
      const fallback = smartFinal || codingFinal || fastFinal || cheapFinal;
      if (fallback) {
        console.warn(
          "[AI] Using fallback model for unconfigured roles. Consider configuring all standard roles in ~/.config/natstack/config.yml",
        );
        console.warn(`[AI] Fallback model: ${fallback.displayName} (${fallback.modelId})`);
        return {
          smart: fallback,
          coding: fallback,
          fast: fallback,
          cheap: fallback,
        };
      }
      // Return empty object — no providers have keys yet.
      return {} as AIRoleRecord;
    }

    return {
      smart: smartFinal,
      coding: codingFinal,
      fast: fastFinal,
      cheap: cheapFinal,
    };
  }

  /**
   * Start a stream to an arbitrary StreamTarget.
   * The public entry point for non-panel streaming.
   */
  startTargetStream(
    target: StreamTarget,
    options: StreamTextOptions,
    streamId: string,
    contextFolderPath: string,
    requestId: string = generateRequestId(),
  ): void {
    this.logger.info(
      `[${requestId}] [Main AI] stream-text-start for target ${JSON.stringify({
        targetId: target.targetId,
        model: options.model,
        messageCount: options.messages?.length,
        toolCount: options.tools?.length,
        streamId,
      })}`,
    );

    const resolvedModelId = this.resolveModelId(options.model);
    void this.streamTextToTarget(
      target,
      requestId,
      resolvedModelId,
      options,
      streamId,
      contextFolderPath,
    );
  }

  // ===========================================================================
  // Pi-based streamText Implementation
  // ===========================================================================

  private async streamTextToTarget(
    target: StreamTarget,
    requestId: string,
    modelId: string,
    options: StreamTextOptions,
    streamId: string,
    contextFolderPath: string,
  ): Promise<void> {
    this.logger.info(
      `[${requestId}] streamText started ${JSON.stringify({
        targetId: target.targetId,
        modelId,
        streamId,
        toolCount: options.tools?.length ?? 0,
      })}`,
    );

    const abortController = new AbortController();
    this.streamManager.startTracking(streamId, abortController, requestId);

    const unsubscribe = target.onUnavailable?.(() => {
      this.logger.info(
        `[${requestId}] Target unavailable, cancelling streamText ${JSON.stringify({ streamId })}`,
      );
      this.streamManager.cleanup(streamId);
    });

    let session: AgentSession | undefined;

    try {
      const resolved = resolveModelToPi(modelId, this.authStorage);

      // Build a one-shot in-memory session. We use Pi's read-only tools by
      // default; panel callers that need tool execution route through their
      // own Pi runner instead.
      const created = await createAgentSession({
        cwd: contextFolderPath,
        authStorage: this.authStorage,
        sessionManager: SessionManager.inMemory(),
        model: resolved.model,
        tools: readOnlyTools,
      });
      session = created.session;

      // Forward Pi events to the StreamTarget.
      let textBufferIndex = -1;
      const usage = { promptTokens: 0, completionTokens: 0 };
      let finished = false;

      const finishOnce = (reason: "stop" | "length" | "error" | "tool-calls") => {
        if (finished) return;
        finished = true;
        target.sendChunk({ type: "step-finish", stepNumber: 1, finishReason: reason });
        target.sendChunk({ type: "finish", totalSteps: 1, usage });
      };

      const unsubscribeSession = session.subscribe((event: AgentSessionEvent) => {
        if (abortController.signal.aborted || !target.isAvailable()) return;

        switch (event.type) {
          case "message_update": {
            const inner = event.assistantMessageEvent;
            if (inner.type === "text_delta") {
              if (textBufferIndex !== inner.contentIndex) {
                textBufferIndex = inner.contentIndex;
              }
              target.sendChunk({ type: "text-delta", text: inner.delta });
            } else if (inner.type === "thinking_delta") {
              target.sendChunk({ type: "reasoning-delta", text: inner.delta });
            } else if (inner.type === "thinking_start") {
              target.sendChunk({ type: "reasoning-start" });
            } else if (inner.type === "thinking_end") {
              target.sendChunk({ type: "reasoning-end" });
            }
            break;
          }
          case "agent_end": {
            finishOnce("stop");
            break;
          }
          default:
            // Ignore session lifecycle events not relevant to a one-shot stream.
            break;
        }
      });

      // Build the prompt text. We don't currently support multimodal content
      // in this path — text-only messages get joined into a single user prompt.
      // The panel-side caller is responsible for any system prompt prefixing.
      const promptText = this.buildPromptText(options);

      try {
        await session.prompt(promptText);
        // Session may not have emitted agent_end yet on synchronous resolution
        // paths; ensure we send a finish chunk.
        if (!finished) finishOnce("stop");
      } finally {
        unsubscribeSession();
      }

      target.sendEnd();
      this.logger.info(`[${requestId}] streamText completed ${JSON.stringify({ streamId })}`);
    } catch (error) {
      this.logger.error(
        `[${requestId}] streamText error ${JSON.stringify({ streamId })} ${error instanceof Error ? error.stack : String(error)}`,
      );
      target.sendChunk({
        type: "error",
        error: error instanceof Error ? error.message : String(error),
      });
      target.sendEnd();
    } finally {
      try {
        session?.dispose();
      } catch {
        // best-effort cleanup
      }
      unsubscribe?.();
      this.streamManager.cleanup(streamId);
    }
  }

  /**
   * Flatten StreamTextOptions messages into a single user-prompt string.
   *
   * Pi's `session.prompt()` takes a text string and conducts the conversation
   * itself. Callers that need richer message history should use the dedicated
   * chat worker path, not this one-shot helper.
   */
  private buildPromptText(options: StreamTextOptions): string {
    const parts: string[] = [];
    if (options.system) {
      parts.push(options.system);
    }
    for (const msg of options.messages) {
      if (msg.role === "system") {
        parts.push(typeof msg.content === "string" ? msg.content : "");
        continue;
      }
      if (msg.role === "user") {
        if (typeof msg.content === "string") {
          parts.push(msg.content);
        } else {
          for (const part of msg.content) {
            if (part.type === "text") {
              parts.push(part.text);
            }
          }
        }
        continue;
      }
      if (msg.role === "assistant") {
        if (typeof msg.content === "string") {
          parts.push(`Assistant: ${msg.content}`);
        } else {
          for (const part of msg.content) {
            if (part.type === "text") {
              parts.push(`Assistant: ${part.text}`);
            }
          }
        }
        continue;
      }
      // Tool messages are not flattened — this path doesn't replay tool history.
    }
    return parts.join("\n\n").trim();
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
