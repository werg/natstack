/**
 * Pi Responder Agent
 *
 * An agent that uses the Pi Coding Agent SDK to respond to messages on a pubsub channel.
 * Discovers tools from other participants via agentic-messaging and provides them to Pi
 * as custom tools — no HTTP MCP bridge needed.
 *
 * Architecture:
 * 1. Agent connects to pubsub and discovers tools
 * 2. Converts pubsub tools to Pi custom tools via toPiCustomTools()
 * 3. Creates a Pi session lazily with createAgentSession() (reused across messages)
 * 4. Streams events via session.subscribe()
 * 5. Tool approval handled by Pi's tool_call extension hook
 */

import { Agent, runAgent, type AgentState } from "@workspace/agent-runtime";
import {
  createMessageQueue,
  createInterruptController,
  createSettingsManager,
  createMissedContextManager,
  createTrackerManager,
  createContextTracker,
  createStandardTools,
  findPanelParticipant,
  discoverPubsubTools,
  toPiCustomTools,
  createCanUseToolGate,
  type MessageQueue,
  type PiToolDefinition,
} from "@workspace/agent-patterns";
import {
  createRichTextChatSystemPrompt,
} from "@workspace/agent-patterns/prompts";
import {
  createPauseMethodDefinition,
  getDetailedActionDescription,
  CONTENT_TYPE_TYPING,
  filterImageAttachments,
  validateAttachments,
  showPermissionPrompt,
  createQueuePositionText,
  cleanupQueuedTypingTrackers,
  drainForInterleave,
  createTypingTracker,
  createInterruptHandler,
  type ContextWindowUsage,
  type AgenticClient,
  type ChatParticipantMetadata,
  type IncomingNewMessage,
} from "@workspace/agentic-messaging";
import { prettifyToolName } from "@workspace/agentic-messaging/utils";
import type { Attachment } from "@natstack/pubsub";
import { PI_PARAMETERS } from "@workspace/agentic-messaging/config";
import { z } from "zod";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  AuthStorage,
  ModelRegistry,
  type AgentSession,
  type AgentSessionEvent,
  type ExtensionFactory,
  type ExtensionAPI,
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { getModel, getProviders, getModels, getOAuthProvider } from "@mariozechner/pi-ai";
import type { OAuthProviderId } from "@mariozechner/pi-ai";
import { randomUUID } from "node:crypto";

// =============================================================================
// Types
// =============================================================================

/** State persisted across agent wake/sleep cycles */
interface PiAgentState extends AgentState {
  /** Pi session file path for resumption */
  piSessionFile?: string;
}

/** Runtime-adjustable settings */
interface PiSettings {
  model?: string;
  thinkingLevel?: number; // 0=off, 1=minimal, 2=low, 3=medium, 4=high, 5=xhigh
  autonomyLevel?: number; // 0=read-only, 1=workspace-write, 2=full-access
  /** Whether we've shown at least one approval prompt (for first-time grant UI) */
  hasShownApprovalPrompt?: boolean;
  [key: string]: string | number | boolean | undefined;
}

// =============================================================================
// Helpers
// =============================================================================

/** Thinking level names for Pi SDK */
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** Map thinking level slider value to Pi SDK string */
function mapThinkingLevel(level: number | undefined): ThinkingLevel {
  if (level !== undefined && level >= 0 && level < THINKING_LEVELS.length) {
    return THINKING_LEVELS[level]!;
  }
  return "medium";
}

/**
 * Parse a Pi model string into provider and model ID.
 * Handles both "provider:modelId" format and plain model IDs.
 */
function parseModelId(model: string): { provider?: string; modelId: string } {
  if (model.includes(":")) {
    const [provider, ...rest] = model.split(":");
    return { provider, modelId: rest.join(":") };
  }
  return { modelId: model };
}

/**
 * Pick the most capable model from a list using maxTokens and contextWindow.
 * No hardcoded model names — purely based on model metadata.
 */
function pickMostCapable<T extends { maxTokens?: number; contextWindow?: number }>(models: T[]): T {
  return models.reduce((best, m) => {
    const bestMax = best.maxTokens ?? 0;
    const bestCtx = best.contextWindow ?? 0;
    const mMax = m.maxTokens ?? 0;
    const mCtx = m.contextWindow ?? 0;
    if (mMax > bestMax) return m;
    if (mMax === bestMax && mCtx > bestCtx) return m;
    return best;
  });
}

// =============================================================================
// Pi Agent
// =============================================================================

/** Queued message with per-message typing tracker */
interface QueuedMessageInfo {
  event: IncomingNewMessage;
  typingTracker: ReturnType<typeof createTypingTracker>;
}

class PiResponderAgent extends Agent<PiAgentState, ChatParticipantMetadata> {
  // Pattern helpers from @workspace/agent-patterns
  private queue!: MessageQueue<IncomingNewMessage>;
  private interrupt!: ReturnType<typeof createInterruptController>;
  private settingsMgr!: ReturnType<typeof createSettingsManager<PiSettings>>;
  private missedContext!: ReturnType<typeof createMissedContextManager>;
  private trackers!: ReturnType<typeof createTrackerManager>;
  private contextTracker!: ReturnType<typeof createContextTracker>;

  // Per-message typing trackers for queue position display
  private queuedMessages = new Map<string, QueuedMessageInfo>();

  /**
   * Context folder path used as cwd for Pi.
   * Set from initInfo.contextFolderPath in onWake (fail fast if missing).
   */
  private contextFolderPath!: string;

  // --- Auth & model registry (shared with Pi CLI) ---

  /** OAuth + API key credential storage (~/.pi/agent/auth.json) */
  private authStorage: AuthStorage | null = null;

  /** Model registry with auth resolution (wraps AuthStorage) */
  private modelRegistry: ModelRegistry | null = null;

  // --- Session state (persists across messages, lazily created) ---

  /** Active Pi session (disposed on sleep) */
  private piSession: AgentSession | null = null;

  /** Cached resource loader (created once per agent lifetime) */
  private resourceLoader: DefaultResourceLoader | null = null;

  /** Current model string for detecting settings changes */
  private currentModelString: string | null = null;

  /** Current thinking level for detecting settings changes */
  private currentThinkingLevel: ThinkingLevel | null = null;

  /** Mutable approval gate — updated per-message, read by extension hook */
  private currentApprovalGate: ReturnType<typeof createCanUseToolGate> | null = null;

  /** Previous cumulative token counts for computing per-turn deltas */
  private prevTokens = { input: 0, output: 0, cost: 0 };

  /** Tool name mapping for action display (persists with session) */
  private originalToDisplay = new Map<string, string>();

