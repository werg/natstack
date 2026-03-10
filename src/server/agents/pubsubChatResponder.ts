/**
 * Agentic Chat AI Responder — in-process agent service.
 *
 * Migrated from workspace/agents/pubsub-chat-responder.
 * Implements AgentService instead of extending Agent<State>.
 */

import type { AgentService, AgentServiceContext, AgentLogger } from "./agentAdapter.js";
import type {
  EventStreamItem,
  AgenticClient,
  ChatParticipantMetadata,
  IncomingNewMessage,
  ContextWindowUsage,
} from "@natstack/agentic-messaging";
import {
  createPauseMethodDefinition,
  getDetailedActionDescription,
  CONTENT_TYPE_TYPING,
  filterImageAttachments,
  validateAttachments,
  uint8ArrayToBase64,
  createTypingTracker,
  createQueuePositionText,
  cleanupQueuedTypingTrackers,
  drainForInterleave,
} from "@natstack/agentic-messaging";
import {
  AI_RESPONDER_PARAMETERS,
  AI_ROLE_FALLBACKS,
} from "@natstack/agentic-messaging/config";
import type { Attachment } from "@natstack/pubsub";
import type { Message, ToolResultPart } from "@natstack/types";
import type { AiClient } from "@natstack/ai";
import {
  createMessageQueue,
  createInterruptController,
  createSettingsManager,
  createTrackerManager,
  createMissedContextManager,
  createStandardTools,
  createContextTracker,
  findPanelParticipant,
  discoverPubsubTools,
  toAiSdkTools,
  createCanUseToolGate,
  showPermissionPrompt,
  type MessageQueue,
  type InterruptController,
  type SettingsManager,
  type MissedContextManager,
} from "@natstack/agent-patterns";
import {
  createRichTextChatSystemPrompt,
} from "@natstack/agent-patterns/prompts";
import { z } from "zod";

interface AgentConfig {
  contextId: string;
  modelRole?: string;
  temperature?: number;
  maxOutputTokens?: number;
  autonomyLevel?: number;
  maxSteps?: number;
  thinkingBudget?: number;
}

interface PubsubChatSettings {
  modelRole: string;
  temperature: number;
  maxOutputTokens: number;
  autonomyLevel: number;
  maxSteps: number;
  thinkingBudget: number;
  hasShownApprovalPrompt: boolean;
  [key: string]: string | number | boolean | undefined;
}

const DEFAULT_SETTINGS: PubsubChatSettings = {
  modelRole: "fast",
  temperature: 0.7,
  maxOutputTokens: 1024,
  autonomyLevel: 0,
  maxSteps: 5,
  thinkingBudget: 0,
  hasShownApprovalPrompt: false,
};

interface PubsubChatQueuedMessage {
  event: IncomingNewMessage;
  typingTracker: ReturnType<typeof createTypingTracker>;
}

export class PubsubChatResponder implements AgentService {
  // Set in start()
  private client!: AgenticClient<ChatParticipantMetadata>;
  private log!: AgentLogger;
  private ai!: AiClient;
  private agentId!: string;
  private handle!: string;

  // Pattern helpers
  private queue!: MessageQueue<IncomingNewMessage>;
  private interrupt!: InterruptController;
  private settingsMgr!: SettingsManager<PubsubChatSettings>;
  private missedContext!: MissedContextManager;
  private contextTracker!: ReturnType<typeof createContextTracker>;
  private queuedMessages = new Map<string, PubsubChatQueuedMessage>();

