/**
 * Agentic Chat AI Responder Worker
 *
 * Demonstrates @natstack/agentic-messaging for real-time messaging.
 * Listens for user messages on a channel and responds using AI streaming.
 */

import { pubsubConfig, id, unloadSelf, getStateArgs } from "@natstack/runtime";
import {
  connect,
  createLogger,
  createInterruptHandler,
  createPauseMethodDefinition,
  formatMissedContext,
  createRichTextChatSystemPrompt,
  createRestrictedModeSystemPrompt,
  createToolsForAgentSDK,
  requestToolApproval,
  needsApprovalForTool,
  getCanonicalToolName,
  createThinkingTracker,
  createTypingTracker,
  CONTENT_TYPE_TYPING,
  // Image processing utilities
  filterImageAttachments,
  validateAttachments,
  uint8ArrayToBase64,
  type Attachment,
  type AgenticClient,
  type ChatParticipantMetadata,
  type IncomingNewMessage,
} from "@natstack/agentic-messaging";
import type { Message, ToolResultPart, ToolDefinition } from "@natstack/ai";
import {
  AI_RESPONDER_PARAMETERS,
  AI_ROLE_FALLBACKS,
} from "@natstack/agentic-messaging/config";
import { z } from "zod";
import { ai } from "@natstack/ai";

const log = createLogger("Worker", id);

/**
 * StateArgs passed at spawn time via createChild().
 * Defined in package.json stateArgs schema.
 */
interface AiResponderStateArgs {
  channel: string;
  handle?: string;
  agentTypeId?: string;
  modelRole?: string;
  temperature?: number;
  maxOutputTokens?: number;
  autonomyLevel?: number;
  maxSteps?: number;
  thinkingBudget?: number;
}

/** Worker-local settings interface (runtime-adjustable) */
interface FastAiWorkerSettings {
  modelRole?: string;
  temperature?: number;
  maxOutputTokens?: number;
  autonomyLevel?: number;
  maxSteps?: number;
  thinkingBudget?: number;
}

/** Current settings state - initialized from agent config and persisted settings */
let currentSettings: FastAiWorkerSettings = {};

