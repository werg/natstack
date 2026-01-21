/**
 * Agentic Chat Panel
 *
 * Full chat interface that connects to a channel via CHANNEL_NAME env arg.
 * Provides file, git, search, and eval tools to agents.
 */

import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { Flex, Text, Button, Card } from "@radix-ui/themes";
import { pubsubConfig, id as panelClientId, buildNsLink, createChild } from "@natstack/runtime";
import { usePanelTheme } from "@natstack/react";
import { z } from "zod";
import {
  type IncomingEvent,
  type IncomingToolRoleRequestEvent,
  type IncomingToolRoleResponseEvent,
  type IncomingToolRoleHandoffEvent,
  type Participant,
  type MethodDefinition,
  type MethodExecutionContext,
  type Attachment,
  type AttachmentInput,
  CONTENT_TYPE_TYPING,
  type TypingData,
} from "@natstack/agentic-messaging";
import {
  type FeedbackFormArgs,
  type FeedbackCustomArgs,
  FeedbackFormArgsSchema,
  FeedbackCustomArgsSchema,
} from "@natstack/agentic-messaging/broker";
import {
  useFeedbackManager,
  useToolApproval,
  wrapMethodsWithApproval,
  compileFeedbackComponent,
  cleanupFeedbackComponent,
  type FeedbackResult,
  type FeedbackUiToolArgs,
  type ActiveFeedback,
  type ActiveFeedbackTsx,
  type ActiveFeedbackSchema,
} from "@natstack/tool-ui";
import {
  executeEvalTool,
  EVAL_DEFAULT_TIMEOUT_MS,
  EVAL_MAX_TIMEOUT_MS,
  EVAL_FRAMEWORK_TIMEOUT_MS,
} from "./eval/evalTool";
import { createAllToolMethodDefinitions } from "./tools";
import { useChannelConnection } from "./hooks/useChannelConnection";
import { useMethodHistory, type ChatMessage } from "./hooks/useMethodHistory";
import { useToolRole } from "./hooks/useToolRole";
import type { MethodHistoryEntry } from "./components/MethodHistoryItem";
import { ToolRoleConflictModal } from "./components/ToolRoleConflictModal";
import { ChatPhase } from "./components/ChatPhase";
import type { PendingImage } from "./components/ImageInput";
import { cleanupPendingImages } from "./utils/imageUtils";
import type { ChatParticipantMetadata } from "./types";

/** Utility to check if a value looks like ChatParticipantMetadata */
function isChatParticipantMetadata(value: unknown): value is ChatParticipantMetadata {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.name === "string" && typeof obj.type === "string" && typeof obj.handle === "string";
}

/**
 * Handles incoming agentic events and updates appropriate state.
 * Pure function to keep event logic separate from component.
 */
/** Extract contentType from event (typed loosely in the SDK) */
function getEventContentType(event: IncomingEvent): string | undefined {
  return (event as { contentType?: string }).contentType;
}

/** Extract attachments from event */
function getEventAttachments(event: IncomingEvent): Attachment[] | undefined {
  return (event as { attachments?: Attachment[] }).attachments;
}

/**
 * Look up a method description from a provider's method advertisements.
 */
function getMethodDescription(
  providerId: string | undefined,
  methodName: string,
  participants: Record<string, Participant<ChatParticipantMetadata>>
): string | undefined {
  if (!providerId) return undefined;
  const provider = participants[providerId];
  if (!provider?.metadata?.methods) return undefined;
  const method = provider.metadata.methods.find((m) => m.name === methodName);
  return method?.description;
}