  /**
   * Connection options — called by the adapter before connect().
   */
  getConnectOptions() {
    return {
      name: "AI Responder",
      type: "ai-responder" as const,
      reconnect: true,
      methods: {
        pause: createPauseMethodDefinition(async () => {}),
        settings: {
          description: "Configure AI responder settings",
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

  /**
   * Event stream filtering options — called by the adapter.
   */
  getEventsOptions() {
    return {
      targetedOnly: true,
      respondWhenSolo: true,
    };
  }

  async start(ctx: AgentServiceContext): Promise<void> {
    this.client = ctx.client as AgenticClient<ChatParticipantMetadata>;
    this.log = ctx.log;
    this.ai = ctx.ai;
    this.agentId = ctx.agentId;
    this.handle = ctx.handle;

    const config = ctx.config as unknown as AgentConfig;

    if (!ctx.contextFolderPath) {
      throw new Error("contextFolderPath is required but was not provided");
    }

    // Initialize settings manager
    this.settingsMgr = createSettingsManager<PubsubChatSettings>({
      client: this.client,
      defaults: DEFAULT_SETTINGS,
      initConfig: {
        modelRole: config.modelRole,
        temperature: config.temperature,
        maxOutputTokens: config.maxOutputTokens,
        autonomyLevel: config.autonomyLevel,
        maxSteps: config.maxSteps,
        thinkingBudget: config.thinkingBudget,
      },
    });

    try {
      await this.settingsMgr.load();
    } catch (err) {
      this.log.warn("Failed to load settings from pubsub session, using defaults:", err);
    }

    // Initialize interrupt controller with client for pause event monitoring
    this.interrupt = createInterruptController({ client: ctx.client });

    // Initialize message queue
    this.queue = createMessageQueue<IncomingNewMessage>({
      onProcess: (event) => this.handleUserMessage(event),
      onError: (err, event) => {
        this.log.error("Event processing failed", err, { eventId: event.id });
      },
      onDequeue: async (event) => {
        const msgEvent = event;
        this.queuedMessages.delete(msgEvent.id);
        let position = 0;
        for (const [_id, info] of this.queuedMessages) {
          const positionText = createQueuePositionText({ queueLength: position, isProcessing: true });
          await info.typingTracker.startTyping(positionText);
          position++;
        }
      },
      onHeartbeat: async () => {
        try {
          await this.client.publish("agent-heartbeat", { agentId: this.agentId }, { persist: false });
        } catch (err) {
          this.log.warn("Heartbeat failed", err);
        }
      },
    });

    this.interrupt.onPause(() => this.queue.pause());
    this.interrupt.onResume(() => this.queue.resume());

    // Initialize missed context manager
    // sinceId skips events already processed (prevents regurgitation on reconnect)
    const persistedCheckpoint = ctx.state.get<{ lastCheckpoint?: number }>().lastCheckpoint;
    this.missedContext = createMissedContextManager({
      client: this.client,
      maxChars: 8000,
      sinceId: persistedCheckpoint,
      excludeSenderTypes: ["ai-responder"],
    });

    this.client.onReconnect(() => {
      this.missedContext.rebuild();
    });

    // Initialize context tracker
    const currentSettings = this.settingsMgr.get();
    this.contextTracker = createContextTracker({
      model: currentSettings.modelRole,
      log: (msg) => this.log.debug(msg),
      onUpdate: async (usage: ContextWindowUsage) => {
        const currentMetadata = this.client.clientId
          ? this.client.roster[this.client.clientId]?.metadata
          : undefined;

        const metadata: ChatParticipantMetadata = {
          ...currentMetadata,
          name: "AI Responder",
          type: "ai-responder" as const,
          handle: this.handle,
          agentTypeId: this.agentId,
          contextUsage: usage,
          activeModel: this.settingsMgr.get().modelRole,
        };

        try {
          await this.client.updateMetadata(metadata);
        } catch (err) {
          this.log.error("Failed to update context usage metadata", err);
        }
      },
    });

    this.log.info("PubsubChatResponder started", {
      channel: ctx.channel,
      handle: ctx.handle,
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

    // Create per-message typing tracker
    const typingTracker = createTypingTracker({
      client: this.client,
      replyTo: msgEvent.id,
      senderInfo: {
        senderId: this.client.clientId ?? "",
        senderName: "AI Responder",
        senderType: "ai-responder",
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

  async stop(): Promise<void> {
    this.queue.stop();
    await this.queue.drain();
    this.interrupt.cleanup();
    await cleanupQueuedTypingTrackers(this.queuedMessages, (msg) => this.log.warn(msg));
    await this.contextTracker.cleanup();
    this.log.info("PubsubChatResponder shutting down");
  }

  // ── Private methods (unchanged from original) ──

  private async handleSettingsMenu(): Promise<{ success: boolean; settings?: PubsubChatSettings; cancelled?: boolean; error?: string }> {
    const panel = findPanelParticipant(this.client);

    if (!panel) {
      return { success: false, error: "No panel found" };
    }

    let roleOptions: Array<{ value: string; label: string }> = [];
    try {
      const roles = await this.ai.listRoles();
      roleOptions = Object.entries(roles).map(([key, info]) => ({
        value: key,
        label: info.displayName ?? key,
      }));
    } catch (err) {
      this.log.warn(`Failed to fetch roles: ${err}`);
      roleOptions = AI_ROLE_FALLBACKS;
    }

    const fields = AI_RESPONDER_PARAMETERS.map((f) => {
      if (f.key === "modelRole" && roleOptions.length > 0) {
        return { ...f, options: roleOptions };
      }
      return f;
    });

    const callHandle = this.client.callMethod(panel.id, "feedback_form", {
      title: "AI Responder Settings",
      fields,
      values: this.settingsMgr.get(),
    });

    const result = await callHandle.result;
    const feedbackResult = result.content as { type: string; value?: unknown; message?: string };

    if (feedbackResult.type === "cancel") {
      this.log.info("Settings cancelled");
      return { success: false, cancelled: true };
    }

    if (feedbackResult.type === "error") {
      this.log.error(`Settings error: ${feedbackResult.message}`);
      return { success: false, error: feedbackResult.message };
    }

    const newSettings = feedbackResult.value as Partial<PubsubChatSettings>;
    await this.settingsMgr.update(newSettings);
    this.log.info(`Settings updated: ${JSON.stringify(this.settingsMgr.get())}`);

    const currentMetadata = this.client.clientId
      ? this.client.roster[this.client.clientId]?.metadata
      : undefined;
    const metadata: ChatParticipantMetadata = {
      ...currentMetadata,
      name: "AI Responder",
      type: "ai-responder" as const,
      handle: this.handle,
      agentTypeId: this.agentId,
      activeModel: this.settingsMgr.get().modelRole,
    };
    try {
      await this.client.updateMetadata(metadata);
    } catch (err) {
      this.log.error("Failed to update metadata after settings change", err);
    }

    return { success: true, settings: this.settingsMgr.get() };
  }

  private async handleUserMessage(incoming: IncomingNewMessage): Promise<void> {
    this.log.info(`Received message: ${incoming.content}`);

    const queuedInfo = this.queuedMessages.get(incoming.id);
    if (queuedInfo) {
      await queuedInfo.typingTracker.cleanup();
      this.queuedMessages.delete(incoming.id);
    }

    const settings = this.settingsMgr.get();

    let prompt = String(incoming.content);
    const missedCtx = this.missedContext.consume();
    if (missedCtx) {
      prompt = `<missed_context>\n${missedCtx}\n</missed_context>\n\n${prompt}`;
    }

    const attachments = (incoming as { attachments?: Attachment[] }).attachments;
    const imageAttachments = filterImageAttachments(attachments);
    if (imageAttachments.length > 0) {
      const validation = validateAttachments(imageAttachments);
      if (!validation.valid) {
        this.log.warn(`Attachment validation failed: ${validation.error}`);
      }
      this.log.info(`Processing ${imageAttachments.length} image attachment(s)`);
    }

    const panel = findPanelParticipant(this.client);

    const trackers = createTrackerManager({
      client: this.client,
      replyTo: incoming.id,
      senderInfo: {
        senderId: this.client.clientId ?? "",
        senderName: "AI Responder",
        senderType: "ai-responder",
      },
      log: (msg) => this.log.debug(msg),
    });

    // Start pause event monitoring for this message
    // (controller automatically calls pause() + abortCurrent() on pause event)
    void this.interrupt.startMonitoring(incoming.id);
    await trackers.typing.startTyping("preparing response");

    let replyToId = incoming.id;
    let responseId: string | null = null;

    const ensureResponseMessage = async (): Promise<string> => {
      if (trackers.typing.isTyping()) {
        await trackers.typing.stopTyping();
      }
      if (!responseId) {
        const { messageId } = await this.client.send("", { replyTo: replyToId });
        responseId = messageId;
      }
      return responseId;
    };

    try {
      const conversationHistory = this.client.getConversationHistory();
      if (conversationHistory.length > 0) {
        this.log.debug(`Loaded ${conversationHistory.length} previous messages from replay`);
      }

      const userContent = imageAttachments.length > 0
        ? [
            ...imageAttachments.map((a) => ({
              type: "file" as const,
              data: uint8ArrayToBase64(a.data),
              mimeType: a.mimeType,
            })),
            { type: "text" as const, text: prompt },
          ]
        : prompt;

      const messages: Message[] = [
        ...conversationHistory.map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        })),
        { role: "user" as const, content: userContent },
      ];

      const registry = await discoverPubsubTools(
        this.client,
        { allowlist: ["feedback_form", "feedback_custom", "eval"], timeoutMs: 1500, log: (msg) => this.log.debug(msg) },
      );

      const standardTools = createStandardTools({
        client: this.client,
        log: (msg) => this.log.debug(msg),
      });
      const { tools, execute: executeTool } = toAiSdkTools(registry, this.client, standardTools, {
        approvalLevel: settings.autonomyLevel,
      });

      const approvalGate = createCanUseToolGate({
        byCanonical: registry.byCanonical,
        getApprovalLevel: () => this.settingsMgr.get().autonomyLevel ?? 0,
        hasShownApprovalPrompt: !!this.settingsMgr.get().hasShownApprovalPrompt,
        showPermissionPrompt: async (_tool, input) => {
          if (!panel) return { allow: false };
          const currentSettings = this.settingsMgr.get();
          return showPermissionPrompt(
            this.client,
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

      const toolNames = Object.keys(tools);
      this.log.debug(`Discovered ${toolNames.length} tools`);
      if (toolNames.length > 0) {
        this.log.debug(`Tools: ${toolNames.join(", ")}`);
      }

      let step = 0;
      const maxSteps = settings.maxSteps;

      while (step < maxSteps) {
        if (this.interrupt.isPaused()) {
          this.log.info("Execution paused before step");
          break;
        }

        const signal = this.interrupt.createAbortSignal();

        const stream = this.ai.streamText({
          model: settings.modelRole,
          system: createRichTextChatSystemPrompt(),
          messages,
          tools: Object.keys(tools).length > 0 ? tools : undefined,
          maxSteps: 1,
          maxOutputTokens: settings.maxOutputTokens,
          ...(settings.temperature !== undefined && { temperature: settings.temperature }),
          ...(settings.thinkingBudget > 0 && {
            thinking: { type: "enabled" as const, budgetTokens: settings.thinkingBudget },
          }),
          abortSignal: signal,
        });

        const allToolCalls: Array<{ toolCallId: string; toolName: string; args: unknown }> = [];
        const autoToolResults: ToolResultPart[] = [];
        const pendingApprovals: Array<{ toolCallId: string; toolName: string; args: unknown }> = [];
        let finishReason: string = "stop";
        let streamUsage: { promptTokens: number; completionTokens: number } | undefined;

        for await (const event of stream) {
          if (this.interrupt.isPaused()) {
            this.log.info("Execution paused, stopping stream");
            finishReason = "interrupted";
            break;
          }

          switch (event.type) {
            case "reasoning-start":
              await trackers.thinking.startThinking();
              break;
            case "reasoning-delta":
              if (event.text) {
                await trackers.thinking.updateThinking(event.text);
              }
              break;
            case "reasoning-end":
              await trackers.thinking.endThinking();
              break;
            case "text-delta": {
              const msgId = await ensureResponseMessage();
              await this.client.update(msgId, event.text);
              break;
            }
            case "tool-call": {
              allToolCalls.push({ toolCallId: event.toolCallId, toolName: event.toolName, args: event.args });
              const argsRecord = event.args && typeof event.args === "object" ? event.args as Record<string, unknown> : {};
              await trackers.action.startAction({
                type: event.toolName,
                description: getDetailedActionDescription(event.toolName, argsRecord),
                toolUseId: event.toolCallId,
              });
              const toolDef = tools[event.toolName];
              if (toolDef && !toolDef.execute) {
                pendingApprovals.push({ toolCallId: event.toolCallId, toolName: event.toolName, args: event.args as Record<string, unknown> });
              }
              this.log.debug(`Tool call: ${event.toolName}${toolDef?.execute ? " (auto)" : " (needs approval)"}`);
              break;
            }
            case "tool-result":
              await trackers.action.completeAction();
              autoToolResults.push({ type: "tool-result", toolCallId: event.toolCallId, toolName: event.toolName, result: event.result, isError: event.isError });
              this.log.debug(`Tool result: ${event.toolName}${event.isError ? " (error)" : ""}`);
              break;
            case "step-finish":
              finishReason = event.finishReason;
              break;
            case "finish":
              if ("usage" in event && event.usage) {
                streamUsage = event.usage;
              }
              break;
          }
        }

        if (streamUsage) {
          await this.contextTracker.recordUsage({
            inputTokens: streamUsage.promptTokens ?? 0,
            outputTokens: streamUsage.completionTokens ?? 0,
          });
        }

        const approvalResults: ToolResultPart[] = [];
        if (pendingApprovals.length > 0) {
          for (const approval of pendingApprovals) {
            const { allow } = await approvalGate.canUseTool(approval.toolName, approval.args);
            if (allow) {
              try {
                const result = await executeTool(approval.toolName, approval.args);
                approvalResults.push({ type: "tool-result", toolCallId: approval.toolCallId, toolName: approval.toolName, result });
                this.log.debug(`Tool ${approval.toolName} approved and executed`);
              } catch (err) {
                approvalResults.push({ type: "tool-result", toolCallId: approval.toolCallId, toolName: approval.toolName, result: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true });
                this.log.error(`Tool ${approval.toolName} execution failed: ${err}`);
              }
            } else {
              approvalResults.push({ type: "tool-result", toolCallId: approval.toolCallId, toolName: approval.toolName, result: "User denied permission to execute this tool", isError: true });
              this.log.debug(`Tool ${approval.toolName} denied`);
            }
          }
        }

        if (allToolCalls.length > 0) {
          const combinedResults = [...autoToolResults, ...approvalResults];
          messages.push({
            role: "assistant",
            content: allToolCalls.map((tc) => ({ type: "tool-call" as const, toolCallId: tc.toolCallId, toolName: tc.toolName, args: tc.args })),
          });
          messages.push({ role: "tool", content: combinedResults });
        }

        const allDenied = allToolCalls.length > 0 && autoToolResults.length === 0 && approvalResults.every((r) => r.isError);
        if (allDenied) {
          this.log.info("All tool calls denied by user, ending agentic loop");
          break;
        }

        if (finishReason === "stop" || finishReason === "interrupted" || finishReason === "length") {
          break;
        }

        // Interleave pending user messages between agentic steps
        if (this.queue.getPendingCount() > 0 && !this.interrupt.isPaused() && step + 1 < maxSteps) {
          const { pending, lastMessageId } = await drainForInterleave(this.queue.takePending(), this.queuedMessages);
          if (pending.length === 0) {
            this.log.warn("Pending drained between check and take, skipping interleave");
          } else {
            const allParts: Array<{ type: "file"; data: string; mimeType: string } | { type: "text"; text: string }> = [];
            for (const p of pending) {
              const pAttachments = (p as { attachments?: Attachment[] }).attachments;
              const pImages = filterImageAttachments(pAttachments);
              for (const a of pImages) {
                allParts.push({ type: "file" as const, data: uint8ArrayToBase64(a.data), mimeType: a.mimeType });
              }
              allParts.push({ type: "text" as const, text: String(p.content) });
            }
            const mergedContent = allParts.length === 1 && allParts[0]!.type === "text"
              ? allParts[0]!.text
              : allParts;
            messages.push({ role: "user" as const, content: mergedContent });
            if (responseId) {
              await this.client.complete(responseId);
              responseId = null;
            }
            replyToId = lastMessageId!;
            trackers.setReplyTo(replyToId);
            this.log.info(`Interleaved ${pending.length} user message(s) between steps`);
          }
        }

        if (responseId) {
          await this.client.complete(responseId);
        }
        const { messageId: newResponseId } = await this.client.send("", { replyTo: replyToId });
        responseId = newResponseId;
        this.log.debug(`Started new message for step ${step + 1}: ${responseId}`);

        step++;
      }

      if (responseId) {
        await this.client.complete(responseId);
        this.log.info(`Completed response for ${incoming.id}`);
      } else {
        await trackers.typing.cleanup();
        this.log.info(`No response content for ${incoming.id}`);
      }

      await this.contextTracker.endTurn();
    } catch (err) {
      await trackers.cleanupAll();
      await this.contextTracker.cleanup();

      if ((err as Error).name === "AbortError") {
        this.log.info("AI call aborted by user");
        return;
      }

      this.log.error("AI streaming failed", err);

      const errorMsgId = responseId ?? (await this.client.send("", { replyTo: replyToId })).messageId;
      await this.client.error(errorMsgId, err instanceof Error ? err.message : String(err));
    } finally {
      this.interrupt.stopMonitoring();
      this.interrupt.resume();
    }
  }
}
