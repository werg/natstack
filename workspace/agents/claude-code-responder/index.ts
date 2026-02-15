/**
 * Claude Code Responder Agent
 *
 * AI-powered code assistant using the Claude Agent SDK.
 * Migrated from workspace/workers/claude-code-responder to use:
 * - Agent base class from @workspace/agent-runtime
 * - Pattern helpers from @workspace/agent-patterns
 *
 * Features:
 * - Claude Agent SDK integration with session resumption
 * - Complex tool handling with permission flows
 * - Restricted mode with pubsub-based tools
 * - Unrestricted mode with native SDK tools
 * - Image attachment handling via MCP
 * - Subagent management
 * - Session recovery
 */

import { execSync } from "child_process";
import { readdir, stat, readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

import { Agent, runAgent } from "@workspace/agent-runtime";
import type { EventStreamItem } from "@workspace/agentic-messaging";
import {
  jsonSchemaToZodRawShape,
  formatArgsForLog,
  createInterruptHandler,
  createPauseMethodDefinition,
  DEFAULT_MISSED_CONTEXT_MAX_CHARS,
  showPermissionPrompt,
  validateRestrictedMode,
  createThinkingTracker,
  createActionTracker,
  createTypingTracker,
  getDetailedActionDescription,
  CONTENT_TYPE_TYPING,
  CONTENT_TYPE_INLINE_UI,
  getCachedTodoListCode,
  filterImageAttachments,
  validateAttachments,
  uint8ArrayToBase64,
  SubagentManager,
  AgenticError,
  createQueuePositionText,
  cleanupQueuedTypingTrackers,
  drainForInterleave,
  type InlineUiData,
  type ContextWindowUsage,
  type SDKStreamEvent,
  type AgenticClient,
  type ChatParticipantMetadata,
  type IncomingNewMessage,
} from "@workspace/agentic-messaging";
import { prettifyToolName } from "@workspace/agentic-messaging/utils";
import type { Attachment, Participant } from "@workspace/pubsub";
import {
  recoverSession,
  generateRecoveryReviewUI,
  type PubsubMessageWithMetadata,
} from "@workspace/agentic-messaging/recovery";
import {
  CLAUDE_CODE_PARAMETERS,
  CLAUDE_MODEL_FALLBACKS,
  getRecommendedDefault,
  findNewestInFamily,
} from "@workspace/agentic-messaging/config";
import { z } from "zod";
import {
  query,
  tool,
  createSdkMcpServer,
  type Query,
  type SDKResultMessage,
  type CanUseTool,
} from "@anthropic-ai/claude-agent-sdk";
import {
  createMessageQueue,
  createInterruptController,
  createSettingsManager,
  createMissedContextManager,
  createContextTracker,
  findPanelParticipant,
  discoverPubsubToolsForMode,
  toClaudeMcpTools,
  createCanUseToolGate,
  type MessageQueue,
  type InterruptController,
  type SettingsManager,
  type MissedContextManager,
} from "@workspace/agent-patterns";
import {
  createRichTextChatSystemPrompt,
  createRestrictedModeSystemPrompt,
} from "@workspace/agent-patterns/prompts";
import {
  createRestrictedTaskTool,
  type ToolDefinitionWithExecute,
} from "./task-tool.js";

// =============================================================================
// Types and Interfaces
// =============================================================================

/**
 * Agent configuration passed at spawn time via inviteAgent().
 */
interface AgentConfig {
  contextId: string;
  model?: string;
  maxThinkingTokens?: number;
  executionMode?: "plan" | "edit";
  autonomyLevel?: number;
  workingDirectory?: string;
  restrictedMode: boolean;
}

/**
 * Runtime-adjustable settings (user preferences).
 */
interface ClaudeCodeSettings {
  model?: string;
  maxThinkingTokens?: number;
  executionMode?: "plan" | "edit";
  autonomyLevel?: number;
  hasShownApprovalPrompt?: boolean;
  [key: string]: string | number | boolean | undefined;
}

const DEFAULT_SETTINGS: ClaudeCodeSettings = {
  // Use the newest opus model from fallbacks, or fall back to first in list
  model: findNewestInFamily(CLAUDE_MODEL_FALLBACKS, "opus") ?? CLAUDE_MODEL_FALLBACKS[0]?.value,
  maxThinkingTokens: 10240,
  executionMode: "edit",
  autonomyLevel: 0,
  hasShownApprovalPrompt: false,
};

/**
 * Agent state (persisted by runtime).
 * Keep minimal - SDK session ID is the primary persisted state.
 */
interface ClaudeCodeState {
  sdkSessionId?: string;
  [key: string]: unknown;
}

/** Type for SDK's AskUserQuestion question structure */
interface AskUserQuestionQuestion {
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  multiSelect: boolean;
}

// =============================================================================
// Bounded Image Cache - LRU eviction with count and memory limits
// =============================================================================

const MAX_HISTORICAL_IMAGES = 20;
const MAX_IMAGE_MEMORY_BYTES = 100 * 1024 * 1024;

class BoundedImageCache {
  private cache = new Map<string, Attachment>();
  private accessOrder: string[] = [];
  private totalBytes = 0;

  constructor(
    private maxCount: number = MAX_HISTORICAL_IMAGES,
    private maxBytes: number = MAX_IMAGE_MEMORY_BYTES
  ) {}

  set(id: string, attachment: Attachment): void {
    if (this.cache.has(id)) {
      const existing = this.cache.get(id)!;
      this.totalBytes -= existing.data.length;
      this.accessOrder = this.accessOrder.filter((i) => i !== id);
    }

    if (attachment.data.length > this.maxBytes) return;

    while (
      this.accessOrder.length > 0 &&
      (this.cache.size >= this.maxCount ||
        this.totalBytes + attachment.data.length > this.maxBytes)
    ) {
      const oldestId = this.accessOrder.shift()!;
      const oldest = this.cache.get(oldestId);
      if (oldest) {
        this.totalBytes -= oldest.data.length;
        this.cache.delete(oldestId);
      }
    }

    this.cache.set(id, attachment);
    this.accessOrder.push(id);
    this.totalBytes += attachment.data.length;
  }

  get(id: string): Attachment | undefined {
    const attachment = this.cache.get(id);
    if (attachment) {
      this.accessOrder = this.accessOrder.filter((i) => i !== id);
      this.accessOrder.push(id);
    }
    return attachment;
  }

  has(id: string): boolean {
    return this.cache.has(id);
  }

  entries(): IterableIterator<[string, Attachment]> {
    return this.cache.entries();
  }

  get size(): number {
    return this.cache.size;
  }

  get bytes(): number {
    return this.totalBytes;
  }
}

// =============================================================================
// Utility Functions
// =============================================================================

function findExecutable(name: string): string | undefined {
  const isWindows = process.platform === "win32";
  const command = isWindows ? `where ${name}` : `which ${name}`;

  try {
    const result = execSync(command, { encoding: "utf-8" }).trim();
    const firstLine = result.split(/\r?\n/)[0];
    return firstLine || undefined;
  } catch {
    return undefined;
  }
}

async function findMostRecentPlanFile(): Promise<string | null> {
  const plansDir = join(homedir(), ".claude", "plans");
  try {
    const files = await readdir(plansDir);
    const mdFiles = files.filter((f: string) => f.endsWith(".md"));

    if (mdFiles.length === 0) return null;

    const fileStats = await Promise.all(
      mdFiles.map(async (f: string) => {
        const filePath = join(plansDir, f);
        const stats = await stat(filePath);
        return { path: filePath, mtime: stats.mtime };
      })
    );

    fileStats.sort((a, b) => new Date(b.mtime).getTime() - new Date(a.mtime).getTime());
    return fileStats[0]?.path ?? null;
  } catch {
    return null;
  }
}

function extractToolResultIds(message: unknown): string[] {
  const ids: string[] = [];
  if (!message || typeof message !== "object") return ids;

  const msgObj = message as { message?: { content?: unknown[] } };
  const content = msgObj.message?.content;
  if (!Array.isArray(content)) return ids;

  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      "type" in block &&
      block.type === "tool_result" &&
      "tool_use_id" in block &&
      typeof block.tool_use_id === "string"
    ) {
      ids.push(block.tool_use_id);
    }
  }
  return ids;
}