  /** Sorted tool names from last session creation — detect tool-set changes */
  private currentToolNames: string | null = null;

  state: PiAgentState = {};

  getConnectOptions() {
    const contextId = this.ctx.config["contextId"] as string | undefined;

    if (!contextId) {
      this.log.warn("contextId not provided - session persistence may fail");
    }

    return {
      name: "Pi",
      type: "pi" as const,
      reconnect: true,
      replaySinceId: this.lastCheckpoint,
      ...(contextId && { contextId }),
      extraMetadata: {
        agentTypeId: this.agentId,
      },
      methods: {
        pause: createPauseMethodDefinition(async () => {
          this.interrupt.pause();
          this.interrupt.abortCurrent();
          this.log.info("Pause RPC received");
        }),
        settings: {
          description: "Configure Pi settings",
          parameters: z.object({}),
          menu: true,
          execute: async () => this.handleSettingsMenu(),
        },
        set_title: {
          description: `Set the channel/conversation title displayed to users.

Call this tool:
- Early in the conversation when the topic becomes clear
- When the topic shifts significantly to a new subject
- To provide a concise summary (1-5 words) of what this conversation is about

Examples: "Debug React Hooks", "Refactor Auth Module", "Setup CI Pipeline"`,
          parameters: z.object({
            title: z.string().max(200).describe("Brief title for this conversation (1-5 words)"),
          }),
          execute: async ({ title }: { title: string }) => {
            await this.client.setChannelTitle(title);
            this.log.info(`Set channel title to: ${title}`);
            return { success: true, title };
          },
        },
      },
    };
  }

  getEventsOptions(): { targetedOnly: boolean; respondWhenSolo: boolean } {
    return { targetedOnly: true, respondWhenSolo: true };
  }

  async onWake(): Promise<void> {
    const client = this.ctx.client as AgenticClient<ChatParticipantMetadata>;
    this.queue = createMessageQueue<IncomingNewMessage>({
      onProcess: (event) => this.handleUserMessage(event),
      onError: (err, event) => this.log.error(`Error processing message ${event.id}`, err),
      onDequeue: async (event) => {
        const msgEvent = event;
        this.queuedMessages.delete(msgEvent.id);

        let position = 0;
        for (const [_id, info] of this.queuedMessages) {
          const positionText = createQueuePositionText({
            queueLength: position,
            isProcessing: true,
          });
          await info.typingTracker.startTyping(positionText);
          position++;
        }
      },
      onHeartbeat: async () => {
        try {
          await client.publish("agent-heartbeat", { agentId: this.agentId }, { persist: false });
        } catch (err) {
          this.log.warn(`Heartbeat failed: ${err}`);
        }
      },
    });

    this.interrupt = createInterruptController();

    // sinceId skips events already in the AI thread history
    // excludeSenderTypes filters out the agent's own responses
    this.missedContext = createMissedContextManager({
      client: this.ctx.client as AgenticClient<ChatParticipantMetadata>,
      maxChars: 8000,
      sinceId: this.lastCheckpoint,
      excludeSenderTypes: ["pi"],
    });

    this.trackers = createTrackerManager({
      client: this.ctx.client as AgenticClient<ChatParticipantMetadata>,
      senderInfo: {
        senderId: (this.ctx.client as AgenticClient<ChatParticipantMetadata>).clientId ?? "",
        senderName: "Pi",
        senderType: "pi",
      },
      log: (msg) => this.log.debug(msg),
    });

    // Initialize auth storage and model registry (shares credentials with Pi CLI)
    this.authStorage = AuthStorage.create();
    this.modelRegistry = new ModelRegistry(this.authStorage);

    // Select best default model by probing available credentials
    const defaultModel = this.selectDefaultModel();

    this.settingsMgr = createSettingsManager<PiSettings>({
      client: this.ctx.client as AgenticClient<ChatParticipantMetadata>,
      defaults: { model: defaultModel, thinkingLevel: 3, autonomyLevel: 2 },
      initConfig: {
        model: this.ctx.config["model"] as string | undefined,
        thinkingLevel: this.ctx.config["thinkingLevel"] as number | undefined,
        autonomyLevel: this.ctx.config["autonomyLevel"] as number | undefined,
      },
    });
    await this.settingsMgr.load();

    // Fail fast if contextFolderPath is not available
    const contextFolderPath = this.initInfo.contextFolderPath;
    if (!contextFolderPath) {
      throw new Error("contextFolderPath is required but was not provided in initInfo");
    }
    this.contextFolderPath = contextFolderPath;
    this.log.info(`Context folder path: ${this.contextFolderPath}`);

    // Handle roster changes
    client.onRoster((roster) => {
      const names = Object.values(roster.participants).map(
        (p) => `${p.metadata.name} (${p.metadata.type})`
      );
      this.log.info(`Roster updated: ${names.join(", ")}`);
    });

    // Handle reconnection for missed context
    client.onReconnect(() => {
      this.missedContext.rebuild();
    });

    // Initialize context tracker
    const currentSettings = this.settingsMgr.get();
    this.contextTracker = createContextTracker({
      model: currentSettings.model,
      log: (msg) => this.log.debug(msg),
      onUpdate: async (usage: ContextWindowUsage) => {
        const currentMetadata = client.clientId
          ? client.roster[client.clientId]?.metadata
          : undefined;

        const metadata: ChatParticipantMetadata = {
          name: "Pi",
          type: "pi",
          handle: this.handle,
          agentTypeId: this.agentId,
          ...currentMetadata,
          contextUsage: usage,
          activeModel: this.settingsMgr.get().model,
        };

        try {
          await client.updateMetadata(metadata);
        } catch (err) {
          this.log.info(`Failed to update context usage metadata: ${err}`);
        }
      },
    });

    this.log.info("Pi agent woke up");
  }

  async onEvent(event: { type: string }): Promise<void> {
    if (event.type !== "message") return;

    const msgEvent = event as IncomingNewMessage;

    // Skip replay messages
    if ("kind" in msgEvent && msgEvent.kind === "replay") return;

    // Skip typing indicators
    const contentType = (msgEvent as { contentType?: string }).contentType;
    if (contentType === CONTENT_TYPE_TYPING) return;

    const client = this.ctx.client as AgenticClient<ChatParticipantMetadata>;
    const sender = client.roster[msgEvent.senderId];

    // Only respond to messages from panels
    if (sender?.metadata.type === "panel" && msgEvent.senderId !== client.clientId) {
      const typingTracker = createTypingTracker({
        client,
        replyTo: msgEvent.id,
        senderInfo: {
          senderId: client.clientId ?? "",
          senderName: "Pi",
          senderType: "pi",
        },
        log: (msg) => this.log.debug(msg),
      });

      const positionText = createQueuePositionText({
        queueLength: this.queuedMessages.size,
        isProcessing: this.queue.isProcessing(),
      });
      await typingTracker.startTyping(positionText);

      this.queuedMessages.set(msgEvent.id, { event: msgEvent, typingTracker });

      const enqueued = this.queue.enqueue(msgEvent);
      if (!enqueued) {
        await typingTracker.cleanup();
        this.queuedMessages.delete(msgEvent.id);
      }
    }
  }