function dispatchAgenticEvent(
  event: IncomingEvent,
  handlers: {
    setMessages: (updater: (prev: ChatMessage[]) => ChatMessage[]) => void;
    setHistoricalParticipants: (updater: (prev: Record<string, Participant<ChatParticipantMetadata>>) => Record<string, Participant<ChatParticipantMetadata>>) => void;
    addMethodHistoryEntry: (entry: MethodHistoryEntry) => void;
    handleMethodResult: (result: { callId: string; content?: unknown; complete: boolean; isError: boolean; progress?: number }) => void;
  },
  selfId: string | null,
  participants: Record<string, Participant<ChatParticipantMetadata>>
): void {
  const isSelf = !!selfId && event.senderId === selfId;
  const isPanelSender = event.senderMetadata?.type === "panel" || isSelf;
  switch (event.type) {
    case "message": {
      handlers.setMessages((prev) => {
        const existingIndex = prev.findIndex((m) => m.id === event.id);
        if (existingIndex !== -1) {
          if (prev[existingIndex].pending) {
            const updated = {
              ...prev[existingIndex],
              pending: false,
              // Merge attachments from server (in case local didn't have them)
              attachments: getEventAttachments(event) ?? prev[existingIndex].attachments,
            };
            if (isPanelSender) {
              updated.complete = true;
            }
            return prev.map((m, i) => (i === existingIndex ? updated : m));
          }
          return prev;
        }
        return [
          ...prev,
          {
            id: event.id,
            senderId: event.senderId,
            content: event.content,
            contentType: getEventContentType(event),
            replyTo: event.replyTo,
            kind: "message",
            complete: event.kind === "replay" || isPanelSender,
            attachments: getEventAttachments(event),
          },
        ];
      });
      break;
    }

    case "update-message": {
      handlers.setMessages((prev) =>
        prev.map((m) =>
          m.id === event.id
            ? {
                ...m,
                content: event.content !== undefined ? m.content + event.content : m.content,
                contentType: getEventContentType(event) ?? m.contentType,
                complete: event.complete ?? m.complete,
              }
            : m
        )
      );
      break;
    }

    case "error": {
      handlers.setMessages((prev) => prev.map((m) => (m.id === event.id ? { ...m, complete: true, error: event.error } : m)));
      break;
    }

    case "method-call": {
      if (event.kind !== "replay" && event.providerId === selfId) {
        return;
      }
      handlers.addMethodHistoryEntry({
        callId: event.callId,
        methodName: event.methodName,
        description: getMethodDescription(event.providerId, event.methodName, participants),
        args: event.args,
        status: "pending",
        startedAt: event.ts ?? Date.now(),
        providerId: event.providerId,
        callerId: event.senderId,
        handledLocally: false,
      });
      break;
    }

    case "method-result": {
      handlers.handleMethodResult({
        callId: event.callId,
        content: event.content,
        complete: event.complete,
        isError: event.isError,
        progress: event.progress,
      });
      break;
    }

    case "presence": {
      if (event.action === "join" && isChatParticipantMetadata(event.metadata)) {
        handlers.setHistoricalParticipants((prev) => ({
          ...prev,
          [event.senderId]: {
            id: event.senderId,
            metadata: event.metadata as ChatParticipantMetadata,
          },
        }));
      }
      break;
    }

    case "execution-pause": {
      handlers.setMessages((prev) =>
        prev.map((m) =>
          m.id === event.messageId
            ? { ...m, complete: true }
            : m
        )
      );
      break;
    }
  }
}

