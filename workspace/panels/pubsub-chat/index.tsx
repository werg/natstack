/**
 * Agentic Messaging Chat Demo Panel
 *
 * Demonstrates @natstack/agentic-messaging with the broker discovery system.
 * Uses connectForDiscovery to find available agents and invite them to a dynamic channel.
 */

import { useState, useEffect, useRef, useCallback, useMemo, type ComponentType } from "react";
import { Flex, Text } from "@radix-ui/themes";
import { pubsubConfig, id as clientId } from "@natstack/runtime";
import { usePanelTheme } from "@natstack/react";
import { z } from "zod";
import {
  connect,
  type AgenticClient,
  type AgenticParticipantMetadata,
  type IncomingMessage,
  type Participant,
  type RosterUpdate,
  type ToolDefinition,
  type ToolExecutionContext,
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
  type FeedbackComponentProps,
  type FeedbackUiToolArgs,
} from "./eval/feedbackUiTool";
import { useDiscovery } from "./hooks/useDiscovery";
import { useToolHistory, type ChatMessage } from "./hooks/useToolHistory";
import type { ToolHistoryEntry } from "./components/ToolHistoryItem";
import { AgentSetupPhase } from "./components/AgentSetupPhase";
import { ChatPhase, type ActiveFeedback } from "./components/ChatPhase";

/** Metadata for participants in this channel */
interface ChatParticipantMetadata extends AgenticParticipantMetadata {
  name: string;
  type: "panel" | "ai-responder" | "claude-code" | "codex";
}

type AppPhase = "setup" | "connecting" | "chat";