  async onSleep(): Promise<void> {
    this.queue.stop();
    await this.queue.drain();
    this.interrupt.cleanup();

    await cleanupQueuedTypingTrackers(this.queuedMessages, (msg) => this.log.warn(msg));

    // Dispose Pi session and reset cached state
    if (this.piSession) {
      try {
        this.piSession.dispose();
      } catch (err) {
        this.log.warn(`Failed to dispose Pi session: ${err}`);
      }
      this.piSession = null;
    }
    this.authStorage = null;
    this.modelRegistry = null;
    this.resourceLoader = null;
    this.currentModelString = null;
    this.currentThinkingLevel = null;
    this.currentApprovalGate = null;
    this.currentToolNames = null;
    this.prevTokens = { input: 0, output: 0, cost: 0 };
    this.originalToDisplay.clear();

    this.log.info("Pi agent going to sleep");
  }

  // ---------------------------------------------------------------------------
  // OAuth provider detection
  // ---------------------------------------------------------------------------

  /**
   * Providers that have OAuth login flows available.
   * If credentials already exist (API key OR OAuth token), login is skipped.
   * This just determines which providers CAN be logged into interactively.
   */
  private static readonly OAUTH_PROVIDERS = new Set([
    "anthropic",          // Claude Pro/Max subscription (device code)
    "google-gemini-cli",  // Google subscription via Gemini CLI OAuth
    "github-copilot",     // GitHub Copilot subscription
    "openai-codex",       // ChatGPT/OpenAI subscription via OAuth
  ]);

  /**
   * Determine if the model string's provider requires/supports OAuth login.
   * Returns the provider ID if OAuth is available, undefined otherwise.
   */
  private getOAuthProviderId(modelString: string): string | undefined {
    const { provider } = parseModelId(modelString);
    const resolved = provider ?? (modelString.startsWith("claude-") ? "anthropic" : undefined);
    if (resolved && PiResponderAgent.OAUTH_PROVIDERS.has(resolved)) return resolved;
    return undefined;
  }

  // ---------------------------------------------------------------------------
  // Smart default model selection
  // ---------------------------------------------------------------------------

  /**
   * Select the best default model by probing available credentials.
   * Prefers subscription (OAuth) providers over API key providers.
   * Among models, picks the most capable (highest output cost = most capable).
   */
  /** Preferred subscription providers in priority order */
  private static readonly PREFERRED_PROVIDERS = [
    "openai-codex",
    "anthropic",
    "google-gemini-cli",
    "github-copilot",
  ];

  private selectDefaultModel(): string {
    if (!this.authStorage || !this.modelRegistry) return "anthropic:claude-opus-4-6";

    this.modelRegistry.refresh();

    // Always prefer subscription providers — pick best model from the full catalog
    // (not just getAvailable). OAuth login triggers on first message if needed.
    for (const provider of PiResponderAgent.PREFERRED_PROVIDERS) {
      try {
        const models = getModels(provider as Parameters<typeof getModels>[0]);
        const providerReasoning = models.filter((m) => (m as { reasoning?: boolean }).reasoning);
        if (providerReasoning.length > 0) {
          const best = pickMostCapable(providerReasoning);
          const hasAuth = this.authStorage.hasAuth(provider);
          const selected = `${provider}:${(best as { id: string }).id}`;
          this.log.info(`Auto-selected model: ${selected} (${hasAuth ? "authenticated" : "OAuth on first message"})`);
          return selected;
        }
      } catch {
        // Provider might not exist in this SDK version
      }
    }

    // No subscription providers available in SDK — fall back to best available model with credentials
    const available = this.modelRegistry.getAvailable();
    const reasoning = available.filter((m) => (m as { reasoning?: boolean }).reasoning);
    if (reasoning.length > 0) {
      const fallback = pickMostCapable(reasoning);
      const selected = `${fallback.provider}:${fallback.id}`;
      this.log.info(`Auto-selected model: ${selected} (API key fallback, from ${reasoning.length} available)`);
      return selected;
    }

    return "anthropic:claude-opus-4-6";
  }

  // ---------------------------------------------------------------------------
  // OAuth login flow
  // ---------------------------------------------------------------------------

  /**
   * Ensure the user is authenticated with the given OAuth provider.
   * If credentials already exist, returns true immediately.
   * Otherwise, shows interactive OAuth UI via feedback_custom.
   */
  private async ensureOAuthLogin(
    client: AgenticClient<ChatParticipantMetadata>,
    providerId: string,
  ): Promise<boolean> {
    if (!this.authStorage) return false;

    // Fast path: credentials already exist (API key or prior OAuth)
    if (this.authStorage.hasAuth(providerId)) return true;

    const panel = findPanelParticipant(client);
    if (!panel) {
      this.log.warn("No panel found for OAuth login UI");
      return false;
    }

    const abortController = new AbortController();
    const providerInfo = getOAuthProvider(providerId as OAuthProviderId);
    const providerName = providerInfo?.name ?? providerId;

    try {
      await this.authStorage.login(providerId as OAuthProviderId, {
        signal: abortController.signal,

        onAuth: (info) => {
          // Fire-and-forget: show auth page in panel UI
          const code = this.generateOAuthAuthUI(info.url, providerName, info.instructions);
          const handle = client.callMethod(panel.id, "feedback_custom", {
            code,
            title: `Sign in to ${providerName}`,
          });
          // Swallow errors (panel disconnect, etc.) but check for cancellation
          void handle.result
            .then((result) => {
              const content = (result as { content?: { type?: string } }).content;
              if (content?.type === "cancel") {
                abortController.abort();
              }
            })
            .catch(() => {});
        },

        onPrompt: async (prompt) => {
          return this.showOAuthPrompt(
            client,
            panel.id,
            prompt.message,
            prompt.placeholder,
            abortController,
          );
        },

        onManualCodeInput: async () => {
          return this.showOAuthPrompt(
            client,
            panel.id,
            "Paste the authorization code or callback URL:",
            "Code or URL",
            abortController,
          );
        },

        onProgress: (message) => {
          void this.trackers.typing.startTyping(message).catch(() => {});
        },
      });

      this.log.info(`OAuth login completed for ${providerId}`);
      return true;
    } catch (err) {
      if (abortController.signal.aborted) {
        this.log.info(`OAuth login cancelled for ${providerId}`);
        return false;
      }
      this.log.warn(`OAuth login failed for ${providerId}: ${err}`);
      return false;
    } finally {
      if (this.trackers.typing.isTyping()) {
        await this.trackers.typing.stopTyping();
      }
    }
  }