// =============================================================================
// Claude Code Responder Agent
// =============================================================================

/** Queued message with per-message typing tracker */
interface ClaudeCodeQueuedMessage {
  event: IncomingNewMessage;
  typingTracker: ReturnType<typeof createTypingTracker>;
}

class ClaudeCodeResponder extends Agent<ClaudeCodeState> {
  state: ClaudeCodeState = {};

  // Pattern helpers
  private queue!: MessageQueue<IncomingNewMessage>;
  private interrupt!: InterruptController;
  private settingsMgr!: SettingsManager<ClaudeCodeSettings>;
  private missedContext!: MissedContextManager;
  private contextTracker!: ReturnType<typeof createContextTracker>;

  // Per-message typing trackers for queue position display
  private queuedMessages = new Map<string, ClaudeCodeQueuedMessage>();

  // Agent-specific state
  private claudeExecutable!: string;
  private subagents!: SubagentManager;
  private activeQueryInstance: Query | null = null;
  private pendingRecoveryContext: string | null = null;
  private restrictedModeValidated = false;

  getConnectOptions() {
    // Note: this.ctx is NOT available here - use this.initInfo instead
    const config = this.initInfo.config as unknown as AgentConfig;

    return {
      name: "Claude Code",
      type: "claude-code" as const,
      contextId: config.contextId,
      extraMetadata: {
        agentTypeId: this.initInfo.agentId,
        executionMode: config.executionMode,
      },
      reconnect: true,
      replaySinceId: this.lastCheckpoint,
      // Note: these closures capture `this`, and this.ctx WILL be available when they execute
      methods: {
        pause: createPauseMethodDefinition(async () => {
          // Pause event triggers interrupt handler
        }),
        settings: {
          description: "Configure Claude Code settings",
          parameters: z.object({}),
          menu: true,
          execute: async () => this.handleSettingsMenu(),
        },
        set_title: {
          description: `Set the channel/conversation title displayed to users.`,
          parameters: z.object({
            title: z.string().max(200).describe("Brief title for this conversation"),
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

  getEventsOptions() {
    return {
      targetedOnly: true,
      respondWhenSolo: true,
    };
  }

  async onWake(): Promise<void> {
    const config = this.config as unknown as AgentConfig;

    // Find claude executable
    const claudeExecutable = findExecutable("claude");
    if (!claudeExecutable) {
      throw new Error("Claude Code CLI not found in PATH");
    }
    this.claudeExecutable = claudeExecutable;
    this.log.info(`Claude executable: ${claudeExecutable}`);

    // Initialize settings manager
    this.settingsMgr = createSettingsManager<ClaudeCodeSettings>({
      client: this.client as AgenticClient<ChatParticipantMetadata>,
      defaults: DEFAULT_SETTINGS,
      initConfig: {
        model: config.model,
        maxThinkingTokens: config.maxThinkingTokens,
        executionMode: config.executionMode,
        autonomyLevel: config.autonomyLevel,
      },
    });
    await this.settingsMgr.load();

    // Initialize interrupt controller
    this.interrupt = createInterruptController();

    // Initialize message queue with queue position tracking
    this.queue = createMessageQueue<IncomingNewMessage>({
      onProcess: (event) => this.handleUserMessage(event),
      onError: (err, event) => {
        this.log.error("Event processing failed", err, { eventId: event.id });
      },
      onDequeue: async (event) => {
        // Update queue positions for all waiting messages
        const msgEvent = event;

        // Remove the dequeued message from our tracking map
        this.queuedMessages.delete(msgEvent.id);

        // Update remaining messages' positions (0 = next in line)
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
      // Heartbeat to prevent inactivity timeout during long operations
      onHeartbeat: async () => {
        try {
          await this.client.publish("agent-heartbeat", { agentId: this.agentId }, { persist: false });
        } catch (err) {
          this.log.warn("Heartbeat failed", err);
        }
      },
    });

    // Wire interrupt controller to queue
    this.interrupt.onPause(() => this.queue.pause());
    this.interrupt.onResume(() => this.queue.resume());

    // Initialize missed context manager
    // sinceId skips events already in the AI thread history (prevents regurgitation on reconnect)
    // excludeSenderTypes filters out the agent's own responses (already in thread history)
    this.missedContext = createMissedContextManager({
      client: this.client as AgenticClient<ChatParticipantMetadata>,
      maxChars: DEFAULT_MISSED_CONTEXT_MAX_CHARS,
      sinceId: this.lastCheckpoint,
      excludeSenderTypes: ["claude-code"],
    });

    this.client.onReconnect(() => {
      this.missedContext.rebuild();
    });

    // Initialize context tracker
    const currentSettings = this.settingsMgr.get();
    this.contextTracker = createContextTracker({
      model: currentSettings.model,
      log: (msg) => this.log.debug(msg),
      onUpdate: async (usage: ContextWindowUsage) => {
        const currentMetadata = this.client.clientId
          ? this.client.roster[this.client.clientId]?.metadata
          : undefined;

        const metadata: ChatParticipantMetadata = {
          name: "Claude Code",
          handle: this.handle,
          agentTypeId: this.agentId,
          ...currentMetadata,
          type: "claude-code" as const,
          contextUsage: usage,
          executionMode: this.settingsMgr.get().executionMode,
        };

        try {
          await this.client.updateMetadata(metadata);
        } catch (err) {
          this.log.error("Failed to update context usage metadata", err);
        }
      },
    });

    // Initialize subagent manager
    this.subagents = new SubagentManager({
      serverUrl: this.ctx.pubsubUrl,
      token: this.ctx.pubsubToken,
      channel: this.channel,
      parentClient: this.client as AgenticClient<ChatParticipantMetadata>,
      log: (msg) => this.log.debug(msg),
    });

    // Session recovery
    if (this.state.sdkSessionId && config.workingDirectory && !config.restrictedMode) {
      await this.performSessionRecovery(this.state.sdkSessionId, config.workingDirectory);
    }

    this.log.info("ClaudeCodeResponder started", {
      channel: this.channel,
      handle: this.handle,
      restrictedMode: config.restrictedMode,
      workingDirectory: config.workingDirectory,
      settings: this.settingsMgr.get(),
    });
  }

  async onEvent(event: EventStreamItem): Promise<void> {
    if (event.type !== "message") return;

    const msgEvent = event as IncomingNewMessage;

    // Skip replay messages
    if ("kind" in event && event.kind === "replay") return;

    // Skip typing indicators
    const contentType = (event as { contentType?: string }).contentType;
    if (contentType === CONTENT_TYPE_TYPING) return;

    const sender = this.client.roster[event.senderId];
    if (sender?.metadata.type !== "panel") return;
    if (event.senderId === this.client.clientId) return;

    // Create per-message typing tracker for queue position display
    const typingTracker = createTypingTracker({
      client: this.client as AgenticClient<ChatParticipantMetadata>,
      replyTo: msgEvent.id,
      senderInfo: {
        senderId: this.client.clientId ?? "",
        senderName: "Claude Code",
        senderType: "claude-code",
      },
      log: (msg) => this.log.debug(msg),
    });

    // Show queue position in typing indicator
    const positionText = createQueuePositionText({
      queueLength: this.queuedMessages.size,
      isProcessing: this.queue.isProcessing(),
    });
    await typingTracker.startTyping(positionText);

    // Store the queued message with its typing tracker
    this.queuedMessages.set(msgEvent.id, { event: msgEvent, typingTracker });

    // Enqueue for ordered processing - cleanup if queue is stopped
    const enqueued = this.queue.enqueue(msgEvent);
    if (!enqueued) {
      await typingTracker.cleanup();
      this.queuedMessages.delete(msgEvent.id);
    }
  }

  async onSleep(): Promise<void> {
    this.queue.stop();
    await this.queue.drain();
    this.interrupt.cleanup();
    await this.subagents?.cleanupAll();

    await cleanupQueuedTypingTrackers(this.queuedMessages, (msg) => this.log.warn(msg));

    this.log.info("ClaudeCodeResponder shutting down");
  }

  private async performSessionRecovery(sdkSessionId: string, workingDirectory: string): Promise<void> {
    const client = this.client as AgenticClient<ChatParticipantMetadata>;

    this.log.info(`Performing session recovery for SDK session: ${sdkSessionId}`);

    try {
      const recoveryResult = await recoverSession({
        sdkSessionId,
        workingDirectory,
        sendMessage: async (content: string, metadata: Record<string, unknown>) => {
          await client.send(content, { metadata, persist: true } as Parameters<typeof client.send>[1]);
        },
        getPubsubMessages: () => {
          return client.getMessagesWithMetadata().map((msg) => ({
            id: msg.id,
            pubsubId: msg.pubsubId,
            content: msg.content,
            senderId: msg.senderId,
            senderType: msg.senderType,
            timestamp: msg.ts,
            contentType: msg.contentType,
            metadata: msg.metadata as PubsubMessageWithMetadata["metadata"],
          }));
        },
        log: (msg: string) => this.log.debug(msg),
      });

      if (recoveryResult.recovered) {
        this.log.info(`Session recovery complete: ${recoveryResult.messagesPostedToPubsub} messages posted, ${recoveryResult.contextForSdk.length} messages for SDK context`);

        if (recoveryResult.contextForSdk.length > 1) {
          const panel = findPanelParticipant(client);

          if (panel) {
            const uiCode = generateRecoveryReviewUI(
              recoveryResult.contextForSdk,
              recoveryResult.formattedContextForSdk
            );

            try {
              const feedbackHandle = client.callMethod(panel.id, "feedback_custom", { code: uiCode });
              const result = await feedbackHandle.result;

              if (result && typeof result === "object" && "context" in result) {
                const userContext = (result as { context: string }).context;
                if (userContext) {
                  this.pendingRecoveryContext = userContext;
                }
              } else {
                this.pendingRecoveryContext = recoveryResult.formattedContextForSdk;
              }
            } catch {
              this.pendingRecoveryContext = recoveryResult.formattedContextForSdk;
            }
          } else {
            this.pendingRecoveryContext = recoveryResult.formattedContextForSdk;
          }
        } else if (recoveryResult.formattedContextForSdk) {
          this.pendingRecoveryContext = recoveryResult.formattedContextForSdk;
        }
      }
    } catch (err) {
      this.log.error("Session recovery failed", err);
    }
  }

  private async handleSettingsMenu(): Promise<{ success: boolean; settings?: ClaudeCodeSettings; cancelled?: boolean; error?: string }> {
    const client = this.client as AgenticClient<ChatParticipantMetadata>;
    const panel = findPanelParticipant(client);

    if (!panel) {
      return { success: false, error: "No panel found" };
    }

    let modelOptions: Array<{ value: string; label: string }> = [];
    try {
      if (this.activeQueryInstance) {
        const sdkModels = await this.activeQueryInstance.supportedModels();
        modelOptions = sdkModels.map((m) => ({ value: m.value, label: m.displayName }));
      }
    } catch (err) {
      this.log.warn(`Failed to fetch models: ${err}`);
    }

    if (modelOptions.length === 0) {
      modelOptions = CLAUDE_MODEL_FALLBACKS;
    }

    // Determine the recommended default from available models
    const recommendedModel = findNewestInFamily(modelOptions, "opus") ?? getRecommendedDefault(modelOptions);

    const fields = CLAUDE_CODE_PARAMETERS
      .filter((p) => !p.channelLevel)
      .map((f) => {
        if (f.key === "model" && modelOptions.length > 0) {
          // Update both options and default to use dynamically fetched models
          return {
            ...f,
            options: modelOptions,
            default: recommendedModel ?? f.default,
          };
        }
        return f;
      });

    const callHandle = client.callMethod(panel.id, "feedback_form", {
      title: "Claude Code Settings",
      fields,
      values: this.settingsMgr.get(),
    });

    const result = await callHandle.result;
    const feedbackResult = result.content as { type: string; value?: unknown; message?: string };

    if (feedbackResult.type === "cancel") {
      return { success: false, cancelled: true };
    }

    if (feedbackResult.type === "error") {
      return { success: false, error: feedbackResult.message };
    }

    const newSettings = feedbackResult.value as Partial<ClaudeCodeSettings>;
    await this.settingsMgr.update(newSettings);

    if (newSettings.model) {
      this.contextTracker.setModel(newSettings.model);
    }

    // Update metadata
    const currentMetadata = client.clientId
      ? client.roster[client.clientId]?.metadata
      : undefined;
    const metadata: ChatParticipantMetadata = {
      name: "Claude Code",
      type: "claude-code",
      handle: this.handle,
      ...currentMetadata,
      executionMode: this.settingsMgr.get().executionMode,
    };
    try {
      await client.updateMetadata(metadata);
    } catch (err) {
      this.log.warn("Failed to update metadata after settings change", err);
    }

    return { success: true, settings: this.settingsMgr.get() };
  }

  private async handleUserMessage(incoming: IncomingNewMessage): Promise<void> {
    const config = this.config as unknown as AgentConfig;
    const client = this.client as AgenticClient<ChatParticipantMetadata>;
    const settings = this.settingsMgr.get();

    this.log.info(`Received message: ${incoming.content}`);

    // Stop the per-message queue position typing indicator (it's no longer in queue)
    const queuedInfo = this.queuedMessages.get(incoming.id);
    if (queuedInfo) {
      await queuedInfo.typingTracker.cleanup();
      this.queuedMessages.delete(incoming.id);
    }

    // Validate restricted mode on first message
    if (config.restrictedMode && !this.restrictedModeValidated) {
      await validateRestrictedMode(client, (msg) => this.log.debug(msg));
      this.restrictedModeValidated = true;
    }

    // Build prompt with missed and recovery context
    let prompt = String(incoming.content);
    const missedCtx = this.missedContext.consume();
    if (missedCtx) {
      prompt = `<missed_context>\n${missedCtx}\n</missed_context>\n\n${prompt}`;
    }
    if (this.pendingRecoveryContext) {
      prompt = `${this.pendingRecoveryContext}\n\n${prompt}`;
      this.pendingRecoveryContext = null;
    }

    // Collect image attachments
    const allImageAttachments = new BoundedImageCache();
    for (const msg of client.missedMessages) {
      const msgAttachments = (msg as { attachments?: Attachment[] }).attachments;
      if (msgAttachments) {
        for (const a of filterImageAttachments(msgAttachments)) {
          allImageAttachments.set(a.id, a);
        }
      }
    }

    const attachments = (incoming as { attachments?: Attachment[] }).attachments;
    const currentImageAttachments = filterImageAttachments(attachments);
    for (const a of currentImageAttachments) {
      allImageAttachments.set(a.id, a);
    }

    if (currentImageAttachments.length > 0) {
      const validation = validateAttachments(currentImageAttachments);
      if (!validation.valid) {
        this.log.warn(`Attachment validation failed: ${validation.error}`);
      }
    }

    // Find panel for tool approval
    const panel = findPanelParticipant(client);

    // Create trackers
    const typing = createTypingTracker({
      client,
      log: (msg) => this.log.debug(msg),
      replyTo: incoming.id,
      senderInfo: {
        senderId: client.clientId ?? "",
        senderName: "Claude Code",
        senderType: "claude-code",
      },
    });

    await typing.startTyping("preparing response");

    const thinking = createThinkingTracker({
      client,
      log: (msg) => this.log.debug(msg),
      replyTo: incoming.id,
    });

    const action = createActionTracker({
      client,
      log: (msg) => this.log.debug(msg),
      replyTo: incoming.id,
    });

    // Set up interrupt handler
    let queryInstance: Query | null = null;
    const interruptHandler = createInterruptHandler({
      client,
      messageId: incoming.id,
      onPause: async (reason) => {
        this.log.info(`Pause RPC received: ${reason}`);
        if (queryInstance) {
          try {
            await queryInstance.interrupt();
          } catch (err) {
            this.log.warn("SDK query interrupt failed", err);
          }
        }
      },
    });

    let responseId: string | null = null;
    let capturedSessionId: string | undefined;

    // Reply anchoring: tracks which message responses are anchored to.
    // Updated on interleave to point to the last interleaved user message.
    let replyToId = incoming.id;

    const ensureResponseMessage = async (sdkUuid?: string, sdkSessionId?: string): Promise<string> => {
      if (typing.isTyping()) {
        await typing.stopTyping();
      }
      if (!responseId) {
        const metadata: Record<string, unknown> | undefined =
          sdkUuid || sdkSessionId ? { sdkUuid, sdkSessionId } : undefined;
        const { messageId } = await client.send("", { replyTo: replyToId, metadata } as Parameters<typeof client.send>[1]);
        responseId = messageId;
      }
      return responseId;
    };

    const stopTypingIfNeeded = async () => {
      if (typing.isTyping()) {
        await typing.stopTyping();
      }
    };

    try {
      void interruptHandler.monitor();

      // Build MCP servers
      let pubsubServer: ReturnType<typeof createSdkMcpServer> | undefined;
      let allowedTools: string[] = [];

      // Channel tools server
      const setTitleTool = tool(
        "set_title",
        `Set the channel/conversation title displayed to users.`,
        { title: z.string().max(200).describe("Brief title for this conversation") },
        async ({ title }: { title: string }) => {
          await client.setChannelTitle(title);
          return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, title }) }] };
        }
      );

      const channelToolsServer = createSdkMcpServer({
        name: "channel",
        version: "1.0.0",
        tools: [setTitleTool],
      });

      if (config.restrictedMode) {
        allowedTools.push("mcp__channel__set_title");
      }

      // Attachments MCP server
      let attachmentsMcpServer: ReturnType<typeof createSdkMcpServer> | undefined;
      if (allImageAttachments.size > 0) {
        const listImagesTool = tool(
          "list_images",
          "List all available images in the conversation.",
          {},
          async () => {
            const imageList = Array.from(allImageAttachments.entries()).map(([id, a]) => ({
              id,
              mimeType: a.mimeType,
              name: a.name,
              size: a.data.length,
            }));
            return { content: [{ type: "text" as const, text: JSON.stringify({ images: imageList }) }] };
          }
        );

        const getImageTool = tool(
          "get_image",
          "View a specific image by its ID.",
          { image_id: z.string().describe("The image ID") },
          async ({ image_id }: { image_id: string }) => {
            const attachment = allImageAttachments.get(image_id);
            if (!attachment) {
              return { content: [{ type: "text" as const, text: `Error: Image "${image_id}" not found.` }] };
            }
            return { content: [{ type: "image" as const, data: uint8ArrayToBase64(attachment.data), mimeType: attachment.mimeType }] };
          }
        );

        const getCurrentImagesTool = tool(
          "get_current_images",
          "View all images attached to the current message.",
          {},
          async () => {
            if (currentImageAttachments.length === 0) {
              return { content: [{ type: "text" as const, text: "No images attached to current message." }] };
            }
            return {
              content: currentImageAttachments.map((a: Attachment) => ({
                type: "image" as const,
                data: uint8ArrayToBase64(a.data),
                mimeType: a.mimeType,
              })),
            };
          }
        );

        attachmentsMcpServer = createSdkMcpServer({
          name: "attachments",
          version: "1.0.0",
          tools: [listImagesTool, getImageTool, getCurrentImagesTool],
        });

        if (config.restrictedMode) {
          allowedTools.push("mcp__attachments__list_images", "mcp__attachments__get_image", "mcp__attachments__get_current_images");
        }
      }

      // Build prompt with image note
      const promptWithImageNote = currentImageAttachments.length > 0
        ? `${prompt}\n\n[${currentImageAttachments.length} image(s) attached. Call get_current_images to view.]`
        : allImageAttachments.size > 0
          ? `${prompt}\n\n[${allImageAttachments.size} historical image(s) available. Call list_images to see them.]`
          : prompt;

      let pubsubRegistry: Awaited<ReturnType<typeof discoverPubsubToolsForMode>> | undefined;

      // Resume session
      const resumeSessionId = client.sdkSessionId || this.state.sdkSessionId;
      if (resumeSessionId) {
        this.log.debug(`Resuming session: ${resumeSessionId}`);
      }

      if (config.restrictedMode) {
        // Wait for tools and build registry
        const registry = await discoverPubsubToolsForMode(client, {
          mode: "restricted",
          log: (msg) => this.log.debug(msg),
        });
        pubsubRegistry = registry;
        this.log.info(`Discovered ${registry.tools.length} tools for restricted mode`);
        if (registry.tools.length > 0) {
          const toolNames = registry.tools.map((t) => `${t.providerId}:${t.methodName}`);
          this.log.info(`Restricted mode tools: ${toolNames.join(", ")}`);
        }

        // Build Claude SDK MCP tools via adapter
        const { toolDefs: claudeToolDefs, allowedTools: registryAllowedTools, execute: registryExecute } = toClaudeMcpTools(registry, client);

        // Build ToolDefinitionWithExecute[] for the Task tool (needs wire names)
        const toolDefsWithExecute: ToolDefinitionWithExecute[] = registry.tools.map((t) => ({
          name: t.wireName,
          description: t.description,
          inputSchema: t.parameters,
          execute: async (args: unknown) => registryExecute(t.canonicalName, args),
        }));

        const restrictedTaskTool = createRestrictedTaskTool({
          parentClient: client,
          availableTools: toolDefsWithExecute,
          claudeExecutable: this.claudeExecutable,
          connectionOptions: this.subagents.getConnectionOptionsForExternalUse(),
          parentSettings: { maxThinkingTokens: settings.maxThinkingTokens },
        });

        // Create MCP tools from registry adapter output
        const mcpTools = claudeToolDefs.map((t) =>
          tool(
            t.name,
            t.description,
            jsonSchemaToZodRawShape(t.parameters),
            t.execute
          )
        );

        // Add Task tool
        const taskMcpTool = tool(
          "Task",
          restrictedTaskTool.description,
          restrictedTaskTool.inputSchema.shape,
          async (args: unknown) => {
            const result = await restrictedTaskTool.execute(args as Parameters<typeof restrictedTaskTool.execute>[0]);
            return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
          }
        );
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mcpTools.push(taskMcpTool as any);

        pubsubServer = createSdkMcpServer({
          name: "workspace",
          version: "1.0.0",
          tools: mcpTools,
        });

        allowedTools = [
          ...registryAllowedTools,
          "mcp__workspace__Task",
          "TodoWrite",
        ];
      } else {
        pubsubRegistry = await discoverPubsubToolsForMode(client, {
          mode: "unrestricted",
          timeoutMs: 1500,
          log: (msg) => this.log.debug(msg),
        });

        if (pubsubRegistry.tools.length > 0) {
          this.log.info(`Discovered ${pubsubRegistry.tools.length} unrestricted pubsub tools`);
          const toolNames = pubsubRegistry.tools.map((t) => `${t.providerId}:${t.methodName}`);
          this.log.info(`Unrestricted pubsub tools: ${toolNames.join(", ")}`);

          const { toolDefs: claudeToolDefs } = toClaudeMcpTools(pubsubRegistry, client);
          const mcpTools = claudeToolDefs.map((t) =>
            tool(
              t.name,
              t.description,
              jsonSchemaToZodRawShape(t.parameters),
              t.execute
            )
          );

          pubsubServer = createSdkMcpServer({
            name: "workspace",
            version: "1.0.0",
            tools: mcpTools,
          });
        } else {
          this.log.info("No unrestricted pubsub tools available");
        }
      }

      // Create approval gate for pubsub tools
      // Uses getters so approval level changes propagate immediately
      const approvalGate = createCanUseToolGate({
        byCanonical: pubsubRegistry?.byCanonical ?? new Map(),
        getApprovalLevel: () => this.settingsMgr.get().autonomyLevel ?? 0,
        hasShownApprovalPrompt: !!settings.hasShownApprovalPrompt,
        showPermissionPrompt: async (_tool, input) => {
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

      // Create permission handler
      const canUseTool: CanUseTool = async (toolName, input, options) => {
        const result = await this.handleToolPermission(toolName, input, options, client, panel, settings, interruptHandler, approvalGate);
        // Type assertion needed due to discriminated union narrowing
        return result as Awaited<ReturnType<CanUseTool>>;
      };

      const queryOptions: Parameters<typeof query>[0]["options"] = {
        ...(() => {
          const servers: Record<string, ReturnType<typeof createSdkMcpServer>> = {};
          if (pubsubServer) {
            servers['workspace'] = pubsubServer;
          }
          servers['channel'] = channelToolsServer;
          if (attachmentsMcpServer) {
            servers['attachments'] = attachmentsMcpServer;
          }
          return { mcpServers: servers };
        })(),
        systemPrompt: config.restrictedMode
          ? createRestrictedModeSystemPrompt()
          : createRichTextChatSystemPrompt(),
        pathToClaudeCodeExecutable: this.claudeExecutable,
        ...(allowedTools.length > 0 && { allowedTools }),
        disallowedTools: config.restrictedMode
          ? ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "Task", "NotebookEdit"]
          : [],
        ...(!config.restrictedMode && config.workingDirectory && { cwd: config.workingDirectory }),
        includePartialMessages: true,
        ...(resumeSessionId && { resume: resumeSessionId }),
        ...(settings.model && { model: settings.model }),
        ...(settings.maxThinkingTokens && { maxThinkingTokens: settings.maxThinkingTokens }),
        ...(settings.executionMode && { executionMode: settings.executionMode }),
        canUseTool,
      };

      queryInstance = query({
        prompt: promptWithImageNote,
        options: queryOptions,
      });
      this.activeQueryInstance = queryInstance;

      let currentSdkMessageUuid: string | undefined;
      let currentSdkSessionId: string | undefined;
      let sawStreamedText = false;
      let currentStreamingToolId: string | null = null;
      let interleavePrompt: string | null = null;
      let needsResume = false;

      const toolInputAccumulators = new Map<string, {
        toolName: string;
        inputChunks: string[];
      }>();

      outer: while (true) {
        if (interleavePrompt || needsResume) {
          if (interleavePrompt) {
            // Complete current response before starting new query
            if (responseId) {
              await client.complete(responseId);
              responseId = null;
            }
            // Update reply anchoring for trackers
            typing.setReplyTo(replyToId);
            thinking.setReplyTo(replyToId);
            action.setReplyTo(replyToId);
          }
          // Resume query (with interleaved content, or empty to continue)
          queryInstance = query({
            prompt: interleavePrompt || "",
            options: { ...queryOptions, resume: capturedSessionId },
          });
          this.activeQueryInstance = queryInstance;
          // Reset per-query state
          sawStreamedText = false;
          toolInputAccumulators.clear();
          currentStreamingToolId = null;
          interleavePrompt = null;
          needsResume = false;
        }

        for await (const message of queryInstance) {
          const sdkMsg = message as { uuid?: string; session_id?: string };
          if (sdkMsg.uuid) currentSdkMessageUuid = sdkMsg.uuid;
          if (sdkMsg.session_id) {
            currentSdkSessionId = sdkMsg.session_id;
            capturedSessionId = sdkMsg.session_id;
          }

          if (interruptHandler.isPaused()) {
            this.log.info("Execution paused, breaking out of query loop");
            break;
          }

          // Subagent event routing
          const sdkMessage = message as { parent_tool_use_id?: string | null; type: string; event?: SDKStreamEvent };
          if (sdkMessage.parent_tool_use_id && sdkMessage.type === "stream_event" && sdkMessage.event) {
            await this.subagents.routeEvent(sdkMessage.parent_tool_use_id, sdkMessage.event);
            continue;
          }

          if (sdkMessage.type === "user") {
            const toolResultIds = extractToolResultIds(message);
            for (const toolUseId of toolResultIds) {
              if (this.subagents.has(toolUseId)) {
                await this.subagents.cleanup(toolUseId, "complete");
              }
            }
          }

          if (message.type === "stream_event") {
            const streamEvent = message.event as {
              type: string;
              delta?: { type: string; text?: string; thinking?: string; partial_json?: string };
              content_block?: { type?: string; id?: string; name?: string };
            };

            if (streamEvent.type === "message_start") {
              // Check for pending user messages at the start of a new model turn
              if (!interruptHandler.isPaused() && this.queue.getPendingCount() > 0 && capturedSessionId) {
                let interrupted = false;
                try {
                  await queryInstance.interrupt();
                  interrupted = true;
                } catch (err) {
                  this.log.warn("Interrupt for interleave failed, continuing current query", err);
                }

                if (interrupted) {
                  const { pending, lastMessageId } = await drainForInterleave(
                    this.queue.takePending(),
                    this.queuedMessages,
                  );
                  if (pending.length === 0) {
                    this.log.warn("Pending drained between check and take, resuming interrupted query");
                    needsResume = true;
                    break; // exits for-await, re-enters outer while
                  } else {
                    // Update replyTo to last interleaved message
                    replyToId = lastMessageId!;
                    // Collect attachments from ALL pending messages into shared image cache
                    const prevImageCount = allImageAttachments.size;
                    for (const p of pending) {
                      for (const a of filterImageAttachments((p as { attachments?: Attachment[] }).attachments)) {
                        allImageAttachments.set(a.id, a);
                      }
                    }
                    // Build interleave prompt
                    const texts = pending.map((p) => String(p.content));
                    interleavePrompt = texts.join("\n\n");
                    if (allImageAttachments.size > prevImageCount) {
                      interleavePrompt += `\n\n[${allImageAttachments.size} image(s) available. Call list_images to see them.]`;
                    }
                    this.log.info(`Interleaved ${pending.length} user message(s) at message_start`);
                    break; // exits for-await, re-enters outer while
                  }
                }
                // If !interrupted, fall through to normal message_start handling
              }
              // Normal message_start handling
              if (responseId) {
                await client.complete(responseId);
                responseId = null;
              }
              sawStreamedText = false;
            }

            if (streamEvent.type === "content_block_start" && streamEvent.content_block) {
              const blockType = streamEvent.content_block.type;
              if (blockType === "thinking") {
                await stopTypingIfNeeded();
                if (action.isActive()) await action.completeAction();
                await thinking.startThinking();
              } else if (blockType === "tool_use") {
                await stopTypingIfNeeded();
                if (thinking.isThinking()) await thinking.endThinking();

                const toolBlock = streamEvent.content_block as { type: "tool_use"; id: string; name: string };
                toolInputAccumulators.set(toolBlock.id, { toolName: toolBlock.name, inputChunks: [] });
                currentStreamingToolId = toolBlock.id;
              } else if (blockType === "text") {
                await stopTypingIfNeeded();
                if (thinking.isThinking()) await thinking.endThinking();
                if (action.isActive()) await action.completeAction();
                thinking.setTextMode();
              }
            }

            if (streamEvent.type === "content_block_delta" && streamEvent.delta?.type === "thinking_delta") {
              if (streamEvent.delta.thinking) {
                await thinking.updateThinking(streamEvent.delta.thinking);
              }
            }

            if (streamEvent.type === "content_block_delta" && streamEvent.delta?.type === "text_delta") {
              if (streamEvent.delta.text) {
                const msgId = await ensureResponseMessage(currentSdkMessageUuid, currentSdkSessionId);
                await client.update(msgId, streamEvent.delta.text);
                sawStreamedText = true;
              }
            }

            if (streamEvent.type === "content_block_delta" && streamEvent.delta?.type === "input_json_delta") {
              if (streamEvent.delta.partial_json && currentStreamingToolId) {
                const acc = toolInputAccumulators.get(currentStreamingToolId);
                if (acc) acc.inputChunks.push(streamEvent.delta.partial_json);
              }
            }

            if (streamEvent.type === "content_block_stop") {
              if (thinking.isThinking()) await thinking.endThinking();

              if (currentStreamingToolId) {
                const toolId = currentStreamingToolId;
                const acc = toolInputAccumulators.get(toolId);
                currentStreamingToolId = null;

                if (acc) {
                  const prettifiedToolName = prettifyToolName(acc.toolName);
                  let description = getDetailedActionDescription(acc.toolName, {});

                  if (acc.inputChunks.length > 0) {
                    try {
                      const fullInput = acc.inputChunks.join("");
                      const parsedInput = JSON.parse(fullInput) as Record<string, unknown>;
                      description = getDetailedActionDescription(acc.toolName, parsedInput);

                      // TodoWrite handling
                      if (acc.toolName === "TodoWrite") {
                        const todoArgs = parsedInput as { todos?: Array<{ content: string; activeForm: string; status: string }> };
                        if (todoArgs.todos && todoArgs.todos.length > 0) {
                          const inlineData: InlineUiData = {
                            id: "agent-todos",
                            code: getCachedTodoListCode(),
                            props: { todos: todoArgs.todos },
                          };
                          await client.send(JSON.stringify(inlineData), {
                            contentType: CONTENT_TYPE_INLINE_UI,
                            persist: true,
                          });
                        }
                      }

                      // Subagent creation for unrestricted mode
                      if (acc.toolName === "Task" && !config.restrictedMode) {
                        const taskArgs = parsedInput as { description?: string; subagent_type?: string };
                        await this.subagents.create(toolId, {
                          taskDescription: taskArgs.description ?? "Subagent task",
                          subagentType: taskArgs.subagent_type,
                          parentToolUseId: toolId,
                        });
                      }
                    } catch {
                      // JSON parse failed — use fallback description
                    }
                  }

                  await action.startAction({
                    type: prettifiedToolName,
                    description,
                    toolUseId: toolId,
                  });
                  toolInputAccumulators.delete(toolId);
                }

                await action.completeAction();
                await typing.startTyping("processing tool result");
              }
            }
          } else if (message.type === "assistant") {
            if (!sawStreamedText) {
              const textBlocks = (message.message.content as Array<{ type: string; text?: string }>).filter(
                (block): block is { type: "text"; text: string } => block.type === "text"
              );
              if (textBlocks.length > 0) {
                const msgId = await ensureResponseMessage(currentSdkMessageUuid, currentSdkSessionId);
                for (const block of textBlocks) {
                  await client.update(msgId, block.text);
                }
              }
            }
            sawStreamedText = false;
          } else if (message.type === "result") {
            const resultMessage = message as SDKResultMessage;
            if (resultMessage.subtype === "success" && resultMessage.session_id) {
              capturedSessionId = resultMessage.session_id;
            }

            if (resultMessage.usage) {
              await this.contextTracker.recordUsage({
                inputTokens: resultMessage.usage['input_tokens'] ?? 0,
                outputTokens: resultMessage.usage['output_tokens'] ?? 0,
                costUsd: resultMessage.total_cost_usd,
              });
            }

            this.log.info(`Query completed. Cost: $${(message as { total_cost_usd?: number }).total_cost_usd?.toFixed(4) ?? "unknown"}`);
            break outer; // normal completion, exit both loops
          }
        }

        // If we broke out of for-await without setting interleavePrompt or needsResume,
        // it was a pause/interrupt — exit outer loop
        if (!interleavePrompt && !needsResume) break;
      }

      // Cleanup
      interruptHandler.cleanup();
      // Reset interrupt state so queue can process next message
      this.interrupt.resume();

      if (interruptHandler.isPaused()) {
        await typing.cleanup();
        await thinking.cleanup();
        await action.cleanup();
        await this.subagents.cleanupAll();
      }

      // Store session ID
      if (capturedSessionId) {
        this.setState({ sdkSessionId: capturedSessionId });
        if (client.sessionKey) {
          await client.updateSdkSession(capturedSessionId);
        }
      }

      // Complete response
      if (responseId) {
        await client.complete(responseId);
      } else {
        await typing.cleanup();
      }

      await this.contextTracker.endTurn();
    } catch (err) {
      // Persist session ID on error
      if (capturedSessionId) {
        this.setState({ sdkSessionId: capturedSessionId });
        if (client.sessionKey) {
          await client.updateSdkSession(capturedSessionId).catch((e) => {
            this.log.error("Failed to persist session ID on error", e);
          });
        }
      }

      await typing.cleanup();
      await thinking.cleanup();
      await action.cleanup();
      await this.contextTracker.cleanup();
      await this.subagents.cleanupAll();
      interruptHandler.cleanup();
      // Reset interrupt state so queue can process next message
      this.interrupt.resume();

      this.log.error("Claude query error", err);

      if (responseId) {
        await client.error(responseId, err instanceof Error ? err.message : String(err));
      } else {
        const { messageId: errorMsgId } = await client.send("", { replyTo: replyToId });
        await client.error(errorMsgId, err instanceof Error ? err.message : String(err));
      }

      throw err;
    }
  }

  private async handleToolPermission(
    toolName: string,
    input: unknown,
    options: { toolUseID: string; decisionReason?: string },
    client: AgenticClient<ChatParticipantMetadata>,
    panel: Participant<ChatParticipantMetadata> | undefined,
    settings: ClaudeCodeSettings,
    interruptHandler: ReturnType<typeof createInterruptHandler>,
    approvalGate: ReturnType<typeof createCanUseToolGate>
  ): Promise<{
    behavior: "allow" | "deny";
    message?: string;
    interrupt?: boolean;
    updatedInput?: unknown;
    toolUseID: string;
  }> {
    this.log.debug(`Permission requested for tool: ${toolName}`);

    // Handle AskUserQuestion specially
    if (toolName === "AskUserQuestion") {
      if (!panel) {
        return { behavior: "deny", message: "No panel available", toolUseID: options.toolUseID };
      }

      const questions = (input as { questions?: AskUserQuestionQuestion[] }).questions;
      if (!Array.isArray(questions) || questions.length === 0) {
        return { behavior: "deny", message: "Missing questions", toolUseID: options.toolUseID };
      }

      const fields: Array<{
        key: string;
        label?: string;
        description?: string;
        type: string;
        variant?: "buttons" | "cards" | "list";
        options?: Array<{ value: string; label: string; description?: string }>;
        visibleWhen?: { field: string; operator: string; value: string };
        placeholder?: string;
      }> = [];

      for (let i = 0; i < questions.length; i++) {
        const q = questions[i]!;
        const fieldId = String(i);
        if (!Array.isArray(q.options) || q.options.length === 0) {
          return { behavior: "deny", message: "Question missing options", toolUseID: options.toolUseID };
        }

        const fieldOptions = q.options.map((opt) => ({
          value: opt.label,
          label: opt.label,
          description: opt.description,
        }));

        if (fieldOptions.length < 4) {
          fieldOptions.push({ value: "__other__", label: "Other", description: "Provide a custom answer" });
        }

        if (q.multiSelect) {
          fields.push({
            key: fieldId,
            label: q.header,
            description: q.question,
            type: "multiSelect",
            variant: "cards",
            options: fieldOptions,
          });
        } else {
          fields.push({
            key: fieldId,
            label: q.header,
            description: q.question,
            type: "segmented",
            variant: "cards",
            options: fieldOptions,
          });
        }

        fields.push({
          key: `${fieldId}_other`,
          label: "Please specify",
          type: "string",
          placeholder: "Enter your answer...",
          visibleWhen: q.multiSelect
            ? { field: fieldId, operator: "contains", value: "__other__" }
            : { field: fieldId, operator: "eq", value: "__other__" },
        });
      }

      try {
        const formHandle = client.callMethod(panel.id, "feedback_form", {
          title: "Claude needs your input",
          fields,
          values: {},
        });
        const result = await formHandle.result;
        const feedbackResult = result.content as { type: string; value?: Record<string, unknown> };

        if (feedbackResult.type === "cancel") {
          return { behavior: "deny", message: "User cancelled", interrupt: true, toolUseID: options.toolUseID };
        }

        const formValues = feedbackResult.value as Record<string, string | string[]>;
        const answers: Record<string, string> = {};

        for (const [key, value] of Object.entries(formValues ?? {})) {
          if (key.endsWith("_other")) continue;
          const otherValue = formValues?.[`${key}_other`];

          if (Array.isArray(value)) {
            const processed = value.map((v) =>
              v === "__other__" ? (typeof otherValue === "string" && otherValue ? otherValue : "Other") : v
            );
            answers[key] = processed.join(", ");
          } else if (value === "__other__") {
            answers[key] = typeof otherValue === "string" && otherValue ? otherValue : "Other";
          } else {
            answers[key] = value;
          }
        }

        return { behavior: "allow", updatedInput: { ...(input as Record<string, unknown>), answers }, toolUseID: options.toolUseID };
      } catch (err) {
        if (err instanceof AgenticError && ["cancelled", "timeout", "provider-offline", "provider-not-found"].includes(err.code)) {
          return { behavior: "deny", message: err.message, toolUseID: options.toolUseID };
        }
        throw err;
      }
    }

    // Handle ExitPlanMode
    if (toolName === "ExitPlanMode") {
      let planFilePath = (input as Record<string, unknown>)['planFilePath'] as string | undefined;
      if (!planFilePath) {
        planFilePath = await findMostRecentPlanFile() ?? undefined;
      }

      let plan: string | undefined;
      if (planFilePath) {
        try {
          plan = await readFile(planFilePath, "utf-8");
        } catch {
          // Ignore
        }
      }
      input = { ...(input as Record<string, unknown>), plan, planFilePath };
    }

    // Interactive tools (ExitPlanMode, EnterPlanMode) always need user interaction
    const isInteractiveTool = ["AskUserQuestion", "ExitPlanMode", "EnterPlanMode"].includes(toolName);

    // For non-interactive tools, delegate to the approval gate
    if (!isInteractiveTool) {
      try {
        const gateResult = await approvalGate.canUseTool(toolName, input);
        if (gateResult.allow) {
          return { behavior: "allow", updatedInput: gateResult.updatedInput ?? input, toolUseID: options.toolUseID };
        } else {
          return { behavior: "deny", message: "User denied permission", interrupt: true, toolUseID: options.toolUseID };
        }
      } catch (err) {
        if (err instanceof AgenticError && ["cancelled", "timeout", "provider-offline", "provider-not-found"].includes(err.code)) {
          return { behavior: "deny", message: err.message, interrupt: true, toolUseID: options.toolUseID };
        }
        throw err;
      }
    }

    // Interactive tools: show permission prompt directly
    if (!panel) {
      return { behavior: "deny", message: "No panel available", interrupt: true, toolUseID: options.toolUseID };
    }

    const autonomyLevel = settings.autonomyLevel ?? 0;
    const isFirstTimeGrant = !settings.hasShownApprovalPrompt;

    try {
      const { allow, alwaysAllow } = await showPermissionPrompt(
        client,
        panel.id,
        toolName,
        input as Record<string, unknown>,
        {
          decisionReason: options.decisionReason,
          isFirstTimeGrant,
          floorLevel: autonomyLevel,
        }
      );

      if (!settings.hasShownApprovalPrompt) {
        await this.settingsMgr.update({ hasShownApprovalPrompt: true });
      }

      if (allow) {
        if (alwaysAllow) {
          await this.settingsMgr.update({ autonomyLevel: 2 });
        }
        return { behavior: "allow", updatedInput: input, toolUseID: options.toolUseID };
      } else {
        return { behavior: "deny", message: "User denied permission", interrupt: true, toolUseID: options.toolUseID };
      }
    } catch (err) {
      if (err instanceof AgenticError && ["cancelled", "timeout", "provider-offline", "provider-not-found"].includes(err.code)) {
        return { behavior: "deny", message: err.message, interrupt: true, toolUseID: options.toolUseID };
      }
      throw err;
    }
  }
}

runAgent(ClaudeCodeResponder);