export default function AgenticChatDemo() {
  const theme = usePanelTheme();
  const workspaceRoot = process.env["NATSTACK_WORKSPACE"]?.trim();
  const [phase, setPhase] = useState<AppPhase>("setup");

  // Chat phase state
  const [channelId, setChannelId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState("Initializing...");
  const [participants, setParticipants] = useState<Record<string, Participant<ChatParticipantMetadata>>>({});
  const [activeFeedbacks, setActiveFeedbacks] = useState<Map<string, ActiveFeedback>>(new Map());

  const clientRef = useRef<AgenticClient<ChatParticipantMetadata> | null>(null);
  const activeFeedbacksRef = useRef(activeFeedbacks);
  const toolAnyCallUnsubRef = useRef<(() => void) | null>(null);
  const toolResultUnsubRef = useRef<(() => void) | null>(null);

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
  } = useToolHistory({ setMessages, clientId });

  // Feedback management
  const addFeedback = useCallback((feedback: ActiveFeedback) => {
    setActiveFeedbacks((prev) => new Map(prev).set(feedback.callId, feedback));
  }, []);

  const removeFeedback = useCallback((callId: string) => {
    setActiveFeedbacks((prev) => {
      const next = new Map(prev);
      next.delete(callId);
      return next;
    });
  }, []);

  useEffect(() => {
    activeFeedbacksRef.current = activeFeedbacks;
  }, [activeFeedbacks]);

  useEffect(() => {
    return () => {
      for (const feedback of activeFeedbacksRef.current.values()) {
        feedback.reject(new Error("Panel closed"));
      }
    };
  }, []);

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
    const feedback = activeFeedbacksRef.current.get(callId);
    if (feedback) {
      feedback.reject(new Error("User dismissed feedback UI"));
    }
  }, []);

  const handleFeedbackError = useCallback((callId: string, error: Error) => {
    const feedback = activeFeedbacksRef.current.get(callId);
    if (feedback) {
      feedback.reject(new Error(`Component render error: ${error.message}`));
    }
  }, []);

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

    // Generate unique channel ID
    const newChannelId = `chat-${crypto.randomUUID().slice(0, 8)}`;
    setChannelId(newChannelId);

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
          const result = discovery.invite(agent.broker.brokerId, agent.agentType.id, newChannelId, {
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

      // Connect to the work channel
      const client = connect<ChatParticipantMetadata>(pubsubConfig.serverUrl, pubsubConfig.token, {
        channel: newChannelId,
        reconnect: true,
        clientId,
        metadata: {
          name: "Chat Panel",
          type: "panel",
        },
        tools: {
          eval: evalToolDef,
          feedback_ui: feedbackUiToolDef,
        },
      });

      clientRef.current = client;
      toolAnyCallUnsubRef.current?.();
      toolResultUnsubRef.current?.();

      // Subscribe to tool calls for remote tools only (locally handled tools
      // add their own entries in their execute functions to set handledLocally: true)
      toolAnyCallUnsubRef.current = client.onAnyToolCall((call) => {
        // Skip if this is a locally handled tool - its execute function will add the entry
        // We use clientId from @natstack/runtime which matches the client's selfId
        if (call.providerId === clientId) {
          return;
        }
        addToolHistoryEntry({
          callId: call.callId,
          toolName: call.toolName,
          args: call.args,
          status: "pending",
          startedAt: call.ts ?? Date.now(),
          providerId: call.providerId,
          callerId: call.senderId,
          handledLocally: false,
        });
      });

      toolResultUnsubRef.current = client.onToolResult(handleToolResult);

      // Set up roster handler
      client.onRoster((roster: RosterUpdate<ChatParticipantMetadata>) => {
        setParticipants(roster.participants);
      });

      await client.ready();
      setConnected(true);
      setStatus("Connected");
      setPhase("chat");

      // Listen for messages
      void (async () => {
        for await (const msg of client.messages()) {
          handleMessage(msg);
        }
      })();
    } catch (err) {
      setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
      setPhase("setup");
    }
  }, [
    availableAgents,
    buildInviteConfig,
    handleFeedbackUiToolCall,
    evalToolDef,
    addToolHistoryEntry,
    handleToolResult,
    discoveryRef,
  ]);

  const addAgent = useCallback(async () => {
    const discovery = discoveryRef.current;
    if (!discovery || !channelId) return;

    // Find agents not currently in the chat
    const notInChat = availableAgents.filter(
      (a) => !Object.values(participants).some((p) => p.metadata.type === a.agentType.id)
    );

    if (notInChat.length === 0) {
      return;
    }

    // Invite first available agent not in chat
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

  function handleMessage(msg: IncomingMessage) {
    switch (msg.type) {
      case "message": {
        setMessages((prev) => {
          const existingIndex = prev.findIndex((m) => m.id === msg.id && m.pending);
          if (existingIndex !== -1) {
            return prev.map((m, i) => (i === existingIndex ? { ...m, pending: false } : m));
          }
          return [
            ...prev,
            {
              id: msg.id,
              senderId: msg.senderId,
              content: msg.content,
              replyTo: msg.replyTo,
              kind: "message",
            },
          ];
        });
        break;
      }

      case "update-message": {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === msg.id
              ? {
                  ...m,
                  content: msg.content !== undefined ? m.content + msg.content : m.content,
                  complete: msg.complete ?? m.complete,
                }
              : m
          )
        );
        break;
      }

      case "error": {
        setMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, complete: true, error: msg.error } : m)));
        break;
      }
    }
  }

  const reset = useCallback(() => {
    setPhase("setup");
    setMessages([]);
    setInput("");
    setConnected(false);
    setStatus("Initializing...");
    setParticipants({});
    setChannelId(null);
    clearToolHistory();
    toolAnyCallUnsubRef.current?.();
    toolAnyCallUnsubRef.current = null;
    toolResultUnsubRef.current?.();
    toolResultUnsubRef.current = null;
    clientRef.current?.close();
    clientRef.current = null;
  }, [clearToolHistory]);

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
          senderId: clientId,
          content: text,
          complete: true,
          pending: true,
          kind: "message",
        },
      ];
    });
  }, [input]);

  // Setup phase - show agent discovery and selection
  if (phase === "setup") {
    return (
      <AgentSetupPhase
        discoveryStatus={discoveryStatus}
        availableAgents={availableAgents}
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
      participants={participants}
      activeFeedbacks={activeFeedbacks}
      theme={theme}
      onInputChange={setInput}
      onSendMessage={sendMessage}
      onAddAgent={() => void addAgent()}
      onReset={reset}
      onFeedbackDismiss={handleFeedbackDismiss}
      onFeedbackError={handleFeedbackError}
    />
  );
}
