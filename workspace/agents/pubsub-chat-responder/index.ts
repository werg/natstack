/**
 * Agentic Chat AI Responder Agent
 *
 * AI-powered chat responder using the new agent framework.
 * Listens for user messages on a channel and responds using AI streaming.
 *
 * Migrated from workspace/workers/pubsub-chat-responder to use:
 * - Agent base class from @natstack/agent-runtime
 * - Pattern helpers from @natstack/agent-patterns
 */

import { Agent, runAgent } from "@natstack/agent-runtime";
import type {
  EventStreamItem,
  AgenticClient,
  ChatParticipantMetadata,
  IncomingNewMessage,
  ContextWindowUsage,
} from "@natstack/agentic-messaging";
import {
  createInterruptHandler,
  createPauseMethodDefinition,
  showPermissionPrompt,
  getDetailedActionDescription,
  CONTENT_TYPE_TYPING,
  filterImageAttachments,
  validateAttachments,
  uint8ArrayToBase64,
  createTypingTracker,
  createQueuePositionText,
  cleanupQueuedTypingTrackers,
} from "@natstack/agentic-messaging";
import {
  AI_RESPONDER_PARAMETERS,
  AI_ROLE_FALLBACKS,
} from "@natstack/agentic-messaging/config";
import type { Attachment } from "@natstack/pubsub";
import type { Message, ToolResultPart } from "@natstack/ai";
import {
  createMessageQueue,
  createInterruptController,
  createSettingsManager,
  createTrackerManager,
  createMissedContextManager,
  createStandardTools,
  createContextTracker,
  findPanelParticipant,
  discoverPubsubToolsForMode,
  toAiSdkTools,
  createCanUseToolGate,
  type MessageQueue,
  type InterruptController,
  type SettingsManager,
  type MissedContextManager,
} from "@natstack/agent-patterns";
import {
  createRestrictedModeSystemPrompt,
} from "@natstack/agent-patterns/prompts";
import { ai } from "@natstack/ai";
import { z } from "zod";

/**
 * Agent configuration passed at spawn time via inviteAgent().
 * Maps to previous stateArgs from getStateArgs<T>().
 */
interface AgentConfig {
  contextId: string;
  modelRole?: string;
  temperature?: number;
  maxOutputTokens?: number;
  autonomyLevel?: number;
  maxSteps?: number;
  thinkingBudget?: number;
}

/**
 * Runtime-adjustable settings (user preferences).
 * Persisted via pubsub session storage, separate from agent state.
 */
interface PubsubChatSettings {
  modelRole: string;
  temperature: number;
  maxOutputTokens: number;
  autonomyLevel: number;
  maxSteps: number;
  thinkingBudget: number;
  hasShownApprovalPrompt: boolean;
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

/**
 * Agent state (persisted by runtime via SQLite).
 * Keep minimal - use settings manager for user preferences.
 */
interface PubsubChatState {
  // Currently empty - all user preferences handled via SettingsManager
  // Runtime manages checkpoint tracking separately
}

/**
 * AI Chat Responder Agent
 *
 * Uses the producer/consumer pattern with message queue for event processing.
 * Supports interrupt handling, settings management, and context tracking.
 */
/** Queued message with per-message typing tracker */
interface PubsubChatQueuedMessage {
  event: IncomingNewMessage;
  typingTracker: ReturnType<typeof createTypingTracker>;
}

class PubsubChatResponder extends Agent<PubsubChatState> {
  state: PubsubChatState = {};

  // Pattern helpers from @natstack/agent-patterns
  private queue!: MessageQueue;
  private interrupt!: InterruptController;
  private settings!: SettingsManager<PubsubChatSettings>;
  private missedContext!: MissedContextManager;
  private contextTracker!: ReturnType<typeof createContextTracker>;

  // Per-message typing trackers for queue position display
  private queuedMessages = new Map<string, PubsubChatQueuedMessage>();

  /**
   * Customize pubsub connection options.
   * Uses lastCheckpoint for replay recovery after restart.
   *
   * Note: this.ctx is available here (with client: null until pubsub connects).
   * Use canonical accessors: this.config, this.agentId, etc.
   */
  getConnectOptions() {
    const config = this.config as AgentConfig;

    return {
      name: "AI Responder",
      type: "ai-responder" as const,
      contextId: config.contextId,
      extraMetadata: {
        agentTypeId: this.agentId,
      },
      reconnect: true,
      // Resume from last checkpoint if available
      replaySinceId: this.lastCheckpoint,
      // Register methods for settings and pause
      // Methods execute after connect, so this.client is available in them
      methods: {
        pause: createPauseMethodDefinition(async () => {
          // Pause event triggers interrupt handler
        }),
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
          execute: async ({ title }) => {
            await this.client.setChannelTitle(title);
            this.log.info(`Set channel title to: ${title}`);
            return { success: true, title };
          },
        },
      },
    };
  }