async function main() {
  if (!pubsubConfig) {
    console.error("No pubsub config available");
    return;
  }

  // Get stateArgs passed at spawn time
  const stateArgs = getStateArgs<AiResponderStateArgs>();
  const channelName = stateArgs.channel;
  const handle = stateArgs.handle ?? "ai";
  const agentTypeId = stateArgs.agentTypeId ?? "pubsub-chat-responder";

  if (!channelName) {
    console.error("No channel specified in stateArgs");
    return;
  }

  log("Starting chat responder...");
  log(`Handle: @${handle}`);

  // Connect to agentic messaging channel with reconnection and participant metadata
  // contextId is obtained automatically from the server's ready message
  // Include workerPanelId and agentTypeId for recovery support
  const client = await connect<ChatParticipantMetadata>({
    serverUrl: pubsubConfig.serverUrl,
    token: pubsubConfig.token,
    channel: channelName,
    handle,
    name: "AI Responder",
    type: "ai-responder",
    extraMetadata: {
      workerPanelId: id, // Panel ID of this worker for reload via ensurePanelLoaded
      agentTypeId,       // Agent type for identification
    },
    reconnect: true,
    methods: {
      pause: createPauseMethodDefinition(async () => {
        // Pause event is published by interrupt handler
      }),
      settings: {
        description: "Configure AI responder settings",
        parameters: z.object({}),
        menu: true,
        execute: async () => {
          // Find the chat panel participant
          const panel = Object.values(client.roster).find(
            (p) => p.metadata.type === "panel"
          );
          if (!panel) throw new Error("No panel found");

          // Fetch model roles dynamically
          let roleOptions: Array<{ value: string; label: string }> = [];
          try {
            const roles = await ai.listRoles();
            roleOptions = Object.entries(roles).map(([key, info]) => ({
              value: key,
              label: info.displayName ?? key,
            }));
          } catch (err) {
            log(`Failed to fetch roles: ${err}`);
            // Fallback to basic options
            roleOptions = AI_ROLE_FALLBACKS;
          }

          // Build fields with dynamic model role options
          const fields = AI_RESPONDER_PARAMETERS.map((f) => {
            // Override modelRole options with dynamic list if available
            if (f.key === "modelRole" && roleOptions.length > 0) {
              return { ...f, options: roleOptions };
            }
            return f;
          });

          // Call feedback_form on the panel
          const handle = client.callMethod(panel.id, "feedback_form", {
            title: "AI Responder Settings",
            fields,
            values: currentSettings,
          });
          const result = await handle.result;
          const feedbackResult = result.content as { type: string; value?: unknown; message?: string };

          // Handle the three cases: submit, cancel, error
          if (feedbackResult.type === "cancel") {
            log("Settings cancelled");
            return { success: false, cancelled: true };
          }

          if (feedbackResult.type === "error") {
            log(`Settings error: ${feedbackResult.message}`);
            return { success: false, error: feedbackResult.message };
          }

          // Apply new settings (submit case)
          const newSettings = feedbackResult.value as FastAiWorkerSettings;
          Object.assign(currentSettings, newSettings);
          log(`Settings updated: ${JSON.stringify(currentSettings)}`);

          // Persist settings if session is available
          if (client.sessionKey) {
            try {
              await client.updateSettings(currentSettings);
            } catch (err) {
              log(`Failed to persist settings: ${err}`);
            }
          }

          return { success: true, settings: currentSettings };
        },
      },
    },
  });

  // Track pending unload timeout - allows cancellation if panel rejoins
  let unloadTimeoutId: ReturnType<typeof setTimeout> | null = null;
  const UNLOAD_DELAY_MS = 10_000; // 10 seconds grace period for panel recovery

  // Log roster changes and auto-unload when channel is empty
  client.onRoster((roster) => {
    const names = Object.values(roster.participants).map(p => `${p.metadata.name} (${p.metadata.type})`);
    log(`Roster updated: ${names.join(", ")}`);

    // Check if there are any panels (users) left in the channel
    // If only agent workers remain (no panels), unload this worker to free resources
    const hasPanels = Object.values(roster.participants).some(p => p.metadata.type === "panel");
    const participantCount = Object.keys(roster.participants).length;

    // If no panels and more than just ourselves, it means only workers remain
    // If only we remain or no panels, schedule unload after delay
    if (!hasPanels && participantCount <= 1) {
      // Only schedule if not already pending
      if (!unloadTimeoutId) {
        log(`No panels in channel, scheduling unload in ${UNLOAD_DELAY_MS / 1000}s...`);
        unloadTimeoutId = setTimeout(() => {
          log(`Unload timeout reached, unloading worker to conserve resources...`);
          // Gracefully close and unload
          void client.close().then(() => {
            void unloadSelf();
          });
        }, UNLOAD_DELAY_MS);
      }
    } else if (hasPanels && unloadTimeoutId) {
      // Panel rejoined - cancel pending unload
      log(`Panel rejoined, canceling scheduled unload`);
      clearTimeout(unloadTimeoutId);
      unloadTimeoutId = null;
    }
  });

  log(`Connected to channel: ${channelName}`);

  // Initialize settings with proper precedence:
  // 1. Apply initialization config (from stateArgs passed at spawn time)
  const initConfigSettings: FastAiWorkerSettings = {};
  if (stateArgs.modelRole) initConfigSettings.modelRole = stateArgs.modelRole;
  if (stateArgs.temperature !== undefined) initConfigSettings.temperature = stateArgs.temperature;
  if (stateArgs.maxOutputTokens !== undefined) initConfigSettings.maxOutputTokens = stateArgs.maxOutputTokens;
  if (stateArgs.autonomyLevel !== undefined) initConfigSettings.autonomyLevel = stateArgs.autonomyLevel;
  if (stateArgs.maxSteps !== undefined) initConfigSettings.maxSteps = stateArgs.maxSteps;
  if (stateArgs.thinkingBudget !== undefined) initConfigSettings.thinkingBudget = stateArgs.thinkingBudget;
  Object.assign(currentSettings, initConfigSettings);
  if (Object.keys(initConfigSettings).length > 0) {
    log(`Applied init config: ${JSON.stringify(initConfigSettings)}`);
  }

  // 2. Apply persisted settings (runtime changes from previous sessions)
  if (client.sessionKey) {
    log(`Session: ${client.sessionKey} (${client.status})`);
    log(`Checkpoint: ${client.checkpoint ?? "none"}`);

    try {
      const savedSettings = await client.getSettings<FastAiWorkerSettings>();
      if (savedSettings) {
        Object.assign(currentSettings, savedSettings);
        log(`Applied persisted settings: ${JSON.stringify(savedSettings)}`);
      }
    } catch (err) {
      log(`Failed to load settings: ${err}`);
    }
  }

  if (Object.keys(currentSettings).length > 0) {
    log(`Final settings: ${JSON.stringify(currentSettings)}`);
  }

  let lastMissedPubsubId = 0;
  const buildMissedContext = () => {
    const missed = client.missedMessages.filter((event) => event.pubsubId > lastMissedPubsubId);
    if (missed.length === 0) return null;
    return formatMissedContext(missed, { maxChars: 8000 });
  };

  let pendingMissedContext = buildMissedContext();

  client.onReconnect(() => {
    pendingMissedContext = buildMissedContext();
  });

  // Process incoming events using unified API
  for await (const event of client.events({ targetedOnly: true, respondWhenSolo: true })) {
    if (event.type !== "message") continue;

    // Skip replay messages - don't respond to historical messages
    if (event.kind === "replay") continue;

    // Skip typing indicators - these are just presence notifications
    const contentType = (event as { contentType?: string }).contentType;
    if (contentType === CONTENT_TYPE_TYPING) continue;

    const sender = client.roster[event.senderId];

    // Only respond to messages from panels (not our own or other workers)
    if (sender?.metadata.type === "panel" && event.senderId !== id) {
      let prompt = event.content;
      if (pendingMissedContext && pendingMissedContext.count > 0) {
        prompt = `<missed_context>\n${pendingMissedContext.formatted}\n</missed_context>\n\n${prompt}`;
        lastMissedPubsubId = pendingMissedContext.lastPubsubId;
        pendingMissedContext = null;
      }
      // Extract attachments from the event
      const attachments = (event as { attachments?: Attachment[] }).attachments;
      await handleUserMessage(client, event, prompt, attachments);
    }
  }
}

