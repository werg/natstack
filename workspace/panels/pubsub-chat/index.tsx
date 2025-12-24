/**
 * Agentic Messaging Chat Demo Panel
 *
 * Demonstrates @natstack/agentic-messaging with the broker discovery system.
 * Uses connectForDiscovery to find available agents and invite them to a dynamic channel.
 */

import { useState, useCallback, useMemo } from "react";
import { Flex, Text } from "@radix-ui/themes";
import { pubsubConfig, id as panelClientId } from "@natstack/runtime";
import { usePanelTheme } from "@natstack/react";
import { z } from "zod";
import {
  type IncomingEvent,
  type Participant,
  type ToolDefinition,
  type ToolExecutionContext,
  createPauseToolDefinition,
} from "@natstack/agentic-messaging";
import {
  executeEvalTool,
  EVAL_DEFAULT_TIMEOUT_MS,
  EVAL_MAX_TIMEOUT_MS,
  EVAL_FRAMEWORK_TIMEOUT_MS,
} from "./eval/evalTool";
import {
  compileFeedbackComponent,
  cleanupFeedbackComponent,
  type FeedbackUiToolArgs,
} from "./eval/feedbackUiTool";
import { useDiscovery } from "./hooks/useDiscovery";
import { useChannelConnection } from "./hooks/useChannelConnection";
import { useToolHistory, type ChatMessage } from "./hooks/useToolHistory";
import { useFeedbackManager } from "./hooks/useFeedbackManager";
import type { ToolHistoryEntry } from "./components/ToolHistoryItem";
import { AgentSetupPhase } from "./components/AgentSetupPhase";
import { ChatPhase, type ActiveFeedback } from "./components/ChatPhase";
import type { ChatParticipantMetadata } from "./types";

/** Utility to check if a value looks like ChatParticipantMetadata */
function isChatParticipantMetadata(value: unknown): value is ChatParticipantMetadata {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.name === "string" && typeof obj.type === "string" && typeof obj.handle === "string";
}

type AppPhase = "setup" | "connecting" | "chat";

/**
 * Constants for the application
 */
const INITIAL_STATUS = "Initializing...";
const generateChannelId = () => `chat-${crypto.randomUUID().slice(0, 8)}`;

/**
 * Handles incoming agentic events and updates appropriate state.
 * Pure function to keep event logic separate from component.
 */