  // ---------------------------------------------------------------------------
  // OAuth UI helpers
  // ---------------------------------------------------------------------------

  /**
   * Show a blocking text-input prompt via feedback_custom.
   * Used for onPrompt and onManualCodeInput callbacks.
   */
  private async showOAuthPrompt(
    client: AgenticClient<ChatParticipantMetadata>,
    panelId: string,
    message: string,
    placeholder: string | undefined,
    abortController: AbortController,
  ): Promise<string> {
    const escapedMessage = JSON.stringify(message);
    const escapedPlaceholder = JSON.stringify(placeholder ?? "");

    const code = `
import { useState } from "react";
import { Button, Flex, Text, TextField } from "@radix-ui/themes";

export default function OAuthPrompt({ onSubmit, onCancel }) {
  const [value, setValue] = useState("");

  const handleSubmit = () => {
    if (value.trim()) onSubmit({ type: "submit", value: value.trim() });
  };

  return (
    <Flex direction="column" gap="3" p="2">
      <Text size="2">${escapedMessage.slice(1, -1)}</Text>
      <TextField.Root
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") handleSubmit(); }}
        placeholder={${escapedPlaceholder}}
        autoFocus
      />
      <Flex gap="2" justify="end">
        <Button variant="soft" onClick={onCancel}>Cancel</Button>
        <Button onClick={handleSubmit} disabled={!value.trim()}>Submit</Button>
      </Flex>
    </Flex>
  );
}
`;

    const handle = client.callMethod(panelId, "feedback_custom", {
      code,
      title: "Authorization Required",
    });

    const result = await handle.result;
    const content = (result as { content?: { type?: string; value?: string } }).content;

    if (content?.type === "cancel" || !content?.value) {
      abortController.abort();
      throw new Error("OAuth login cancelled");
    }

    return content.value;
  }

  /**
   * Generate TSX code for the OAuth auth-page UI.
   * Fire-and-forget — auto-opens URL in browser, shows status + cancel.
   */
  private generateOAuthAuthUI(
    url: string,
    providerName: string,
    instructions?: string,
  ): string {
    const escapedUrl = JSON.stringify(url);
    const escapedProvider = JSON.stringify(providerName);
    const escapedInstructions = instructions ? JSON.stringify(instructions) : "null";

    return `
import { useEffect } from "react";
import { Button, Flex, Text, Callout } from "@radix-ui/themes";
import { ExternalLinkIcon } from "@radix-ui/react-icons";

export default function OAuthAuth({ onSubmit, onCancel }) {
  const url = ${escapedUrl};
  const provider = ${escapedProvider};
  const instructions = ${escapedInstructions};

  useEffect(() => {
    window.open(url, "_blank");
  }, []);

  return (
    <Flex direction="column" gap="3" p="2">
      <Text size="2" weight="bold">Authorizing with {provider}...</Text>
      <Text size="2" color="gray">
        A browser window should have opened. Complete the sign-in flow there,
        then return here.
      </Text>
      {instructions && (
        <Callout.Root size="1">
          <Callout.Text>{instructions}</Callout.Text>
        </Callout.Root>
      )}
      <Flex gap="2" justify="end">
        <Button variant="soft" onClick={() => window.open(url, "_blank")}>
          <ExternalLinkIcon /> Open Again
        </Button>
        <Button variant="soft" color="red" onClick={onCancel}>Cancel</Button>
      </Flex>
    </Flex>
  );
}
`;
  }

  // ---------------------------------------------------------------------------
  // Session management — lazy creation, reuse across messages
  // ---------------------------------------------------------------------------

  /**
   * Get or create a Pi session. Reuses the existing session if model/thinking
   * settings haven't changed. Creates a new session on first call or when
   * settings change.
   */
  private async ensurePiSession(
    client: AgenticClient<ChatParticipantMetadata>,
    piTools: PiToolDefinition[],
    displayMap: Map<string, string>,
  ): Promise<AgentSession> {
    const settings = this.settingsMgr.get();
    const thinkingLevel = mapThinkingLevel(settings.thinkingLevel);
    const modelString = settings.model ?? "claude-opus-4-6";
    const toolNames = piTools.map((t) => t.name).sort().join(",");

    // Reuse existing session if settings and tools haven't changed
    if (
      this.piSession &&
      this.currentModelString === modelString &&
      this.currentThinkingLevel === thinkingLevel &&
      this.currentToolNames === toolNames
    ) {
      this.originalToDisplay = displayMap;
      return this.piSession;
    }

    // Dispose old session if it exists
    if (this.piSession) {
      try {
        // Persist session file before disposing
        if (this.piSession.sessionFile) {
          this.setState({ piSessionFile: this.piSession.sessionFile });
        }
        this.piSession.dispose();
      } catch (err) {
        this.log.warn(`Failed to dispose old Pi session: ${err}`);
      }
      this.piSession = null;
      this.prevTokens = { input: 0, output: 0, cost: 0 };
    }

    // Create resource loader once (cached for agent lifetime)
    if (!this.resourceLoader) {
      // The permission extension reads from this.currentApprovalGate which is
      // updated per-message before each prompt. This lets the extension factory
      // be created once but the approval logic stays current.
      const permissionExtension: ExtensionFactory = (pi: ExtensionAPI) => {
        pi.on("tool_call", async (event) => {
          // Pi built-in tools (bash, edit, write, etc.) also pass through this hook.
          // They're not in byCanonical (pubsub registry) but createCanUseToolGate
          // handles this correctly — creates a minimal tool object and delegates to
          // needsApprovalForTool() which auto-approves at autonomy level 2 and
          // prompts at levels 0-1.
          if (!this.currentApprovalGate) return undefined;
          const { allow } = await this.currentApprovalGate.canUseTool(
            event.toolName,
            event.input as Record<string, unknown>,
          );
          if (!allow) {
            return { block: true, reason: "Blocked by autonomy level" };
          }
          return undefined;
        });
      };

      this.resourceLoader = new DefaultResourceLoader({
        cwd: this.contextFolderPath,
        systemPrompt: createRichTextChatSystemPrompt(),
        extensionFactories: [permissionExtension],
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
      });
      await this.resourceLoader.reload();
    }

    // Create or resume session
    const { provider, modelId } = parseModelId(modelString);
    // Bare IDs: only infer "anthropic" for claude-* models. Unknown bare IDs warn and fall through.
    const resolvedProvider = provider ?? (modelId.startsWith("claude-") ? "anthropic" : undefined);
    const sessionManager = this.state.piSessionFile
      ? SessionManager.open(this.state.piSessionFile)
      : SessionManager.create(this.contextFolderPath);

    // Resolve model — try ModelRegistry first (handles OAuth tokens), then getModel
    let model;
    if (!resolvedProvider) {
      this.log.warn(`Unknown bare model ID "${modelId}" — no provider, using Pi default`);
    } else {
      try {
        model = this.modelRegistry?.find(resolvedProvider, modelId);
        if (!model) {
          model = getModel(resolvedProvider as any, modelId as any);
        }
      } catch {
        this.log.warn(
          `Model ${resolvedProvider}:${modelId} not found — using Pi default`
        );
      }
    }

    // Add standard tools (set_title, TodoWrite) so the LLM can call them
    const allCustomTools = [...piTools];
    const stdTools = createStandardTools({
      client,
      log: (msg: string) => this.log.info(msg),
    });
    for (const [name, stdTool] of Object.entries(stdTools)) {
      allCustomTools.push({
        name,
        label: name,
        description: stdTool.description,
        parameters: stdTool.parameters as Record<string, unknown>,
        execute: async (_toolCallId, params) => {
          const result = await stdTool.execute(params);
          const text = typeof result === "string" ? result : JSON.stringify(result);
          return { content: [{ type: "text" as const, text }], details: undefined as unknown };
        },
      });
      displayMap.set(name, name);
    }

    const { session } = await createAgentSession({
      cwd: this.contextFolderPath,
      model,
      thinkingLevel,
      customTools: allCustomTools as unknown as ToolDefinition[],
      resourceLoader: this.resourceLoader,
      sessionManager,
      ...(this.authStorage && { authStorage: this.authStorage }),
      ...(this.modelRegistry && { modelRegistry: this.modelRegistry }),
    });

    this.piSession = session;
    this.currentModelString = modelString;
    this.currentThinkingLevel = thinkingLevel;
    this.currentToolNames = toolNames;
    this.originalToDisplay = displayMap;

    // Persist session file for resumption
    if (session.sessionFile) {
      this.setState({ piSessionFile: session.sessionFile });
    }

    this.log.info(`Created Pi session (model: ${modelString}, thinking: ${thinkingLevel})`);
    return session;
  }