export default function AgenticChat() {
  const theme = usePanelTheme();
  const workspaceRoot = process.env["NATSTACK_WORKSPACE"]?.trim();
  const channelName = process.env["CHANNEL_NAME"]?.trim();

  const selfIdRef = useRef<string | null>(null);
  // Track if we've already connected to prevent reconnection loops
  const hasConnectedRef = useRef(false);
  // Ref to access current participants in memoized callbacks
  const participantsRef = useRef<Record<string, Participant<ChatParticipantMetadata>>>({});
  // Refs for tool role handlers - set after toolRole hook is created
  const toolRoleHandlerRef = useRef<((event: IncomingToolRoleRequestEvent) => void) | null>(null);
  const toolRoleResponseHandlerRef = useRef<((event: IncomingToolRoleResponseEvent) => void) | null>(null);
  const toolRoleHandoffHandlerRef = useRef<((event: IncomingToolRoleHandoffEvent) => void) | null>(null);

  // Chat state
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [status, setStatus] = useState("Connecting...");
  const [participants, setParticipants] = useState<Record<string, Participant<ChatParticipantMetadata>>>({});
  // Historical participants reconstructed from presence events during replay
  const [historicalParticipants, setHistoricalParticipants] = useState<Record<string, Participant<ChatParticipantMetadata>>>({});
  // Combine historical participants (from replay) with current participants
  // Current participants take precedence over historical ones
  const allParticipants = useMemo(() => {
    return { ...historicalParticipants, ...participants };
  }, [historicalParticipants, participants]);

  // Keep participantsRef up to date for memoized callbacks
  participantsRef.current = allParticipants;

  // Use feedback manager hook for UI feedback lifecycle
  const {
    activeFeedbacks,
    addFeedback,
    removeFeedback,
    dismissFeedback,
    handleFeedbackError,
  } = useFeedbackManager();

  const {
    addMethodHistoryEntry,
    updateMethodHistoryEntry,
    handleMethodResult,
    clearMethodHistory,
  } = useMethodHistory({ setMessages, clientId: panelClientId });

  // Use channel connection hook with event handler that uses extracted helper
  const {
    clientRef,
    connected,
    clientId,
    connect: connectToChannel,
    disconnect,
  } = useChannelConnection({
    metadata: {
      name: "Chat Panel",
      type: "panel",
      handle: "user",
    },
    // Declare that this panel provides file and git tools
    toolRoles: {
      "file-ops": { providing: true },
      "git-ops": { providing: true },
    },
    onEvent: useCallback(
      (event: IncomingEvent) => {
        const selfId = selfIdRef.current ?? panelClientId;
        dispatchAgenticEvent(
          event,
          {
            setMessages,
            setHistoricalParticipants,
            addMethodHistoryEntry,
            handleMethodResult,
          },
          selfId,
          participantsRef.current
        );
        // Handle tool role events
        if (event.type === "tool-role-request") {
          toolRoleHandlerRef.current?.(event);
        }
        if (event.type === "tool-role-response") {
          toolRoleResponseHandlerRef.current?.(event);
        }
        if (event.type === "tool-role-handoff") {
          toolRoleHandoffHandlerRef.current?.(event);
        }
      },
      [
        setMessages,
        setHistoricalParticipants,
        addMethodHistoryEntry,
        handleMethodResult,
        panelClientId,
        selfIdRef,
      ]
    ),
    onRoster: useCallback((roster) => {
      setParticipants(roster.participants);
    }, []),
    onError: useCallback((error) => {
      console.error("[Chat Panel] Connection error:", error);
      setStatus(`Error: ${error.message}`);
    }, []),
  });

  useEffect(() => {
    selfIdRef.current = clientId;
  }, [clientId]);

  // Typing indicator state - tracks ephemeral typing message
  const typingMessageIdRef = useRef<string | null>(null);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const TYPING_DEBOUNCE_MS = 2000; // Stop typing after 2s of inactivity

  // Stop typing indicator
  const stopTyping = useCallback(async () => {
    // Clear timeout
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = null;
    }

    // Complete the typing message (ephemeral - not persisted)
    if (typingMessageIdRef.current && clientRef.current?.connected) {
      await clientRef.current.update(typingMessageIdRef.current, "", { complete: true, persist: false });
      typingMessageIdRef.current = null;
    }
  }, [clientRef]);

  // Start or continue typing indicator
  const startTyping = useCallback(async () => {
    const client = clientRef.current;
    if (!client?.connected) return;

    // Clear existing timeout
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
    }

    // Send typing message if not already typing
    if (!typingMessageIdRef.current) {
      const typingData: TypingData = {
        senderId: client.clientId ?? panelClientId,
        senderName: "User",
        senderType: "panel",
      };
      const { messageId } = await client.send(JSON.stringify(typingData), {
        contentType: CONTENT_TYPE_TYPING,
        persist: false, // Ephemeral - won't be saved
      });
      typingMessageIdRef.current = messageId;
    }

    // Set timeout to stop typing after inactivity
    typingTimeoutRef.current = setTimeout(() => {
      void stopTyping();
    }, TYPING_DEBOUNCE_MS);
  }, [clientRef, panelClientId, stopTyping]);

  // Handle input change with typing indicator
  const handleInputChange = useCallback((value: string) => {
    setInput(value);
    if (value.trim()) {
      void startTyping();
    } else {
      void stopTyping();
    }
  }, [startTyping, stopTyping]);

  // Tool approval hook - uses client for persistence and feedback system for UI
  const approval = useToolApproval(clientRef.current, { addFeedback, removeFeedback });

  // Tool role hook - handles conflict detection and negotiation
  const toolRole = useToolRole(clientRef.current, clientId);

  // Keep the tool role handler refs updated so onEvent can call them
  useEffect(() => {
    toolRoleHandlerRef.current = toolRole.handleToolRoleRequest;
    toolRoleResponseHandlerRef.current = toolRole.handleToolRoleResponse;
    toolRoleHandoffHandlerRef.current = toolRole.handleToolRoleHandoff;
  }, [toolRole.handleToolRoleRequest, toolRole.handleToolRoleResponse, toolRole.handleToolRoleHandoff]);

  // Refs to store latest callback versions for use in connection effect
  // This prevents the effect from re-running when callbacks change
  const handleFeedbackFormCallRef = useRef<typeof handleFeedbackFormCall | null>(null);
  const handleFeedbackCustomCallRef = useRef<typeof handleFeedbackCustomCall | null>(null);
  const evalMethodDefRef = useRef<MethodDefinition | null>(null);
  const approvalRef = useRef<typeof approval | null>(null);
  const toolRoleShouldProvideGroupRef = useRef<typeof toolRole.shouldProvideGroup | null>(null);

  // Helper to handle feedback result and update method history
  const handleFeedbackResult = useCallback((callId: string, feedbackResult: FeedbackResult) => {
    if (feedbackResult.type === "submit") {
      updateMethodHistoryEntry(callId, {
        status: "success",
        result: feedbackResult.value,
        completedAt: Date.now(),
      });
    } else if (feedbackResult.type === "cancel") {
      updateMethodHistoryEntry(callId, {
        status: "success",
        result: null,
        completedAt: Date.now(),
      });
    } else {
      // error case
      updateMethodHistoryEntry(callId, {
        status: "error",
        error: feedbackResult.message,
        completedAt: Date.now(),
      });
    }
  }, [updateMethodHistoryEntry]);

  const handleFeedbackFormCall = useCallback(
    async (callId: string, args: FeedbackFormArgs, ctx: MethodExecutionContext) => {
      const entry: MethodHistoryEntry = {
        callId,
        methodName: "feedback_form",
        description: "Display a form to collect user input",
        args,
        status: "pending",
        startedAt: Date.now(),
        callerId: ctx.callerId,
        handledLocally: true,
      };
      addMethodHistoryEntry(entry);

      return new Promise<FeedbackResult>((resolve) => {
        const feedback: ActiveFeedbackSchema = {
          type: "schema",
          callId,
          title: args.title,
          fields: args.fields,
          values: args.values ?? {},
          submitLabel: args.submitLabel,
          cancelLabel: args.cancelLabel,
          // New properties for feedback UI
          timeout: args.timeout,
          timeoutAction: args.timeoutAction,
          severity: args.severity,
          hideSubmit: args.hideSubmit,
          hideCancel: args.hideCancel,
          createdAt: Date.now(),
          complete: (feedbackResult: FeedbackResult) => {
            removeFeedback(callId);
            handleFeedbackResult(callId, feedbackResult);
            resolve(feedbackResult);
          },
        };

        addFeedback(feedback);
      });
    },
    [addFeedback, removeFeedback, addMethodHistoryEntry, handleFeedbackResult]
  );

  const handleFeedbackCustomCall = useCallback(
    async (callId: string, args: FeedbackCustomArgs, ctx: MethodExecutionContext) => {
      const entry: MethodHistoryEntry = {
        callId,
        methodName: "feedback_custom",
        description: "Display a custom React component for user interaction",
        args,
        status: "pending",
        startedAt: Date.now(),
        callerId: ctx.callerId,
        handledLocally: true,
      };
      addMethodHistoryEntry(entry);

      const result = await compileFeedbackComponent({ code: args.code } as FeedbackUiToolArgs);

      if (!result.success) {
        updateMethodHistoryEntry(callId, {
          status: "error",
          error: result.error,
          completedAt: Date.now(),
        });
        throw new Error(result.error);
      }

      const cacheKey = result.cacheKey!;

      return new Promise<FeedbackResult>((resolve) => {
        const feedback: ActiveFeedbackTsx = {
          type: "tsx",
          callId,
          Component: result.Component!,
          createdAt: Date.now(),
          cacheKey,
          complete: (feedbackResult: FeedbackResult) => {
            removeFeedback(callId);
            cleanupFeedbackComponent(cacheKey);
            handleFeedbackResult(callId, feedbackResult);
            resolve(feedbackResult);
          },
        };

        addFeedback(feedback);
      });
    },
    [addFeedback, removeFeedback, addMethodHistoryEntry, updateMethodHistoryEntry, handleFeedbackResult]
  );

  const handleFeedbackDismiss = useCallback((callId: string) => {
    dismissFeedback(callId);
  }, [dismissFeedback]);

  const evalMethodDef = useMemo<MethodDefinition>(
    () => ({
      description: `Execute TypeScript/JavaScript code for side-effects.

Console output is streamed in real-time as code executes.
Async operations (fetch, await, etc.) are automatically awaited.
Top-level await is supported.

Use standard ESM imports - they're transformed to require() automatically:
- import { useState } from "react"
- import { Button } from "@radix-ui/themes"`,
      parameters: z.object({
        code: z.string().describe("The TypeScript/JavaScript code to execute"),
        syntax: z
          .enum(["typescript", "jsx", "tsx"])
          .default("tsx")
          .describe("Target syntax"),
        timeout: z
          .number()
          .default(EVAL_DEFAULT_TIMEOUT_MS)
          .describe(`Timeout in ms for async operations (default: ${EVAL_DEFAULT_TIMEOUT_MS}, max: ${EVAL_MAX_TIMEOUT_MS}). Set to 0 to skip async waiting.`),
      }),
      streaming: true,
      // Framework safety net - should never fire in normal operation
      timeout: EVAL_FRAMEWORK_TIMEOUT_MS,
      execute: async (args, ctx) => {
        const entry: MethodHistoryEntry = {
          callId: ctx.callId,
          methodName: "eval",
          description: "Execute TypeScript/JavaScript code with console streaming",
          args,
          status: "pending",
          startedAt: Date.now(),
          callerId: ctx.callerId,
          handledLocally: true,
        };
        addMethodHistoryEntry(entry);

        let consoleBuffer = "";
        let lastFlush = 0;
        const flushConsole = (force = false) => {
          const now = Date.now();
          if (!force && now - lastFlush < 200) return;
          lastFlush = now;
          updateMethodHistoryEntry(ctx.callId, { consoleOutput: consoleBuffer });
        };

        try {
          const result = await executeEvalTool(args, ctx, {
            onConsoleEntry: (formatted) => {
              consoleBuffer = consoleBuffer ? `${consoleBuffer}\n${formatted}` : formatted;
              flushConsole();
            },
          });
          if (!result.success) {
            if (result.consoleOutput) {
              consoleBuffer = result.consoleOutput;
            }
            flushConsole(true);
            updateMethodHistoryEntry(ctx.callId, {
              status: "error",
              error: result.error || "Eval failed",
              consoleOutput: consoleBuffer,
              completedAt: Date.now(),
            });
            throw new Error(result.error || "Eval failed");
          }
          const payload = {
            consoleOutput: result.consoleOutput || "(no output)",
            returnValue: result.returnValue,
          };
          consoleBuffer = payload.consoleOutput;
          flushConsole(true);
          updateMethodHistoryEntry(ctx.callId, {
            status: "success",
            result: payload,
            consoleOutput: payload.consoleOutput,
            completedAt: Date.now(),
          });
          return payload;
        } catch (err) {
          flushConsole(true);
          updateMethodHistoryEntry(ctx.callId, {
            status: "error",
            error: err instanceof Error ? err.message : String(err),
            consoleOutput: consoleBuffer,
            completedAt: Date.now(),
          });
          throw err;
        }
      },
    }),
    [addMethodHistoryEntry, updateMethodHistoryEntry]
  );

  // Keep callback refs updated so connection effect uses latest versions
  useEffect(() => {
    handleFeedbackFormCallRef.current = handleFeedbackFormCall;
    handleFeedbackCustomCallRef.current = handleFeedbackCustomCall;
    evalMethodDefRef.current = evalMethodDef;
    approvalRef.current = approval;
    toolRoleShouldProvideGroupRef.current = toolRole.shouldProvideGroup;
  }, [handleFeedbackFormCall, handleFeedbackCustomCall, evalMethodDef, approval, toolRole.shouldProvideGroup]);

  // Connect to channel on mount (only once)
  useEffect(() => {
    if (!channelName || !pubsubConfig) return;
    // Prevent reconnection if already connected
    if (hasConnectedRef.current) return;
    hasConnectedRef.current = true;

    async function connect() {
      try {
        const feedbackFormMethodDef: MethodDefinition = {
          description: `Show a form to collect user input.

**Result:** \`{ type: "submit", value: { fieldKey: userValue, ... } }\` or \`{ type: "cancel" }\`

**Example:**
\`\`\`json
{ "title": "Confirm", "fields": [{ "key": "reason", "label": "Reason", "type": "string" }] }
\`\`\`

**Field types:** string, number, boolean, select (needs \`options\`), slider (\`min\`/\`max\`), segmented (\`options\`)
**Field props:** \`key\` (required), \`label\` (required), \`type\` (required), \`default\`, \`required\`, \`description\`
**Pre-populate:** Add \`values: { "key": "existing value" }\``,
          parameters: FeedbackFormArgsSchema,
          // Use ref to get latest callback version
          execute: async (args, ctx) => handleFeedbackFormCallRef.current!(ctx.callId, args as FeedbackFormArgs, ctx),
        };

        const feedbackCustomMethodDef: MethodDefinition = {
          description: `Show a custom React UI. For advanced cases only - prefer feedback_form for standard forms.

**Result:** \`{ type: "submit", value: ... }\` or \`{ type: "cancel" }\`

Component receives \`onSubmit(value)\`, \`onCancel()\`, \`onError(msg)\` props.
Available: \`@radix-ui/themes\`, \`@radix-ui/react-icons\`, \`react\``,
          parameters: FeedbackCustomArgsSchema,
          // Use ref to get latest callback version
          execute: async (args, ctx) => handleFeedbackCustomCallRef.current!(ctx.callId, args as FeedbackCustomArgs, ctx),
        };

        // Create file/search/git tools using workspace root
        // Wrap diagnostics publishing to use clientRef at runtime
        const diagnosticsPublisher = (eventType: string, payload: unknown) => {
          clientRef.current?.pubsub.publish(eventType, payload);
        };
        const fileTools = createAllToolMethodDefinitions({
          workspaceRoot,
          diagnosticsPublisher,
        });

        // Wrap tools with approval middleware
        // Use refs for runtime lookup to avoid stale closure issues
        const approvedTools = wrapMethodsWithApproval(
          fileTools,
          {
            isAgentGranted: (...args) => approvalRef.current!.isAgentGranted(...args),
            checkToolApproval: (...args) => approvalRef.current!.checkToolApproval(...args),
            requestApproval: (...args) => approvalRef.current!.requestApproval(...args),
          },
          (agentId) => clientRef.current?.roster[agentId]?.metadata.name ?? agentId,
          // Use getter pattern with ref to avoid stale closure
          () => ({ shouldProvideGroup: toolRoleShouldProvideGroupRef.current! })
        );

        // Connect using the hook with all methods
        // Use ref for evalMethodDef to get latest version
        await connectToChannel(channelName, {
          eval: evalMethodDefRef.current!,
          feedback_form: feedbackFormMethodDef,
          feedback_custom: feedbackCustomMethodDef,
          ...approvedTools,
        });

        setStatus("Connected");
      } catch (err) {
        setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
        hasConnectedRef.current = false; // Allow retry on error
      }
    }

    void connect();
  // Minimal dependencies - use refs for callbacks to prevent reconnection loops
  }, [
    channelName,
    connectToChannel,
    workspaceRoot,
  ]);

  // Navigate to chat-launcher for new conversation
  const handleNewConversation = useCallback(() => {
    const launcherUrl = buildNsLink("panels/chat-launcher", {
      action: "navigate",
    });
    window.location.href = launcherUrl;
  }, []);

  // Launch chat-launcher as ephemeral child to add agents to current channel
  const handleAddAgent = useCallback(async () => {
    if (!channelName) return;
    await createChild("panels/chat-launcher", {
      name: "add-agent",
      ephemeral: true,
      focus: true,
      env: { CHANNEL_NAME: channelName },
    });
  }, [channelName]);

  const reset = useCallback(() => {
    setMessages([]);
    setInput("");
    // Cleanup pending images
    cleanupPendingImages(pendingImages);
    setPendingImages([]);
    setParticipants({});
    setHistoricalParticipants({});
    clearMethodHistory();
    // Dismiss all active feedbacks (completes them with "cancel")
    // This includes pending tool approvals which now use the feedback system
    for (const callId of activeFeedbacks.keys()) {
      dismissFeedback(callId);
    }
    // Navigate to chat-launcher
    handleNewConversation();
  }, [clearMethodHistory, activeFeedbacks, dismissFeedback, pendingImages, handleNewConversation]);

  const sendMessage = useCallback(async (attachments?: AttachmentInput[]): Promise<void> => {
    const hasText = input.trim().length > 0;
    const hasAttachments = attachments && attachments.length > 0;
    if ((!hasText && !hasAttachments) || !clientRef.current?.connected) return;

    // Stop typing indicator before sending
    await stopTyping();

    const text = input.trim();
    setInput("");

    const { messageId } = await clientRef.current.send(text || "", {
      attachments: hasAttachments ? attachments : undefined,
    });
    const selfId = clientRef.current.clientId ?? panelClientId;

    setMessages((prev) => {
      if (prev.some((m) => m.id === messageId)) return prev;
      return [
        ...prev,
        {
          id: messageId,
          senderId: selfId,
          content: text,
          complete: true,
          pending: true,
          kind: "message",
          // Note: Don't store attachments in optimistic message - they don't have server IDs yet.
          // The server will broadcast back the message with proper attachment IDs.
        },
      ];
    });
  }, [input, panelClientId, clientRef, stopTyping]);

  const handleInterruptAgent = useCallback(
    async (agentId: string, _messageId?: string) => {
      // Note: messageId is optional and unused - we interrupt the agent, not a specific message
      if (!clientRef.current) return;
      try {
        // Call pause method via RPC - this interrupts the agent
        await clientRef.current.callMethod(agentId, "pause", {
          reason: "User interrupted execution",
        }).result;
      } catch (error) {
        console.error("Failed to interrupt agent:", error);
      }
    },
    [clientRef]
  );

  const handleCallMethod = useCallback(
    (providerId: string, methodName: string, args: unknown) => {
      if (!clientRef.current) return;
      // Fire and forget - results will appear in method history if tracked
      void clientRef.current.callMethod(providerId, methodName, args).result.catch((error: unknown) => {
        console.error(`Failed to call method ${methodName} on ${providerId}:`, error);
      });
    },
    [clientRef]
  );

  // Error state: no channel name provided
  if (!channelName) {
    return (
      <Flex direction="column" align="center" justify="center" style={{ height: "100vh", padding: 16 }} gap="3">
        <Card>
          <Flex direction="column" gap="3" p="4" align="center">
            <Text size="4" weight="bold" color="red">
              Missing Channel Name
            </Text>
            <Text size="2" color="gray" style={{ textAlign: "center" }}>
              This panel requires a CHANNEL_NAME environment variable to connect to a chat channel.
            </Text>
            <Button onClick={handleNewConversation}>
              Start New Conversation
            </Button>
          </Flex>
        </Card>
      </Flex>
    );
  }

  // Chat phase
  return (
    <>
      {/* Tool role conflict modals */}
      {toolRole.pendingConflicts.map((conflict) => (
        <ToolRoleConflictModal
          key={conflict.group}
          conflict={conflict}
          onTakeOver={() => void toolRole.requestTakeOver(conflict.group)}
          onDefer={() => toolRole.acceptExisting(conflict.group)}
          onDismiss={() => toolRole.dismissConflict(conflict.group)}
          isNegotiating={toolRole.groupStates[conflict.group]?.negotiating ?? false}
        />
      ))}
      <ChatPhase
        channelId={channelName}
        connected={connected}
        status={status}
        messages={messages}
        input={input}
        pendingImages={pendingImages}
        participants={allParticipants}
        activeFeedbacks={activeFeedbacks}
        theme={theme}
        sessionEnabled={clientRef.current?.sessionEnabled}
        onInputChange={handleInputChange}
        onSendMessage={sendMessage}
        onImagesChange={setPendingImages}
        onAddAgent={handleAddAgent}
        onReset={reset}
        onFeedbackDismiss={handleFeedbackDismiss}
        onFeedbackError={handleFeedbackError}
        onInterrupt={handleInterruptAgent}
        onCallMethod={handleCallMethod}
        toolApproval={{
          settings: approval.settings,
          onSetFloor: approval.setGlobalFloor,
          onGrantAgent: approval.grantAgent,
          onRevokeAgent: approval.revokeAgent,
          onRevokeAll: approval.revokeAll,
        }}
      />
    </>
  );
}