async function handleUserMessage(
  client: AgenticClient<ChatParticipantMetadata>,
  incoming: IncomingNewMessage,
  prompt: string,
  attachments?: Attachment[]
) {
  log(`Received message: ${incoming.content}`);

  // Process image attachments if present
  const imageAttachments = filterImageAttachments(attachments);
  if (imageAttachments.length > 0) {
    // Validate attachments
    const validation = validateAttachments(imageAttachments);
    if (!validation.valid) {
      log(`Attachment validation failed: ${validation.error}`);
      // Still proceed but warn - don't block the message
    }
    log(`Processing ${imageAttachments.length} image attachment(s)`);
  }

  // Find the panel participant for tool approval UI
  const panel = Object.values(client.roster).find((p) => p.metadata.type === "panel");

  // Create typing tracker for ephemeral typing indicator
  // Typing indicators use persist: false so they don't pollute history on reload
  const typing = createTypingTracker({
    client,
    log,
    replyTo: incoming.id,
    senderInfo: {
      senderId: client.clientId ?? "",
      senderName: "AI Responder",
      senderType: "ai-responder",
    },
  });

  // Start typing indicator immediately
  await typing.startTyping("preparing response");

  // Lazy message creation - only create actual message when we have content
  let responseId: string | null = null;
  const ensureResponseMessage = async (): Promise<string> => {
    if (typing.isTyping()) {
      await typing.stopTyping();
    }
    if (!responseId) {
      const { messageId } = await client.send("", { replyTo: incoming.id });
      responseId = messageId;
    }
    return responseId;
  };

  // Create thinking tracker for managing reasoning message state
  // Defined before try block so cleanup can be called in catch
  const thinking = createThinkingTracker({ client, log });

  // Set up interrupt handler to monitor for pause requests
  const interruptHandler = createInterruptHandler({
    client,
    messageId: incoming.id,
    onPause: (reason) => {
      log(`Pause RPC received: ${reason}`);
    }
  });

  // Start monitoring for pause events in background
  void interruptHandler.monitor();

  try {
    // Build conversation history from pubsub replay (already available via missedMessages)
    const conversationHistory = client.getConversationHistory();
    if (conversationHistory.length > 0) {
      log(`Loaded ${conversationHistory.length} previous messages from replay`);
    }

    // Discover tools from channel participants
    const { definitions: toolDefs, execute: executeTool } = createToolsForAgentSDK(client, {
      namePrefix: "pubsub",
      // Filter out tools from ourselves and menu-only methods
      filter: (method) => method.providerId !== client.clientId && !method.menu,
    });

    const autonomyLevel = currentSettings.autonomyLevel ?? 0;

    // Build tools object for AI SDK
    // Use canonical tool names (Read, Write, Edit, etc.) for LLM familiarity
    // This responder is always "restricted" (no built-in tools), so canonical names are appropriate
    const tools: Record<string, ToolDefinition> = {};
    const toolNameToOriginal: Record<string, string> = {}; // Map canonical -> original for execution

    for (const def of toolDefs) {
      // Get canonical name for display (e.g., "Read" instead of "pubsub_abc123_file_read")
      const originalMethodName = (def as { originalMethodName?: string }).originalMethodName ?? def.name;
      const canonicalName = getCanonicalToolName(originalMethodName);

      const requiresApproval = needsApprovalForTool(def.name, autonomyLevel);

      // Store mapping for execution
      toolNameToOriginal[canonicalName] = def.name;

      tools[canonicalName] = {
        description: def.description,
        parameters: def.parameters,
        // If tool requires approval, don't include execute - we'll handle it manually
        execute: requiresApproval ? undefined : (args) => executeTool(def.name, args),
      };
    }

    if (Object.keys(tools).length > 0) {
      log(`Discovered ${Object.keys(tools).length} tools`);
    }

    // Build initial messages array
    // For multimodal input, construct content array with images
    const userContent = imageAttachments.length > 0
      ? [
          // Add images first
          ...imageAttachments.map((a) => ({
            type: "image" as const,
            image: uint8ArrayToBase64(a.data),
            mimeType: a.mimeType,
          })),
          // Then the text prompt
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

    // Agentic loop with approval handling
    let step = 0;
    const maxSteps = currentSettings.maxSteps ?? 5;
    let assistantResponse = "";
    let checkpointCommitted = false;

    while (step < maxSteps) {
      // Check for interruption before each step
      if (interruptHandler.isPaused()) {
        log("Execution paused before step");
        break;
      }

      const stream = ai.streamText({
        model: currentSettings.modelRole ?? "fast",
        // Use restricted mode system prompt (this responder has no built-in tools)
        system: createRestrictedModeSystemPrompt(),
        messages,
        tools: Object.keys(tools).length > 0 ? tools : undefined,
        maxSteps: 1, // One step at a time for approval control
        maxOutputTokens: currentSettings.maxOutputTokens ?? 1024,
        ...(currentSettings.temperature !== undefined && { temperature: currentSettings.temperature }),
        ...(currentSettings.thinkingBudget && currentSettings.thinkingBudget > 0 && {
          thinking: { type: "enabled" as const, budgetTokens: currentSettings.thinkingBudget },
        }),
      });

      // Track ALL tool calls and results for message history
      const allToolCalls: Array<{ toolCallId: string; toolName: string; args: unknown }> = [];
      const autoToolResults: ToolResultPart[] = [];
      const pendingApprovals: Array<{ toolCallId: string; toolName: string; args: unknown }> = [];
      let finishReason: string = "stop";

      for await (const event of stream) {
        // Check if pause was requested
        if (interruptHandler.isPaused()) {
          log("Execution paused, stopping stream");
          finishReason = "interrupted";
          break;
        }

        switch (event.type) {
          case "reasoning-start":
            // Start a new message for thinking content
            await thinking.startThinking();
            break;

          case "reasoning-delta":
            // Stream reasoning content to thinking message
            if (event.text) {
              await thinking.updateThinking(event.text);
            }
            break;

          case "reasoning-end":
            // Complete the thinking message
            await thinking.endThinking();
            break;

          case "text-delta": {
            const msgId = await ensureResponseMessage();
            assistantResponse += event.text;
            await client.update(msgId, event.text);

            if (!checkpointCommitted && incoming.pubsubId !== undefined && client.sessionKey) {
              await client.commitCheckpoint(incoming.pubsubId);
              checkpointCommitted = true;
            }
            break;
          }

          case "tool-call": {
            // Track all tool calls for message history
            allToolCalls.push({
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              args: event.args,
            });

            // Check if this tool needs approval (no execute function means it needs approval)
            const toolDef = tools[event.toolName];
            if (toolDef && !toolDef.execute) {
              // Tool needs approval - collect for batch approval
              pendingApprovals.push({
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                args: event.args as Record<string, unknown>,
              });
            }
            log(`Tool call: ${event.toolName}${toolDef?.execute ? " (auto)" : " (needs approval)"}`);
            break;
          }

          case "tool-result":
            // Capture auto-executed tool results for message history
            autoToolResults.push({
              type: "tool-result",
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              result: event.result,
              isError: event.isError,
            });
            log(`Tool result: ${event.toolName}${event.isError ? " (error)" : ""}`);
            break;

          case "step-finish":
            finishReason = event.finishReason;
            break;
        }
      }

      // Process pending approvals
      const approvalResults: ToolResultPart[] = [];
      if (pendingApprovals.length > 0) {
        for (const approval of pendingApprovals) {
          let approved = false;

          if (panel) {
            // Request approval from user via panel UI
            approved = await requestToolApproval(
              client,
              panel.id,
              approval.toolName,
              approval.args as Record<string, unknown>,
              { signal: interruptHandler.isPaused() ? AbortSignal.abort() : undefined }
            );
          } else {
            // No panel available - deny all approvals
            log(`Warning: No panel found for tool approval, denying ${approval.toolName}`);
          }

          if (approved) {
            try {
              // Use original prefixed name for execution
              const originalName = toolNameToOriginal[approval.toolName] ?? approval.toolName;
              const result = await executeTool(originalName, approval.args);
              approvalResults.push({
                type: "tool-result",
                toolCallId: approval.toolCallId,
                toolName: approval.toolName,
                result,
              });
              log(`Tool ${approval.toolName} approved and executed`);
            } catch (err) {
              approvalResults.push({
                type: "tool-result",
                toolCallId: approval.toolCallId,
                toolName: approval.toolName,
                result: `Error: ${err instanceof Error ? err.message : String(err)}`,
                isError: true,
              });
              log(`Tool ${approval.toolName} execution failed: ${err}`);
            }
          } else {
            approvalResults.push({
              type: "tool-result",
              toolCallId: approval.toolCallId,
              toolName: approval.toolName,
              result: panel ? "User denied permission to execute this tool" : "No approval UI available",
              isError: true,
            });
            log(`Tool ${approval.toolName} denied${panel ? " by user" : " (no panel)"}`);
          }
        }
      }

      // Add all tool calls and results to messages for next iteration
      // This includes both auto-executed tools and approval-processed tools
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

      // Check if we should continue the loop
      if (finishReason === "stop" || finishReason === "interrupted" || finishReason === "length") {
        break;
      }

      // Continuing to next step - complete current message and start a new one
      // This creates natural turn boundaries in the chat
      if (responseId) {
        await client.complete(responseId);
      }
      const { messageId: newResponseId } = await client.send("");
      responseId = newResponseId;
      log(`Started new message for step ${step + 1}: ${responseId}`);

      step++;
    }

    // No need to store assistant response - it's already in pubsub via send/update

    if (!checkpointCommitted && incoming.pubsubId !== undefined && client.sessionKey) {
      await client.commitCheckpoint(incoming.pubsubId);
    }

    // Mark message as complete (if we created one)
    if (responseId) {
      await client.complete(responseId);
      log(`Completed response for ${incoming.id}`);
    } else {
      // No response was created - stop typing indicator if still active
      await typing.cleanup();
      log(`No response content for ${incoming.id}`);
    }

  } catch (err) {
    // Cleanup any pending thinking/typing messages to avoid orphaned messages
    await thinking.cleanup();
    await typing.cleanup();

    // Pause tool returns successfully, so we shouldn't see pause-related errors
    // Any error here is a real error that should be reported
    console.error(`[Worker] AI error:`, err);

    // Create error message - either on existing response or create new one
    const errorMsgId = responseId ?? (await client.send("", { replyTo: incoming.id })).messageId;
    await client.error(errorMsgId, err instanceof Error ? err.message : String(err));
  }
}

// Start the worker
void main();