  // ---------------------------------------------------------------------------
  // Settings menu
  // ---------------------------------------------------------------------------

  /**
   * Build model options dynamically from Pi SDK's provider/model registry.
   * Shows auth status per-provider so users know which models are ready to use.
   */
  /**
   * Build provider/model data for the model picker UI.
   * Groups models by provider with auth status, subscription providers first.
   */
  private buildModelPickerData(): {
    providers: Array<{
      id: string;
      label: string;
      auth: "authenticated" | "login" | "api-key";
      subscription: boolean;
      models: Array<{ value: string; name: string }>;
    }>;
    currentModel: string;
  } {
    const currentModel = this.settingsMgr.get().model ?? "anthropic:claude-opus-4-6";
    const providerMap = new Map<string, {
      id: string;
      label: string;
      auth: "authenticated" | "login" | "api-key";
      subscription: boolean;
      models: Array<{ value: string; name: string }>;
    }>();

    try {
      const allProviders = getProviders();

      for (const provider of allProviders) {
        const models = getModels(provider);
        const reasoning = models.filter((m) => (m as { reasoning?: boolean }).reasoning);
        if (reasoning.length === 0) continue;

        const hasAuth = this.authStorage?.hasAuth(provider) ?? false;
        const isOAuth = !!getOAuthProvider(provider as OAuthProviderId);
        const auth: "authenticated" | "login" | "api-key" = hasAuth
          ? "authenticated"
          : isOAuth ? "login" : "api-key";

        providerMap.set(provider, {
          id: provider,
          label: provider,
          auth,
          subscription: isOAuth,
          models: reasoning.map((m) => ({
            value: `${provider}:${(m as { id: string }).id}`,
            name: (m as { name: string }).name,
          })),
        });
      }
    } catch (err) {
      this.log.warn(`Failed to build model picker data: ${err}`);
    }

    // Sort: subscription providers first (in PREFERRED_PROVIDERS order), then the rest
    const preferred = PiResponderAgent.PREFERRED_PROVIDERS;
    const sorted = [...providerMap.values()].sort((a, b) => {
      const ai = preferred.indexOf(a.id);
      const bi = preferred.indexOf(b.id);
      const aRank = ai >= 0 ? ai : preferred.length + (a.subscription ? 0 : 100);
      const bRank = bi >= 0 ? bi : preferred.length + (b.subscription ? 0 : 100);
      return aRank - bRank;
    });

    if (sorted.length === 0) {
      sorted.push({
        id: "anthropic",
        label: "anthropic",
        auth: "api-key",
        subscription: false,
        models: [
          { value: "anthropic:claude-opus-4-6", name: "Claude Opus 4.6" },
          { value: "anthropic:claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
        ],
      });
    }

    return { providers: sorted, currentModel };
  }

  /**
   * Generate a feedback_custom component for model selection.
   * Shows providers as an accordion with models listed under each.
   * Subscription/authenticated providers shown first; others behind "More providers...".
   */
  private generateModelPickerUI(): string {
    const { providers, currentModel } = this.buildModelPickerData();

    // Split into primary (subscription or authenticated) and secondary
    const primary = providers.filter((p) => p.subscription || p.auth === "authenticated");
    const secondary = providers.filter((p) => !p.subscription && p.auth !== "authenticated");

    const data = JSON.stringify({ primary, secondary, currentModel });

    return `
import { useState } from "react";
import { Flex, Text, Button, Badge, ScrollArea } from "@radix-ui/themes";
import { ChevronDownIcon, ChevronRightIcon, CheckIcon } from "@radix-ui/react-icons";

const { primary, secondary, currentModel } = ${data};

function AuthBadge({ auth }) {
  if (auth === "authenticated") return <Badge color="green" size="1">ready</Badge>;
  if (auth === "login") return <Badge color="blue" size="1">login available</Badge>;
  return <Badge color="gray" size="1">API key needed</Badge>;
}

function ProviderSection({ provider, selected, onSelect }) {
  const [open, setOpen] = useState(
    provider.models.some((m) => m.value === selected)
  );

  return (
    <div style={{ borderBottom: "1px solid var(--gray-a5)" }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          display: "flex", alignItems: "center", gap: 8, width: "100%",
          padding: "8px 12px", background: "none", border: "none",
          cursor: "pointer", color: "var(--gray-12)", fontSize: 13,
        }}
      >
        {open ? <ChevronDownIcon /> : <ChevronRightIcon />}
        <Text size="2" weight="medium" style={{ flex: 1, textAlign: "left" }}>
          {provider.label}
        </Text>
        <AuthBadge auth={provider.auth} />
      </button>
      {open && (
        <div style={{ padding: "0 12px 8px 32px" }}>
          {provider.models.map((model) => (
            <button
              key={model.value}
              onClick={() => onSelect(model.value)}
              style={{
                display: "flex", alignItems: "center", gap: 8, width: "100%",
                padding: "6px 8px", background: model.value === selected
                  ? "var(--accent-a3)" : "none",
                border: model.value === selected
                  ? "1px solid var(--accent-7)" : "1px solid transparent",
                borderRadius: 6, cursor: "pointer", color: "var(--gray-12)",
                fontSize: 13, marginBottom: 2,
              }}
            >
              {model.value === selected && <CheckIcon style={{ color: "var(--accent-9)" }} />}
              <Text size="2">{model.name}</Text>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function ModelPicker({ onSubmit, onCancel }) {
  const [selected, setSelected] = useState(currentModel);
  const [showMore, setShowMore] = useState(false);

  return (
    <Flex direction="column" gap="3" style={{ minWidth: 320 }}>
      <Text size="3" weight="bold">Select Model</Text>
      <ScrollArea style={{ maxHeight: 400 }}>
        <div style={{ border: "1px solid var(--gray-a5)", borderRadius: 8, overflow: "hidden" }}>
          {primary.map((p) => (
            <ProviderSection key={p.id} provider={p} selected={selected} onSelect={setSelected} />
          ))}
          {secondary.length > 0 && (
            <>
              <button
                onClick={() => setShowMore(!showMore)}
                style={{
                  display: "flex", alignItems: "center", gap: 8, width: "100%",
                  padding: "8px 12px", background: "none", border: "none",
                  borderTop: "1px solid var(--gray-a5)",
                  cursor: "pointer", color: "var(--gray-9)", fontSize: 12,
                }}
              >
                {showMore ? <ChevronDownIcon /> : <ChevronRightIcon />}
                <Text size="1" color="gray">{secondary.length} more provider{secondary.length > 1 ? "s" : ""}...</Text>
              </button>
              {showMore && secondary.map((p) => (
                <ProviderSection key={p.id} provider={p} selected={selected} onSelect={setSelected} />
              ))}
            </>
          )}
        </div>
      </ScrollArea>
      <Flex gap="2" justify="end">
        <Button variant="soft" color="gray" onClick={onCancel}>Cancel</Button>
        <Button onClick={() => onSubmit({ model: selected })}>
          {selected === currentModel ? "Keep Current" : "Switch Model"}
        </Button>
      </Flex>
    </Flex>
  );
}
`;
  }

  private async handleSettingsMenu(): Promise<{
    success: boolean;
    cancelled?: boolean;
    error?: string;
    settings?: PiSettings;
  }> {
    const client = this.client as AgenticClient<ChatParticipantMetadata>;
    const panel = findPanelParticipant(client);
    if (!panel) throw new Error("No panel found");

    // Step 1: Model picker (feedback_custom with dynamic UI)
    const modelPickerCode = this.generateModelPickerUI();
    const modelHandle = client.callMethod(panel.id, "feedback_custom", {
      code: modelPickerCode,
      title: "Select Model",
    });

    const modelResult = await modelHandle.result;
    const modelContent = (modelResult as { content?: { type?: string; value?: { model?: string } } }).content;

    if (modelContent?.type === "cancel" || !modelContent?.value?.model) {
      this.log.info("Model selection cancelled");
      return { success: false, cancelled: true };
    }

    const selectedModel = modelContent.value.model;

    // Step 2: Remaining settings (feedback_form — excludes model field)
    const fields = PI_PARAMETERS.filter((p) => !p.channelLevel && p.key !== "model");
    const formHandle = client.callMethod(panel.id, "feedback_form", {
      title: "Pi Settings",
      fields,
      values: this.settingsMgr.get(),
    });

    const formResult = await formHandle.result;
    const feedbackResult = formResult.content as {
      type: string;
      value?: unknown;
      message?: string;
    };

    if (feedbackResult.type === "cancel") {
      this.log.info("Settings cancelled");
      return { success: false, cancelled: true };
    }

    if (feedbackResult.type === "error") {
      this.log.info(`Settings error: ${feedbackResult.message}`);
      return { success: false, error: feedbackResult.message };
    }

    // Merge model selection with other settings
    const newSettings = { ...(feedbackResult.value as PiSettings), model: selectedModel };
    await this.settingsMgr.update(newSettings);
    this.log.info(`Settings updated: ${JSON.stringify(this.settingsMgr.get())}`);

    // Update metadata with new model
    const currentMetadata = client.clientId
      ? client.roster[client.clientId]?.metadata
      : undefined;
    const metadata: ChatParticipantMetadata = {
      name: "Pi",
      type: "pi",
      handle: this.handle,
      agentTypeId: this.agentId,
      ...currentMetadata,
      activeModel: this.settingsMgr.get().model,
    };
    try {
      await client.updateMetadata(metadata);
    } catch (err) {
      this.log.info(`Failed to update metadata after settings change: ${err}`);
    }

    return { success: true, settings: this.settingsMgr.get() };
  }

  // ---------------------------------------------------------------------------
  // Core message handling
  // ---------------------------------------------------------------------------

  private async handleUserMessage(incoming: IncomingNewMessage): Promise<void> {
    this.log.info(`Received message: ${incoming.content}`);
    const client = this.ctx.client as AgenticClient<ChatParticipantMetadata>;

    // Stop the per-message queue position typing indicator
    const queuedInfo = this.queuedMessages.get(incoming.id);
    if (queuedInfo) {
      await queuedInfo.typingTracker.cleanup();
      this.queuedMessages.delete(incoming.id);
    }

    // Create per-message interrupt handler
    const interruptHandler = createInterruptHandler({
      client,
      messageId: incoming.id,
      onPause: async (reason) => {
        this.log.info(`Pause received: ${reason}`);
        this.queue.pause();
        // Abort the Pi session — causes prompt() to resolve/reject
        if (this.piSession) {
          await this.piSession.abort();
        }
      },
    });
    void interruptHandler.monitor();

    // Build prompt with missed context
    let prompt = incoming.content;
    const missedCtx = this.missedContext.consume();
    if (missedCtx) {
      prompt = `<missed_context>\n${missedCtx}\n</missed_context>\n\n${prompt}`;
    }

    // Process image attachments
    const attachments = (incoming as { attachments?: Attachment[] }).attachments;
    const imageAttachments = filterImageAttachments(attachments);
    if (imageAttachments.length > 0) {
      const validation = validateAttachments(imageAttachments);
      if (!validation.valid) {
        this.log.info(`Attachment validation failed: ${validation.error}`);
      }
      this.log.info(`Processing ${imageAttachments.length} image attachment(s)`);
    }

    // Reply anchoring
    let replyToId = incoming.id;
    this.trackers.setReplyTo(replyToId);

    // Start typing indicator
    await this.trackers.typing.startTyping("preparing response");

    // Defer creating response message until we have content
    let responseId: string | null = null;
    const ensureResponseMessage = async (): Promise<string> => {
      if (this.trackers.typing.isTyping()) {
        await this.trackers.typing.stopTyping();
      }
      if (!responseId) {
        const { messageId } = await client.send("", { replyTo: replyToId });
        responseId = messageId;
        this.log.info(`Created response message: ${responseId}`);
      }
      return responseId;
    };

    // Discover tools via registry
    const registry = await discoverPubsubTools(client, {
      allowlist: ["feedback_form", "feedback_custom", "eval"],
      namePrefix: "pubsub",
      timeoutMs: 1500,
    });
    this.log.info(
      `Discovered ${registry.tools.length} tools from pubsub participants`
    );

    // Build Pi custom tool definitions via adapter (pubsub tools only)
    const { customTools: piTools, originalToDisplay } = toPiCustomTools(
      registry,
      client,
    );

    // Update approval gate for this message (pubsub registry may have changed)
    this.currentApprovalGate = createCanUseToolGate({
      byCanonical: registry.byCanonical,
      getApprovalLevel: () => this.settingsMgr.get().autonomyLevel ?? 0,
      hasShownApprovalPrompt: !!this.settingsMgr.get().hasShownApprovalPrompt,
      showPermissionPrompt: async (_tool, input) => {
        const panel = findPanelParticipant(client);
        if (!panel) return { allow: false };
        const currentSettings = this.settingsMgr.get();
        return showPermissionPrompt(
          client,
          panel.id,
          _tool.canonicalName,
          input as Record<string, unknown>,
          {
            isFirstTimeGrant: !currentSettings.hasShownApprovalPrompt,
            floorLevel: currentSettings.autonomyLevel ?? 0,
          }
        );
      },
      onAlwaysAllow: () => {
        void this.settingsMgr.update({ autonomyLevel: 2 });
      },
      onFirstPrompt: () => {
        void this.settingsMgr.update({ hasShownApprovalPrompt: true });
      },
    });

    try {
      // Check if OAuth login is needed for the configured model
      const modelString = this.settingsMgr.get().model ?? "claude-opus-4-6";
      const oauthProvider = this.getOAuthProviderId(modelString);
      if (oauthProvider) {
        const ok = await this.ensureOAuthLogin(client, oauthProvider);
        if (!ok) {
          await this.trackers.typing.cleanup();
          const { messageId: errId } = await client.send("", { replyTo: replyToId });
          await client.error(errId, `Authentication with ${oauthProvider} was cancelled or failed. Please try again or choose a different model in settings.`);
          return;
        }
      }

      // Get or create Pi session (reuses if settings unchanged)
      const session = await this.ensurePiSession(client, piTools, originalToDisplay);

      // Build image content for prompt (Pi SDK format: { type, data, mimeType })
      const promptImages = imageAttachments.length > 0
        ? imageAttachments.map((a) => ({
            type: "image" as const,
            data: Buffer.from(a.data).toString("base64"),
            mimeType: a.mimeType ?? "image/png",
          }))
        : undefined;

      // Subscribe to session events for streaming UI updates.
      // Events are processed sequentially via an async queue to prevent races
      // between event handlers and the post-prompt completion check.
      const streamState = { hasStreamedText: false };
      let eventQueue: Promise<void> = Promise.resolve();
      const enqueueEvent = (event: AgentSessionEvent) => {
        eventQueue = eventQueue.then(() =>
          this.handlePiEvent(event, {
            client,
            ensureResponseMessage,
            replyToId: () => replyToId,
            responseId: () => responseId,
            interruptHandler,
            streamState,
            onInterleave: async (pending) => {
              const lastMsg = pending[pending.length - 1] as IncomingNewMessage;
              replyToId = lastMsg.id;
              this.trackers.setReplyTo(replyToId);

              // Collect text and images from all pending messages
              const combinedText = pending.map((p) => String(p.content)).join("\n\n");
              const interleaveImages: Array<{ type: "image"; data: string; mimeType: string }> = [];
              for (const p of pending) {
                const msgAttachments = filterImageAttachments(
                  (p as { attachments?: Attachment[] }).attachments
                );
                for (const a of msgAttachments) {
                  interleaveImages.push({
                    type: "image",
                    data: Buffer.from(a.data).toString("base64"),
                    mimeType: a.mimeType ?? "image/png",
                  });
                }
              }

              await session.followUp(
                combinedText,
                interleaveImages.length > 0 ? interleaveImages as any : undefined,
              );
              this.log.info(
                `Interleaved ${pending.length} message(s)` +
                (interleaveImages.length > 0 ? ` with ${interleaveImages.length} image(s)` : "")
              );
            },
          }).catch((err) => {
            this.log.warn(`Event handler error: ${err}`);
          })
        );
      };
      const unsubscribe = session.subscribe(enqueueEvent);

      try {
        // session.prompt() resolves when the agent loop completes (including follow-ups).
        // No polling needed — this is the completion signal.
        await session.prompt(prompt, promptImages ? { images: promptImages as any } : undefined);
      } catch (err) {
        // session.abort() may cause prompt() to reject — that's expected for interrupts
        if (!interruptHandler.isPaused()) {
          throw err;
        }
        this.log.info("Session aborted due to pause");
      } finally {
        unsubscribe();
      }

      // Drain any remaining queued event handlers before checking responseId.
      // This ensures message_end fallback writes complete before the "no output" check.
      await eventQueue;

      // Complete the response message
      if (responseId) {
        await client.complete(responseId);
        this.log.info(`Completed response for ${replyToId}`);
      } else {
        // Model produced no text output — inform the user
        await this.trackers.typing.cleanup();
        const modelString = this.settingsMgr.get().model ?? "unknown";
        const { messageId: emptyMsgId } = await client.send("", { replyTo: replyToId });
        await client.error(emptyMsgId, `Model ${modelString} returned no response. Try switching to a different model via the settings menu.`);
        this.log.warn(`Model ${modelString} produced no output for message ${replyToId}`);
      }

      // Track token usage from session stats
      try {
        const stats = session.getSessionStats();
        const inputDelta = stats.tokens.input - this.prevTokens.input;
        const outputDelta = stats.tokens.output - this.prevTokens.output;
        const costDelta = stats.cost - this.prevTokens.cost;
        this.prevTokens = {
          input: stats.tokens.input,
          output: stats.tokens.output,
          cost: stats.cost,
        };

        if (inputDelta > 0 || outputDelta > 0) {
          await this.contextTracker.recordUsage({
            inputTokens: inputDelta,
            outputTokens: outputDelta,
            costUsd: costDelta,
          });
        }
      } catch (err) {
        this.log.debug(`Failed to get session stats: ${err}`);
      }

      await this.contextTracker.endTurn();

      // Persist session file for resumption
      if (session.sessionFile) {
        this.setState({ piSessionFile: session.sessionFile });
      }

    } catch (err) {
      await this.trackers.cleanupAll();

      console.error(`[Pi Agent] Error:`, err);

      if (responseId) {
        await client.error(responseId, err instanceof Error ? err.message : String(err));
      } else {
        const { messageId: errorMsgId } = await client.send("", { replyTo: replyToId });
        await client.error(errorMsgId, err instanceof Error ? err.message : String(err));
      }
    } finally {
      interruptHandler.cleanup();
      this.queue.resume();
      this.interrupt.resume();
    }
  }

  // ---------------------------------------------------------------------------
  // Pi event → NatStack pattern mapping
  // ---------------------------------------------------------------------------

  /**
   * Handle a Pi session event and map it to NatStack patterns.
   * Called from the session.subscribe() callback during streaming.
   */
  private async handlePiEvent(
    event: AgentSessionEvent,
    ctx: {
      client: AgenticClient<ChatParticipantMetadata>;
      ensureResponseMessage: () => Promise<string>;
      replyToId: () => string;
      responseId: () => string | null;
      interruptHandler: ReturnType<typeof createInterruptHandler>;
      streamState: { hasStreamedText: boolean };
      onInterleave: (pending: IncomingNewMessage[]) => Promise<void>;
    },
  ): Promise<void> {
    const eventType = (event as { type: string }).type;

    switch (eventType) {
      case "agent_start": {
        if (this.trackers.typing.isTyping()) {
          await this.trackers.typing.stopTyping();
        }
        break;
      }

      case "message_update": {
        // Text or thinking delta — access via assistantMessageEvent
        const update = event as {
          type: "message_update";
          message: unknown;
          assistantMessageEvent: { type: string; delta?: string; content?: string };
        };
        const ame = update.assistantMessageEvent;

        if (ame.type === "thinking_delta" && ame.delta) {
          if (!this.trackers.thinking.isThinking()) {
            await this.trackers.thinking.startThinking();
          }
          await this.trackers.thinking.updateThinking(ame.delta);
        } else if (ame.type === "text_delta" && ame.delta) {
          if (this.trackers.thinking.isThinking()) {
            await this.trackers.thinking.endThinking();
          }
          this.trackers.thinking.setTextMode();
          ctx.streamState.hasStreamedText = true;
          const msgId = await ctx.ensureResponseMessage();
          await ctx.client.update(msgId, ame.delta);
        } else if (ame.type === "text_end" && ame.content && !ctx.streamState.hasStreamedText) {
          // Fallback: text_end delivers full text when text_delta events were skipped
          if (this.trackers.thinking.isThinking()) {
            await this.trackers.thinking.endThinking();
          }
          this.trackers.thinking.setTextMode();
          ctx.streamState.hasStreamedText = true;
          const msgId = await ctx.ensureResponseMessage();
          await ctx.client.update(msgId, ame.content);
          this.log.info("Used text_end fallback (no text_delta events received)");
        } else if (ame.type === "error") {
          const errEvent = ame as { type: "error"; reason?: string };
          this.log.warn(`Pi SDK error event: ${errEvent.reason ?? "unknown"}`);
        }
        break;
      }

      case "message_start": {
        if (this.trackers.thinking.isThinking()) {
          await this.trackers.thinking.endThinking();
        }
        break;
      }

      case "message_end": {
        if (this.trackers.thinking.isThinking()) {
          await this.trackers.thinking.endThinking();
        }

        // Fallback: if no text was streamed, extract from the complete message
        if (!ctx.streamState.hasStreamedText) {
          const endEvent = event as {
            type: "message_end";
            message?: { content?: Array<{ type: string; text?: string }> };
          };
          const textParts = endEvent.message?.content?.filter(
            (c) => c.type === "text" && c.text
          );
          const fullText = textParts?.map((c) => c.text).join("") ?? "";
          if (fullText) {
            this.trackers.thinking.setTextMode();
            ctx.streamState.hasStreamedText = true;
            const msgId = await ctx.ensureResponseMessage();
            await ctx.client.update(msgId, fullText);
            this.log.info("Used message_end fallback (no streaming events received)");
          }
        }
        break;
      }

      case "tool_execution_start": {
        const toolEvent = event as {
          type: "tool_execution_start";
          toolName: string;
          args: any;
          toolCallId: string;
        };

        if (this.trackers.typing.isTyping()) {
          await this.trackers.typing.stopTyping();
        }
        if (this.trackers.thinking.isThinking()) {
          await this.trackers.thinking.endThinking();
        }

        const displayName = this.originalToDisplay.get(toolEvent.toolName) ?? prettifyToolName(toolEvent.toolName);
        const args = toolEvent.args ?? {};

        await this.trackers.action.startAction({
          type: displayName,
          description: getDetailedActionDescription(displayName, args),
          toolUseId: toolEvent.toolCallId ?? randomUUID(),
        });
        break;
      }

      case "tool_execution_end": {
        await this.trackers.action.completeAction();

        // Check for message interleaving on tool completion
        if (!ctx.interruptHandler.isPaused() && this.queue.getPendingCount() > 0) {
          const { pending } = await drainForInterleave(
            this.queue.takePending(),
            this.queuedMessages,
          );
          if (pending.length > 0) {
            await ctx.onInterleave(pending as IncomingNewMessage[]);
          } else {
            this.log.warn("Pending drained between check and take, skipping interleave");
          }
        }
        break;
      }

      case "turn_end": {
        // Turn-level tracking handled after prompt() resolves (Fix 5)
        break;
      }

      case "agent_end": {
        // Response completion and context tracking handled after prompt() resolves
        this.log.debug(`Agent loop finished for ${ctx.replyToId()}`);
        break;
      }

      default:
        this.log.debug(`Unhandled Pi event type: ${eventType}`);
        break;
    }
  }
}

// =============================================================================
// Bootstrap
// =============================================================================

void runAgent(PiResponderAgent);
