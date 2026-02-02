/**
 * Claude Code Responder Agent
 *
 * AI-powered code assistant using the Claude Agent SDK.
 * Migrated from workspace/workers/claude-code-responder to use:
 * - Agent base class from @natstack/agent-runtime
 * - Pattern helpers from @natstack/agent-patterns
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

import { Agent, runAgent } from "@natstack/agent-runtime";
import type { EventStreamItem } from "@natstack/agentic-messaging";
import {
  createToolsForAgentSDK,
  jsonSchemaToZodRawShape,
  formatArgsForLog,
  createInterruptHandler,
  createPauseMethodDefinition,
  createRichTextChatSystemPrompt,
  createRestrictedModeSystemPrompt,
  DEFAULT_MISSED_CONTEXT_MAX_CHARS,
  formatMissedContext,
  showPermissionPrompt,
  validateRestrictedMode,
  getCanonicalToolName,
  prettifyToolName,
  createThinkingTracker,
  createActionTracker,
  createTypingTracker,
  getDetailedActionDescription,
  needsApprovalForTool,
  CONTENT_TYPE_TYPING,
  CONTENT_TYPE_INLINE_UI,
  getCachedTodoListCode,
  filterImageAttachments,
  validateAttachments,
  uint8ArrayToBase64,
  SubagentManager,
  AgenticError,
  type InlineUiData,
  type ContextWindowUsage,
  type SDKStreamEvent,
  type AgenticClient,
  type AgentSDKToolDefinition,
  type ChatParticipantMetadata,
  type IncomingNewMessage,
} from "@natstack/agentic-messaging";
import type { Attachment, Participant } from "@natstack/pubsub";
import {
  recoverSession,
  generateRecoveryReviewUI,
  type PubsubMessageWithMetadata,
} from "@natstack/agentic-messaging/recovery";
import {
  CLAUDE_CODE_PARAMETERS,
  CLAUDE_MODEL_FALLBACKS,
} from "@natstack/agentic-messaging/config";
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
  type MessageQueue,
  type InterruptController,
  type SettingsManager,
  type MissedContextManager,
} from "@natstack/agent-patterns";
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
}

const DEFAULT_SETTINGS: ClaudeCodeSettings = {
  model: "claude-sonnet-4-5-20250929",
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

function getActionDescription(toolName: string): string {
  const descriptions: Record<string, string> = {
    Read: "Reading file",
    Write: "Writing file",
    Edit: "Editing file",
    Bash: "Running command",
    Glob: "Searching for files",
    Grep: "Searching file contents",
    WebSearch: "Searching the web",
    WebFetch: "Fetching web content",
    Task: "Delegating to subagent",
    TodoWrite: "Updating task list",
    AskUserQuestion: "Asking user",
    SetTitle: "Setting conversation title",
    ListImages: "Listing available images",
    GetImage: "Viewing image",
    GetCurrentImages: "Getting current images",
  };
  return descriptions[toolName] ?? `Using ${toolName}`;
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

class ClaudeCodeResponder extends Agent<ClaudeCodeState> {
  state: ClaudeCodeState = {};

  // Pattern helpers
  private queue!: MessageQueue;
  private interrupt!: InterruptController;
  private settings!: SettingsManager<ClaudeCodeSettings>;
  private missedContext!: MissedContextManager;
  private contextTracker!: ReturnType<typeof createContextTracker>;

  // Agent-specific state
  private claudeExecutable!: string;
  private subagents!: SubagentManager;
  private activeQueryInstance: Query | null = null;
  private pendingRecoveryContext: string | null = null;
  private restrictedModeValidated = false;

  getConnectOptions() {
    // Note: this.ctx is NOT available here - use this.initInfo instead
    const config = this.initInfo.config as AgentConfig;

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
          execute: async ({ title }) => {
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
    const config = this.config as AgentConfig;

    // Find claude executable
    const claudeExecutable = findExecutable("claude");
    if (!claudeExecutable) {
      throw new Error("Claude Code CLI not found in PATH");
    }
    this.claudeExecutable = claudeExecutable;
    this.log.info(`Claude executable: ${claudeExecutable}`);

    // Initialize settings manager
    this.settings = createSettingsManager<ClaudeCodeSettings>({
      client: this.client as AgenticClient<ChatParticipantMetadata>,
      defaults: DEFAULT_SETTINGS,
      initConfig: {
        model: config.model,
        maxThinkingTokens: config.maxThinkingTokens,
        executionMode: config.executionMode,
        autonomyLevel: config.autonomyLevel,
      },
    });
    await this.settings.load();

    // Initialize interrupt controller
    this.interrupt = createInterruptController();

    // Initialize message queue
    this.queue = createMessageQueue({
      onProcess: (event) => this.handleUserMessage(event as IncomingNewMessage),
      onError: (err, event) => {
        this.log.error("Event processing failed", err, { eventId: (event as IncomingNewMessage).id });
      },
    });

    // Wire interrupt controller to queue
    this.interrupt.onPause(() => this.queue.pause());
    this.interrupt.onResume(() => this.queue.resume());

    // Initialize missed context manager
    this.missedContext = createMissedContextManager({
      client: this.client as AgenticClient<ChatParticipantMetadata>,
      maxChars: DEFAULT_MISSED_CONTEXT_MAX_CHARS,
    });

    this.client.onReconnect(() => {
      this.missedContext.rebuild();
    });

    // Initialize context tracker
    const currentSettings = this.settings.get();
    this.contextTracker = createContextTracker({
      model: currentSettings.model,
      log: (msg) => this.log.debug(msg),
      onUpdate: async (usage: ContextWindowUsage) => {
        const currentMetadata = this.client.clientId
          ? this.client.roster[this.client.clientId]?.metadata
          : undefined;

        const metadata: ChatParticipantMetadata = {
          name: "Claude Code",
          type: "claude-code",
          handle: this.handle,
          agentTypeId: this.agentId,
          ...currentMetadata,
          contextUsage: usage,
          executionMode: this.settings.get().executionMode,
        };

        try {
          await this.client.updateMetadata(metadata);
        } catch (err) {
          this.log.error("Failed to update context usage metadata", err);
        }
      },
    });

    // Initialize subagent manager
    const pubsubConfig = {
      serverUrl: (this.client as AgenticClient<ChatParticipantMetadata>).serverUrl,
      token: (this.client as AgenticClient<ChatParticipantMetadata>).token,
    };

    this.subagents = new SubagentManager({
      serverUrl: pubsubConfig.serverUrl,
      token: pubsubConfig.token,
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
      settings: this.settings.get(),
    });
  }

  async onEvent(event: EventStreamItem): Promise<void> {
    if (event.type !== "message") return;

    // Skip replay messages
    if ("kind" in event && event.kind === "replay") return;

    // Skip typing indicators
    const contentType = (event as { contentType?: string }).contentType;
    if (contentType === CONTENT_TYPE_TYPING) return;

    const sender = this.client.roster[event.senderId];
    if (sender?.metadata.type !== "panel") return;
    if (event.senderId === this.client.clientId) return;

    // Enqueue for ordered processing
    this.queue.enqueue(event);
  }

  async onSleep(): Promise<void> {
    this.queue.stop();
    await this.queue.drain();
    this.interrupt.cleanup();
    await this.subagents?.cleanupAll();

    this.log.info("ClaudeCodeResponder shutting down");
  }

  private async performSessionRecovery(sdkSessionId: string, workingDirectory: string): Promise<void> {
    const client = this.client as AgenticClient<ChatParticipantMetadata>;

    this.log.info(`Performing session recovery for SDK session: ${sdkSessionId}`);

    try {
      const recoveryResult = await recoverSession({
        sdkSessionId,
        workingDirectory,
        sendMessage: async (content, metadata) => {
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
        log: (msg) => this.log.debug(msg),
      });

      if (recoveryResult.recovered) {
        this.log.info(`Session recovery complete: ${recoveryResult.messagesPostedToPubsub} messages posted, ${recoveryResult.contextForSdk.length} messages for SDK context`);

        if (recoveryResult.contextForSdk.length > 1) {
          const panel = Object.values(client.roster).find(
            (p) => p.metadata.type === "panel"
          );

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
    const panel = Object.values(client.roster).find(
      (p) => p.metadata.type === "panel"
    );

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

    const fields = CLAUDE_CODE_PARAMETERS
      .filter((p) => !p.channelLevel)
      .map((f) => {
        if (f.key === "model" && modelOptions.length > 0) {
          return { ...f, options: modelOptions };
        }
        return f;
      });

    const callHandle = client.callMethod(panel.id, "feedback_form", {
      title: "Claude Code Settings",
      fields,
      values: this.settings.get(),
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
    await this.settings.update(newSettings);

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
      executionMode: this.settings.get().executionMode,
    };
    try {
      await client.updateMetadata(metadata);
    } catch (err) {
      this.log.warn("Failed to update metadata after settings change", err);
    }

    return { success: true, settings: this.settings.get() };
  }

  private async handleUserMessage(incoming: IncomingNewMessage): Promise<void> {
    const config = this.config as AgentConfig;
    const client = this.client as AgenticClient<ChatParticipantMetadata>;
    const settings = this.settings.get();

    this.log.info(`Received message: ${incoming.content}`);

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
    const panel = Object.values(client.roster).find(
      (p) => p.metadata.type === "panel"
    );

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
    let checkpointCommitted = false;

    const ensureResponseMessage = async (sdkUuid?: string, sdkSessionId?: string): Promise<string> => {
      if (typing.isTyping()) {
        await typing.stopTyping();
      }
      if (!responseId) {
        const metadata: Record<string, unknown> | undefined =
          sdkUuid || sdkSessionId ? { sdkUuid, sdkSessionId } : undefined;
        const { messageId } = await client.send("", { replyTo: incoming.id, metadata } as Parameters<typeof client.send>[1]);
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

      if (config.restrictedMode) {
        const { definitions: toolDefs, execute: executeTool } = createToolsForAgentSDK(client, {
          namePrefix: "pubsub",
        });

        const toolDefsWithExecute: ToolDefinitionWithExecute[] = toolDefs.map((toolDef: AgentSDKToolDefinition) => ({
          name: toolDef.name,
          description: toolDef.description,
          inputSchema: toolDef.parameters,
          execute: async (args: unknown) => executeTool(toolDef.name, args),
        }));

        const restrictedTaskTool = createRestrictedTaskTool({
          parentClient: client,
          availableTools: toolDefsWithExecute,
          claudeExecutable: this.claudeExecutable,
          connectionOptions: this.subagents.getConnectionOptionsForExternalUse(),
          parentSettings: { maxThinkingTokens: settings.maxThinkingTokens },
        });

        const mcpTools = toolDefs.map((toolDef: AgentSDKToolDefinition) => {
          const displayName = getCanonicalToolName(toolDef.originalMethodName);
          return tool(
            displayName,
            toolDef.description ?? "",
            jsonSchemaToZodRawShape(toolDef.parameters),
            async (args: unknown) => {
              const result = await executeTool(toolDef.name, args);
              return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
            }
          );
        });

        const taskMcpTool = tool(
          "Task",
          restrictedTaskTool.description,
          restrictedTaskTool.inputSchema.shape,
          async (args: unknown) => {
            const result = await restrictedTaskTool.execute(args as Parameters<typeof restrictedTaskTool.execute>[0]);
            return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
          }
        );
        mcpTools.push(taskMcpTool);

        pubsubServer = createSdkMcpServer({
          name: "workspace",
          version: "1.0.0",
          tools: mcpTools,
        });

        allowedTools = [
          ...mcpTools.map((t) => `mcp__workspace__${t.name}`),
          "TodoWrite",
        ];
      }

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

      // Create permission handler
      const canUseTool: CanUseTool = async (toolName, input, options) => {
        return this.handleToolPermission(toolName, input, options, client, panel, settings, interruptHandler);
      };

      // Resume session
      const resumeSessionId = client.sdkSessionId || this.state.sdkSessionId;
      if (resumeSessionId) {
        this.log.debug(`Resuming session: ${resumeSessionId}`);
      }

      const queryOptions: Parameters<typeof query>[0]["options"] = {
        ...(() => {
          const servers: Record<string, ReturnType<typeof createSdkMcpServer>> = {};
          if (config.restrictedMode && pubsubServer) {
            servers.workspace = pubsubServer;
          }
          servers.channel = channelToolsServer;
          if (attachmentsMcpServer) {
            servers.attachments = attachmentsMcpServer;
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

      const toolInputAccumulators = new Map<string, {
        toolName: string;
        inputChunks: string[];
      }>();

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

              const prettifiedToolName = prettifyToolName(toolBlock.name);
              await action.startAction({
                type: prettifiedToolName,
                description: getActionDescription(prettifiedToolName),
                toolUseId: toolBlock.id,
              });
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

              if (!checkpointCommitted && incoming.pubsubId !== undefined) {
                this.commitCheckpoint(incoming.pubsubId);
                checkpointCommitted = true;
              }
            }
          }

          if (streamEvent.type === "content_block_delta" && streamEvent.delta?.type === "input_json_delta") {
            if (streamEvent.delta.partial_json && action.isActive()) {
              const currentAction = action.state.currentAction;
              if (currentAction?.toolUseId) {
                const acc = toolInputAccumulators.get(currentAction.toolUseId);
                if (acc) acc.inputChunks.push(streamEvent.delta.partial_json);
              }
            }
          }

          if (streamEvent.type === "content_block_stop") {
            if (thinking.isThinking()) await thinking.endThinking();

            if (action.isActive()) {
              const currentAction = action.state.currentAction;
              if (currentAction?.toolUseId) {
                const acc = toolInputAccumulators.get(currentAction.toolUseId);
                if (acc && acc.inputChunks.length > 0) {
                  try {
                    const fullInput = acc.inputChunks.join("");
                    const parsedInput = JSON.parse(fullInput) as Record<string, unknown>;
                    const detailedDescription = getDetailedActionDescription(acc.toolName, parsedInput);
                    await action.updateAction(detailedDescription);

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
                      await this.subagents.create(currentAction.toolUseId, {
                        taskDescription: taskArgs.description ?? "Subagent task",
                        subagentType: taskArgs.subagent_type,
                        parentToolUseId: currentAction.toolUseId,
                      });
                    }
                  } catch {
                    // JSON parse failed
                  }
                }
                toolInputAccumulators.delete(currentAction.toolUseId);
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
              inputTokens: resultMessage.usage.input_tokens ?? 0,
              outputTokens: resultMessage.usage.output_tokens ?? 0,
              costUsd: resultMessage.total_cost_usd,
            });
          }

          this.log.info(`Query completed. Cost: $${(message as { total_cost_usd?: number }).total_cost_usd?.toFixed(4) ?? "unknown"}`);
        }
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

      if (!checkpointCommitted && incoming.pubsubId !== undefined) {
        this.commitCheckpoint(incoming.pubsubId);
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

      if (!checkpointCommitted && incoming.pubsubId !== undefined) {
        this.commitCheckpoint(incoming.pubsubId);
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
        const { messageId: errorMsgId } = await client.send("", { replyTo: incoming.id });
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
    interruptHandler: ReturnType<typeof createInterruptHandler>
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

        return { behavior: "allow", updatedInput: { ...input, answers }, toolUseID: options.toolUseID };
      } catch (err) {
        if (err instanceof AgenticError && ["cancelled", "timeout", "provider-offline", "provider-not-found"].includes(err.code)) {
          return { behavior: "deny", message: err.message, toolUseID: options.toolUseID };
        }
        throw err;
      }
    }

    // Handle ExitPlanMode
    if (toolName === "ExitPlanMode") {
      let planFilePath = (input as Record<string, unknown>).planFilePath as string | undefined;
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
      input = { ...input, plan, planFilePath };
    }

    // Check autonomy level
    const isInteractiveTool = ["AskUserQuestion", "ExitPlanMode", "EnterPlanMode"].includes(toolName);
    const autonomyLevel = settings.autonomyLevel ?? 0;

    if (!isInteractiveTool && !needsApprovalForTool(toolName, autonomyLevel)) {
      return { behavior: "allow", updatedInput: input, toolUseID: options.toolUseID };
    }

    if (!panel) {
      return { behavior: "deny", message: "No panel available", toolUseID: options.toolUseID };
    }

    const isFirstTimeGrant = !settings.hasShownApprovalPrompt;

    try {
      const { allow, alwaysAllow } = await showPermissionPrompt(
        client,
        panel.id,
        toolName,
        input,
        {
          decisionReason: options.decisionReason,
          isFirstTimeGrant,
          floorLevel: autonomyLevel,
        }
      );

      if (!settings.hasShownApprovalPrompt) {
        await this.settings.update({ hasShownApprovalPrompt: true });
      }

      if (allow) {
        if (alwaysAllow) {
          await this.settings.update({ autonomyLevel: 2 });
        }
        return { behavior: "allow", updatedInput: input, toolUseID: options.toolUseID };
      } else {
        return { behavior: "deny", message: "User denied permission", toolUseID: options.toolUseID };
      }
    } catch (err) {
      if (err instanceof AgenticError && ["cancelled", "timeout", "provider-offline", "provider-not-found"].includes(err.code)) {
        return { behavior: "deny", message: err.message, toolUseID: options.toolUseID };
      }
      throw err;
    }
  }
}

runAgent(ClaudeCodeResponder);