function dispatchAgenticEvent(
  event: IncomingEvent,
  handlers: {
    setMessages: (updater: (prev: ChatMessage[]) => ChatMessage[]) => void;
    setHistoricalParticipants: (updater: (prev: Record<string, Participant<ChatParticipantMetadata>>) => Record<string, Participant<ChatParticipantMetadata>>) => void;
    addToolHistoryEntry: (entry: ToolHistoryEntry) => void;
    handleToolResult: (result: { callId: string; content?: unknown; complete: boolean; isError: boolean; progress?: number }) => void;
  },
  panelClientId: string
): void {
  switch (event.type) {
    case "message": {
      handlers.setMessages((prev) => {
        const existingIndex = prev.findIndex((m) => m.id === event.id);
        if (existingIndex !== -1) {
          if (prev[existingIndex].pending) {
            return prev.map((m, i) => (i === existingIndex ? { ...m, pending: false } : m));
          }
          return prev;
        }
        return [
          ...prev,
          {
            id: event.id,
            senderId: event.senderId,
            content: event.content,
            replyTo: event.replyTo,
            kind: "message",
            complete: event.kind === "replay",
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

    case "tool-call": {
      if (event.kind !== "replay" && event.providerId === panelClientId) {
        return;
      }
      handlers.addToolHistoryEntry({
        callId: event.callId,
        toolName: event.toolName,
        args: event.args,
        status: "pending",
        startedAt: event.ts ?? Date.now(),
        providerId: event.providerId,
        callerId: event.senderId,
        handledLocally: false,
      });
      break;
    }

    case "tool-result": {
      handlers.handleToolResult({
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

export default function AgenticChatDemo() {
  const theme = usePanelTheme();
  const workspaceRoot = process.env["NATSTACK_WORKSPACE"]?.trim();
  const [phase, setPhase] = useState<AppPhase>("setup");

  // Chat phase state - generate default channel ID upfront so user can edit it
  const [channelId, setChannelId] = useState<string>(generateChannelId);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState(INITIAL_STATUS);
  const [participants, setParticipants] = useState<Record<string, Participant<ChatParticipantMetadata>>>({});
  // Historical participants reconstructed from presence events during replay
  const [historicalParticipants, setHistoricalParticipants] = useState<Record<string, Participant<ChatParticipantMetadata>>>({});
  // Combine historical participants (from replay) with current participants
  // Current participants take precedence over historical ones
  const allParticipants = useMemo(() => {
    return { ...historicalParticipants, ...participants };
  }, [historicalParticipants, participants]);

  // Use feedback manager hook for UI feedback lifecycle
  const {
    activeFeedbacks,
    addFeedback,
    removeFeedback,
    dismissFeedback,
    handleFeedbackError,
  } = useFeedbackManager();

  // Use extracted hooks
  const {
    discoveryRef,
    availableAgents,
    discoveryStatus,
    toggleAgentSelection,
    updateAgentConfig,
    buildInviteConfig,
  } = useDiscovery({ workspaceRoot });

  const {
    addToolHistoryEntry,
    updateToolHistoryEntry,
    handleToolResult,
    clearToolHistory,
  } = useToolHistory({ setMessages, clientId: panelClientId });

  // Use channel connection hook with event handler that uses extracted helper
  const {
    clientRef,
    connected,
    connect: connectToChannel,
    disconnect,
  } = useChannelConnection({
    metadata: {
      name: "Chat Panel",
      type: "panel",
      handle: "user",
    },
    onEvent: useCallback(
      (event: IncomingEvent) => {
        dispatchAgenticEvent(
          event,
          {
            setMessages,
            setHistoricalParticipants,
            addToolHistoryEntry,
            handleToolResult,
          },
          panelClientId
        );
      },
      [setMessages, setHistoricalParticipants, addToolHistoryEntry, handleToolResult, panelClientId]
    ),
    onRoster: useCallback((roster) => {
      setParticipants(roster.participants);
    }, []),
    onError: useCallback((error) => {
      console.error("[Chat Panel] Connection error:", error);
      setStatus(`Error: ${error.message}`);
    }, []),
  });


  const handleFeedbackUiToolCall = useCallback(
    async (callId: string, args: unknown, ctx: ToolExecutionContext) => {
      const entry: ToolHistoryEntry = {
        callId,
        toolName: "feedback_ui",
        args,
        status: "pending",
        startedAt: Date.now(),
        callerId: ctx.callerId,
        handledLocally: true,
      };
      addToolHistoryEntry(entry);

      const result = compileFeedbackComponent(args as FeedbackUiToolArgs);

      if (!result.success) {
        updateToolHistoryEntry(callId, {
          status: "error",
          error: result.error,
          completedAt: Date.now(),
        });
        throw new Error(result.error);
      }

      const cacheKey = result.cacheKey!;

      return new Promise((resolve, reject) => {
        const feedback: ActiveFeedback = {
          callId,
          Component: result.Component!,
          createdAt: Date.now(),
          cacheKey,
          resolve: (value) => {
            removeFeedback(callId);
            cleanupFeedbackComponent(cacheKey);
            updateToolHistoryEntry(callId, {
              status: "success",
              result: value,
              completedAt: Date.now(),
            });
            resolve(value);
          },
          reject: (error) => {
            removeFeedback(callId);
            cleanupFeedbackComponent(cacheKey);
            updateToolHistoryEntry(callId, {
              status: "error",
              error: error.message,
              completedAt: Date.now(),
            });
            reject(error);
          },
        };

        addFeedback(feedback);
      });
    },
    [addFeedback, removeFeedback, addToolHistoryEntry, updateToolHistoryEntry]
  );

  const handleFeedbackDismiss = useCallback((callId: string) => {
    dismissFeedback(callId);
  }, [dismissFeedback]);

  const evalToolDef = useMemo<ToolDefinition>(
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
        const entry: ToolHistoryEntry = {
          callId: ctx.callId,
          toolName: "eval",
          args,
          status: "pending",
          startedAt: Date.now(),
          callerId: ctx.callerId,
          handledLocally: true,
        };
        addToolHistoryEntry(entry);

        let consoleBuffer = "";
        let lastFlush = 0;
        const flushConsole = (force = false) => {
          const now = Date.now();
          if (!force && now - lastFlush < 200) return;
          lastFlush = now;
          updateToolHistoryEntry(ctx.callId, { consoleOutput: consoleBuffer });
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
            updateToolHistoryEntry(ctx.callId, {
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
          updateToolHistoryEntry(ctx.callId, {
            status: "success",
            result: payload,
            consoleOutput: payload.consoleOutput,
            completedAt: Date.now(),
          });
          return payload;
        } catch (err) {
          flushConsole(true);
          updateToolHistoryEntry(ctx.callId, {
            status: "error",
            error: err instanceof Error ? err.message : String(err),
            consoleOutput: consoleBuffer,
            completedAt: Date.now(),
          });
          throw err;
        }
      },
    }),
    [addToolHistoryEntry, updateToolHistoryEntry]
  );

  const startChat = useCallback(async () => {
    const discovery = discoveryRef.current;
    if (!discovery || !pubsubConfig) return;

    const selectedAgents = availableAgents.filter((a) => a.selected);
    if (selectedAgents.length === 0) {
      setStatus("Please select at least one agent");
      return;
    }

    // Validate required parameters before sending invites
    const validationErrors: string[] = [];
    for (const agent of selectedAgents) {
      const requiredParams = agent.agentType.parameters?.filter((p) => p.required) ?? [];
      for (const param of requiredParams) {
        const value = agent.config[param.key];
        const hasValue = value !== undefined && value !== "";
        const hasDefault = param.default !== undefined;
        if (!hasValue && !hasDefault) {
          validationErrors.push(`${agent.agentType.name}: "${param.label}" is required`);
        }
      }
    }

    if (validationErrors.length > 0) {
      setStatus(`Missing required parameters:\n${validationErrors.join("\n")}`);
      return;
    }

    setPhase("connecting");
    setStatus("Creating channel and inviting agents...");

    // Use the channel ID from state (user may have edited it)
    const targetChannelId = channelId.trim() || `chat-${crypto.randomUUID().slice(0, 8)}`;

    try {
      const feedbackUiToolDef: ToolDefinition = {
        description: `Render an interactive React component to collect user feedback.

Guidelines:
- Keep UI minimal and functional; avoid decorative styling unless required.
- Use Radix UI components with default styles; do not set custom colors/backgrounds.
- The component is already wrapped in a themed container.
- Call resolveTool(value) on success or rejectTool(error) on failure.

Write a complete component with export default that accepts props.`,
        parameters: z.object({
          code: z.string().describe("TSX code that defines a React component with export default"),
        }),
        execute: async (args, ctx) => handleFeedbackUiToolCall(ctx.callId, args, ctx),
      };

      // Invite all selected agents with their configured parameters
      const invitePromises = selectedAgents.map(async (agent) => {
        const filteredConfig = buildInviteConfig(agent);

        try {
          const result = discovery.invite(agent.broker.brokerId, agent.agentType.id, targetChannelId, {
            context: "User wants to chat",
            config: filteredConfig,
          });
          const response = await result.response;
          return { agent, response, error: null };
        } catch (err) {
          // Capture invite errors per-agent
          const errorMsg = err instanceof Error ? err.message : String(err);
          return {
            agent,
            response: null,
            error: errorMsg,
          };
        }
      });

      const results = await Promise.all(invitePromises);

      // Separate successful and failed invites
      const succeeded = results.filter((r) => r.response?.accepted);
      const declined = results.filter((r) => r.response && !r.response.accepted);
      const errored = results.filter((r) => r.error !== null);

      // Check if all invites failed
      if (succeeded.length === 0) {
        // Build detailed error message
        const errorParts: string[] = [];

        if (errored.length > 0) {
          const errorDetails = errored
            .map((r) => `${r.agent.agentType.name}: ${r.error}`)
            .join("\n");
          errorParts.push(`Invite errors:\n${errorDetails}`);
        }

        if (declined.length > 0) {
          const declineDetails = declined
            .map((r) => {
              const reason = r.response?.declineReason || "Unknown reason";
              const code = r.response?.declineCode ? ` (${r.response.declineCode})` : "";
              return `${r.agent.agentType.name}: ${reason}${code}`;
            })
            .join("\n");
          errorParts.push(`Declined:\n${declineDetails}`);
        }

        setStatus(errorParts.length > 0 ? errorParts.join("\n\n") : "All invites failed");
        setPhase("setup");
        return;
      }

      // Log partial failures but continue if at least one succeeded
      if (declined.length > 0 || errored.length > 0) {
        const failedNames = [...declined, ...errored]
          .map((r) => r.agent.agentType.name)
          .join(", ");
        console.warn(`[Chat] Some agents failed to join: ${failedNames}`);
      }

      // Connect using the hook
      await connectToChannel(targetChannelId, {
        eval: evalToolDef,
        feedback_ui: feedbackUiToolDef,
      });

      setStatus("Connected");
      setPhase("chat");
    } catch (err) {
      setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
      setPhase("setup");
    }
  }, [
    availableAgents,
    buildInviteConfig,
    handleFeedbackUiToolCall,
    evalToolDef,
    discoveryRef,
    channelId,
    connectToChannel,
  ]);

  const addAgent = useCallback(async () => {
    const discovery = discoveryRef.current;
    if (!discovery || !channelId) return;

    // Find agents not currently in the chat
    const notInChat = availableAgents.filter(
      (a) => !Object.values(participants).some((p) => p.metadata.type === a.agentType.id)
    );

    const toInvite = notInChat[0];
    if (!toInvite) return;

    try {
      const filteredConfig = buildInviteConfig(toInvite);
      const result = discovery.invite(toInvite.broker.brokerId, toInvite.agentType.id, channelId, {
        context: "User invited additional agent to chat",
        config: filteredConfig,
      });
      await result.response;
    } catch (err) {
      console.error("Failed to invite agent:", err);
    }
  }, [availableAgents, channelId, participants, buildInviteConfig, discoveryRef]);

  const reset = useCallback(() => {
    setPhase("setup");
    setMessages([]);
    setInput("");
    setStatus(INITIAL_STATUS);
    setParticipants({});
    setHistoricalParticipants({});
    // Generate a new channel ID for the next session
    setChannelId(generateChannelId());
    clearToolHistory();
    // Cleanup feedbacks via reducer - no need to capture state in dependency
    dispatchFeedback({
      type: "cleanup-all",
      payload: [], // Reducer will get current state from closure
    });
    disconnect();
  }, [clearToolHistory, disconnect]);

  const sendMessage = useCallback(async (): Promise<void> => {
    if (!input.trim() || !clientRef.current?.connected) return;

    const text = input.trim();
    setInput("");

    const messageId = await clientRef.current.send(text);

    setMessages((prev) => {
      if (prev.some((m) => m.id === messageId)) return prev;
      return [
        ...prev,
        {
          id: messageId,
          senderId: panelClientId,
          content: text,
          complete: true,
          pending: true,
          kind: "message",
        },
      ];
    });
  }, [input, panelClientId, clientRef]);

  const handleInterruptAgent = useCallback(
    async (agentId: string, messageId: string) => {
      if (!clientRef.current) return;
      try {
        // Call pause tool via RPC - this interrupts the agent
        await clientRef.current.callTool(agentId, "pause", {
          reason: "User interrupted execution",
        });
      } catch (error) {
        console.error("Failed to interrupt agent:", error);
      }
    },
    [clientRef]
  );

  // Setup phase - show agent discovery and selection
  if (phase === "setup") {
    return (
      <AgentSetupPhase
        discoveryStatus={discoveryStatus}
        availableAgents={availableAgents}
        channelId={channelId}
        onChannelIdChange={setChannelId}
        onToggleAgent={toggleAgentSelection}
        onUpdateConfig={updateAgentConfig}
        onStartChat={() => void startChat()}
      />
    );
  }

  // Connecting phase
  if (phase === "connecting") {
    return (
      <Flex direction="column" align="center" justify="center" style={{ height: "100vh", padding: 16 }} gap="3">
        <Text size="4">{status}</Text>
      </Flex>
    );
  }

  // Chat phase
  return (
    <ChatPhase
      channelId={channelId}
      connected={connected}
      status={status}
      messages={messages}
      input={input}
      participants={allParticipants}
      activeFeedbacks={activeFeedbacks}
      theme={theme}
      onInputChange={setInput}
      onSendMessage={sendMessage}
      onAddAgent={() => void addAgent()}
      onReset={reset}
      onFeedbackDismiss={handleFeedbackDismiss}
      onFeedbackError={handleFeedbackError}
      onInterrupt={handleInterruptAgent}
    />
  );
}