  /**
   * Customize event stream filtering.
   */
  getEventsOptions() {
    return {
      targetedOnly: true,
      respondWhenSolo: true,
    };
  }

  /**
   * Initialize agent after state and context are ready.
   * Uses canonical accessors: this.client, this.config, this.log
   */
  async onWake(): Promise<void> {
    const config = this.config as AgentConfig;

    // Initialize settings manager with 3-way merge
    // Note: this.client is now available (connected after getConnectOptions)
    this.settings = createSettingsManager<PubsubChatSettings>({
      client: this.client as AgenticClient<ChatParticipantMetadata>,
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

    // Load settings with error handling - fall back to defaults on failure
    try {
      await this.settings.load();
    } catch (err) {
      this.log.warn("Failed to load settings from pubsub session, using defaults:", err);
      // Settings manager already has defaults, so we can continue
    }

    // Initialize interrupt controller
    this.interrupt = createInterruptController();

    // Initialize message queue with interrupt wiring and queue position tracking
    this.queue = createMessageQueue({
      onProcess: (event) => this.handleUserMessage(event as IncomingNewMessage),
      onError: (err, event) => {
        this.log.error("Event processing failed", err, { eventId: (event as IncomingNewMessage).id });
      },
      onDequeue: async (event) => {
        // Update queue positions for all waiting messages
        const msgEvent = event as IncomingNewMessage;

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

    // Initialize missed context manager for reconnection scenarios
    // sinceId skips events already processed before this wake cycle (prevents regurgitation on reconnect)
    // excludeSenderTypes filters out the agent's own responses (already in conversation history)
    this.missedContext = createMissedContextManager({
      client: this.client as AgenticClient<ChatParticipantMetadata>,
      maxChars: 8000,
      sinceId: this.lastCheckpoint,
      excludeSenderTypes: ["ai-responder"],
    });

    // Handle reconnection
    this.client.onReconnect(() => {
      this.missedContext.rebuild();
    });

    // Initialize context tracker for token usage monitoring
    const currentSettings = this.settings.get();
    this.contextTracker = createContextTracker({
      model: currentSettings.modelRole,
      log: (msg) => this.log.debug(msg),
      onUpdate: async (usage: ContextWindowUsage) => {
        // Update participant metadata with context usage
        const currentMetadata = this.client.clientId
          ? this.client.roster[this.client.clientId]?.metadata
          : undefined;

        const metadata: ChatParticipantMetadata = {
          name: "AI Responder",
          type: "ai-responder",
          handle: this.handle,
          agentTypeId: this.agentId,
          ...currentMetadata,
          contextUsage: usage,
        };

        try {
          await this.client.updateMetadata(metadata);
        } catch (err) {
          this.log.error("Failed to update context usage metadata", err);
        }
      },
    });

    this.log.info("PubsubChatResponder started", {
      channel: this.channel,
      handle: this.handle,
      settings: this.settings.get(),
    });
  }

  /**
   * Handle incoming events - enqueue for ordered processing.
   * Returns quickly (fire-and-forget compatible).
   */
  async onEvent(event: EventStreamItem): Promise<void> {
    if (event.type !== "message") return;

    const msgEvent = event as IncomingNewMessage;

    // Skip replay messages - don't respond to historical messages
    if ("kind" in event && event.kind === "replay") return;

    // Skip typing indicators
    const contentType = (event as { contentType?: string }).contentType;
    if (contentType === CONTENT_TYPE_TYPING) return;

    const sender = this.client.roster[event.senderId];

    // Only respond to messages from panels (users)
    if (sender?.metadata.type !== "panel") return;
    if (event.senderId === this.client.clientId) return;

    // Create per-message typing tracker for queue position display
    const typingTracker = createTypingTracker({
      client: this.client as AgenticClient<ChatParticipantMetadata>,
      replyTo: msgEvent.id,
      senderInfo: {
        senderId: this.client.clientId ?? "",
        senderName: "AI Responder",
        senderType: "ai-responder",
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
    const enqueued = this.queue.enqueue(event);
    if (!enqueued) {
      await typingTracker.cleanup();
      this.queuedMessages.delete(msgEvent.id);
    }
  }

  /**
   * Handle settings menu request via RPC.
   */
  private async handleSettingsMenu(): Promise<{ success: boolean; settings?: PubsubChatSettings; cancelled?: boolean; error?: string }> {
    // Find the chat panel participant
    const panel = findPanelParticipant(this.client as AgenticClient<ChatParticipantMetadata>);

    if (!panel) {
      return { success: false, error: "No panel found" };
    }

    // Fetch model roles dynamically
    let roleOptions: Array<{ value: string; label: string }> = [];
    try {
      const roles = await ai.listRoles();
      roleOptions = Object.entries(roles).map(([key, info]) => ({
        value: key,
        label: info.displayName ?? key,
      }));
    } catch (err) {
      this.log.warn(`Failed to fetch roles: ${err}`);
      roleOptions = AI_ROLE_FALLBACKS;
    }

    // Build fields with dynamic model role options
    const fields = AI_RESPONDER_PARAMETERS.map((f) => {
      if (f.key === "modelRole" && roleOptions.length > 0) {
        return { ...f, options: roleOptions };
      }
      return f;
    });

    // Call feedback_form on the panel
    const handle = this.client.callMethod(panel.id, "feedback_form", {
      title: "AI Responder Settings",
      fields,
      values: this.settings.get(),
    });

    const result = await handle.result;
    const feedbackResult = result.content as { type: string; value?: unknown; message?: string };

    if (feedbackResult.type === "cancel") {
      this.log.info("Settings cancelled");
      return { success: false, cancelled: true };
    }

    if (feedbackResult.type === "error") {
      this.log.error(`Settings error: ${feedbackResult.message}`);
      return { success: false, error: feedbackResult.message };
    }

    // Apply new settings
    const newSettings = feedbackResult.value as Partial<PubsubChatSettings>;
    await this.settings.update(newSettings);
    this.log.info(`Settings updated: ${JSON.stringify(this.settings.get())}`);

    return { success: true, settings: this.settings.get() };
  }

  /**
   * Process a user message with AI streaming.
   */
  private async handleUserMessage(incoming: IncomingNewMessage): Promise<void> {
    this.log.info(`Received message: ${incoming.content}`);

    // Stop the per-message queue position typing indicator (it's no longer in queue)
    const queuedInfo = this.queuedMessages.get(incoming.id);
    if (queuedInfo) {
      await queuedInfo.typingTracker.cleanup();
      this.queuedMessages.delete(incoming.id);
    }

    const settings = this.settings.get();

    // Build prompt with missed context if available
    let prompt = String(incoming.content);
    const missedCtx = this.missedContext.consume();
    if (missedCtx) {
      prompt = `<missed_context>\n${missedCtx}\n</missed_context>\n\n${prompt}`;
    }

    // Process image attachments if present
    const attachments = (incoming as { attachments?: Attachment[] }).attachments;
    const imageAttachments = filterImageAttachments(attachments);
    if (imageAttachments.length > 0) {
      const validation = validateAttachments(imageAttachments);
      if (!validation.valid) {
        this.log.warn(`Attachment validation failed: ${validation.error}`);
      }
      this.log.info(`Processing ${imageAttachments.length} image attachment(s)`);
    }

    // Find panel for tool approval UI
    const panel = findPanelParticipant(this.client as AgenticClient<ChatParticipantMetadata>);

    // Create trackers for this message
    const trackers = createTrackerManager({
      client: this.client as AgenticClient<ChatParticipantMetadata>,
      replyTo: incoming.id,
      senderInfo: {
        senderId: this.client.clientId ?? "",
        senderName: "AI Responder",
        senderType: "ai-responder",
      },
      log: (msg) => this.log.debug(msg),
    });

    // Set up interrupt handler to monitor for pause requests
    const interruptHandler = createInterruptHandler({
      client: this.client as AgenticClient<ChatParticipantMetadata>,
      messageId: incoming.id,
      onPause: (reason) => {
        this.log.info(`Pause RPC received: ${reason}`);
        this.interrupt.pause();
        this.interrupt.abortCurrent();
      },
    });

    // Start monitoring for pause events in background
    void interruptHandler.monitor();

    // Start typing indicator
    await trackers.typing.startTyping("preparing response");

    // Reply anchoring: tracks which message responses are anchored to.
    // Updated on interleave to point to the last interleaved user message.
    let replyToId = incoming.id;

    // Lazy message creation
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
      // Build conversation history from pubsub replay
      const conversationHistory = this.client.getConversationHistory();
      if (conversationHistory.length > 0) {
        this.log.debug(`Loaded ${conversationHistory.length} previous messages from replay`);
      }

      // Build initial messages array
      const userContent = imageAttachments.length > 0
        ? [
            ...imageAttachments.map((a) => ({
              type: "image" as const,
              image: uint8ArrayToBase64(a.data),
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

      // Discover tools from channel participants via registry
      const registry = await discoverPubsubToolsForMode(
        this.client as AgenticClient<ChatParticipantMetadata>,
        { mode: "restricted", timeoutMs: 1500, log: (msg) => this.log.debug(msg) },
      );

      // Build tools object for AI SDK using adapter
      const standardTools = createStandardTools({
        client: this.client as AgenticClient<ChatParticipantMetadata>,
        log: (msg) => this.log.debug(msg),
      });
      const { tools, execute: executeTool } = toAiSdkTools(registry, this.client as AgenticClient<ChatParticipantMetadata>, standardTools, {
        approvalLevel: settings.autonomyLevel,
      });

      // Create approval gate for deferred tool execution
      const approvalGate = createCanUseToolGate({
        byCanonical: registry.byCanonical,
        getApprovalLevel: () => this.settings.get().autonomyLevel ?? 0,
        hasShownApprovalPrompt: !!this.settings.get().hasShownApprovalPrompt,
        showPermissionPrompt: async (_tool, input) => {
          if (!panel) return { allow: false };
          const currentSettings = this.settings.get();
          return showPermissionPrompt(
            this.client as AgenticClient<ChatParticipantMetadata>,
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
          void this.settings.update({ autonomyLevel: 2 });
        },
        onFirstPrompt: () => {
          void this.settings.update({ hasShownApprovalPrompt: true });
        },
      });

      const toolNames = Object.keys(tools);
      this.log.debug(`Discovered ${toolNames.length} tools`);
      if (toolNames.length > 0) {
        this.log.debug(`Tools: ${toolNames.join(", ")}`);
      }

      // Agentic loop with approval handling
      let step = 0;
      const maxSteps = settings.maxSteps;

      while (step < maxSteps) {
        // Check for interruption before each step
        if (interruptHandler.isPaused()) {
          this.log.info("Execution paused before step");
          break;
        }

        // Create fresh abort signal for this AI call
        const signal = this.interrupt.createAbortSignal();

        const stream = ai.streamText({
          model: settings.modelRole,
          system: createRestrictedModeSystemPrompt(),
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

        for await (const event of stream) {
          if (interruptHandler.isPaused()) {
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
              allToolCalls.push({
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                args: event.args,
              });

              const argsRecord = event.args && typeof event.args === "object"
                ? event.args as Record<string, unknown>
                : {};
              await trackers.action.startAction({
                type: event.toolName,
                description: getDetailedActionDescription(event.toolName, argsRecord),
                toolUseId: event.toolCallId,
              });

              const toolDef = tools[event.toolName];
              if (toolDef && !toolDef.execute) {
                pendingApprovals.push({
                  toolCallId: event.toolCallId,
                  toolName: event.toolName,
                  args: event.args as Record<string, unknown>,
                });
              }
              this.log.debug(`Tool call: ${event.toolName}${toolDef?.execute ? " (auto)" : " (needs approval)"}`);
              break;
            }

            case "tool-result":
              await trackers.action.completeAction();
              autoToolResults.push({
                type: "tool-result",
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                result: event.result,
                isError: event.isError,
              });
              this.log.debug(`Tool result: ${event.toolName}${event.isError ? " (error)" : ""}`);
              break;

            case "step-finish":
              finishReason = event.finishReason;
              break;
          }
        }

        // Record token usage
        const streamUsage = await stream.usage;
        if (streamUsage) {
          await this.contextTracker.recordUsage({
            inputTokens: streamUsage.promptTokens ?? 0,
            outputTokens: streamUsage.completionTokens ?? 0,
          });
        }

        // Process pending approvals via gate
        const approvalResults: ToolResultPart[] = [];
        if (pendingApprovals.length > 0) {
          for (const approval of pendingApprovals) {
            const { allow } = await approvalGate.canUseTool(
              approval.toolName,
              approval.args,
            );

            if (allow) {
              try {
                const result = await executeTool(approval.toolName, approval.args);
                approvalResults.push({
                  type: "tool-result",
                  toolCallId: approval.toolCallId,
                  toolName: approval.toolName,
                  result,
                });
                this.log.debug(`Tool ${approval.toolName} approved and executed`);
              } catch (err) {
                approvalResults.push({
                  type: "tool-result",
                  toolCallId: approval.toolCallId,
                  toolName: approval.toolName,
                  result: `Error: ${err instanceof Error ? err.message : String(err)}`,
                  isError: true,
                });
                this.log.error(`Tool ${approval.toolName} execution failed: ${err}`);
              }
            } else {
              approvalResults.push({
                type: "tool-result",
                toolCallId: approval.toolCallId,
                toolName: approval.toolName,
                result: "User denied permission to execute this tool",
                isError: true,
              });
              this.log.debug(`Tool ${approval.toolName} denied`);
            }
          }
        }

        // Add tool calls and results to messages
        if (allToolCalls.length > 0) {
          const combinedResults = [...autoToolResults, ...approvalResults];

          messages.push({
            role: "assistant",
            content: allToolCalls.map((tc) => ({
              type: "tool-call" as const,
              toolCallId: tc.toolCallId,
              toolName: tc.toolName,
              args: tc.args,
            })),
          });
          messages.push({
            role: "tool",
            content: combinedResults,
          });
        }

        // If every tool call in this step was denied, stop the loop.
        // Feeding rejections back as error results would just artificially
        // prompt the model to generate a new turn apologising for the denial,
        // which is not the expected agentic behavior.
        const allDenied =
          allToolCalls.length > 0 &&
          autoToolResults.length === 0 &&
          approvalResults.every((r) => r.isError);
        if (allDenied) {
          this.log.info("All tool calls denied by user, ending agentic loop");
          break;
        }

        // Check if we should continue the loop
        if (finishReason === "stop" || finishReason === "interrupted" || finishReason === "length") {
          break;
        }

        // Interleave pending user messages between agentic steps
        if (this.queue.getPendingCount() > 0 && !interruptHandler.isPaused() && step + 1 < maxSteps) {
          const pending = this.queue.takePending() as IncomingNewMessage[];
          // Merge all pending messages into a single user message to maintain
          // role alternation (consecutive user messages are rejected by some providers)
          const allParts: Array<{ type: "image"; image: string; mimeType: string } | { type: "text"; text: string }> = [];
          for (const p of pending) {
            // Clean up per-message typing tracker
            const info = this.queuedMessages.get(p.id);
            if (info) {
              await info.typingTracker.cleanup();
              this.queuedMessages.delete(p.id);
            }
            const pAttachments = (p as { attachments?: Attachment[] }).attachments;
            const pImages = filterImageAttachments(pAttachments);
            for (const a of pImages) {
              allParts.push({ type: "image" as const, image: uint8ArrayToBase64(a.data), mimeType: a.mimeType });
            }
            allParts.push({ type: "text" as const, text: String(p.content) });
          }
          const mergedContent = allParts.length === 1 && allParts[0]!.type === "text"
            ? allParts[0]!.text  // single text-only message: use plain string
            : allParts;           // multi-part or multi-message: use array
          messages.push({ role: "user" as const, content: mergedContent });
          // Complete current response and update reply anchoring
          if (responseId) {
            await this.client.complete(responseId);
            responseId = null;
          }
          replyToId = pending[pending.length - 1]!.id;
          trackers.setReplyTo(replyToId);
          this.log.info(`Interleaved ${pending.length} user message(s) between steps`);
        }

        // Continue to next step
        if (responseId) {
          await this.client.complete(responseId);
        }
        const { messageId: newResponseId } = await this.client.send("", { replyTo: replyToId });
        responseId = newResponseId;
        this.log.debug(`Started new message for step ${step + 1}: ${responseId}`);

        step++;
      }

      // Mark message as complete
      if (responseId) {
        await this.client.complete(responseId);
        this.log.info(`Completed response for ${incoming.id}`);
      } else {
        await trackers.typing.cleanup();
        this.log.info(`No response content for ${incoming.id}`);
      }

      // End turn for context tracking
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
      interruptHandler.cleanup();
      // Reset interrupt state so queue can process next message
      // (pause may have been triggered, need to resume for next message)
      this.interrupt.resume();
    }
  }

  /**
   * Cleanup before shutdown.
   */
  async onSleep(): Promise<void> {
    // Stop accepting new events and drain queue
    this.queue.stop();
    await this.queue.drain();
    this.interrupt.cleanup();

    await cleanupQueuedTypingTrackers(this.queuedMessages, (msg) => this.log.warn(msg));

    this.log.info("PubsubChatResponder shutting down");
  }
}

runAgent(PubsubChatResponder);
