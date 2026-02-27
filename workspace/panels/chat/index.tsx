/**
 * Agentic Chat Panel — Phase orchestrator
 *
 * Two phases:
 * - "setup": Agent selection and chat creation (formerly chat-launcher panel)
 * - "chat": Active chat session (AgenticChat component)
 *
 * When opened without a channelName stateArg, starts in setup phase.
 * After setup completes (or when channelName is provided), enters chat phase.
 * "New Conversation" resets to setup phase. "Add Agent" opens a centered dialog.
 */

import { pubsubConfig, id as panelClientId, buildFocusLink, useStateArgs, setStateArgs, forceRepaint, ensurePanelLoaded } from "@workspace/runtime";
import { usePanelTheme } from "@workspace/react";
import { useCallback, useMemo, useRef, useState } from "react";
import { Flex, Theme } from "@radix-ui/themes";
import { AgenticChat, ErrorBoundary } from "@workspace/agentic-chat";
import type { ConnectionConfig, AgenticChatActions, ToolProvider, ToolProviderDeps } from "@workspace/agentic-chat";
import { createAllToolMethodDefinitions, executeEvalTool, EVAL_DEFAULT_TIMEOUT_MS, EVAL_MAX_TIMEOUT_MS, EVAL_FRAMEWORK_TIMEOUT_MS } from "@workspace/agentic-tools";
import { z } from "zod";
import type { MethodDefinition } from "@workspace/agentic-messaging";
import { ChatSetup, type ChatSetupResult } from "./components/ChatSetup";
import { AddAgentDialog } from "./components/AddAgentDialog";

/** Stable metadata object — avoids creating a new object every render */
const PANEL_METADATA = { name: "Chat Panel", type: "panel" as const, handle: "user" };

/** Type for chat panel state args */
interface ChatStateArgs {
  channelName?: string;
  channelConfig?: Record<string, unknown>;
  contextId?: string;
  pendingAgents?: Array<{ agentId: string; handle: string }>;
}

export default function ChatPanel() {
  const theme = usePanelTheme();
  const stateArgs = useStateArgs<ChatStateArgs>();

  // Phase state: "setup" when no channelName, "chat" when we have one
  const initialPhase = stateArgs.channelName ? "chat" as const : "setup" as const;
  const [phase, setPhase] = useState<"setup" | "chat">(initialPhase);

  // Chat phase state — from stateArgs or from setup completion
  // contextId is optional: deep links may omit it, and the server allows undefined
  const [chatState, setChatState] = useState<{
    channelName: string;
    contextId?: string;
    pendingAgents?: Array<{ agentId: string; handle: string }>;
  } | null>(() => {
    if (stateArgs.channelName) {
      return {
        channelName: stateArgs.channelName,
        contextId: stateArgs.contextId,
        pendingAgents: stateArgs.pendingAgents,
      };
    }
    return null;
  });

  // Add Agent dialog state
  const [addAgentOpen, setAddAgentOpen] = useState(false);

  // Setup phase completion handler
  const handleSetupComplete = useCallback((result: ChatSetupResult) => {
    // Persist to SQLite so reloads go straight to chat
    void setStateArgs({
      channelName: result.channelName,
      contextId: result.contextId,
    });
    setChatState({
      channelName: result.channelName,
      contextId: result.contextId,
      pendingAgents: result.pendingAgents,
    });
    setPhase("chat");
  }, []);

  // Build ConnectionConfig from runtime
  const config: ConnectionConfig = {
    serverUrl: pubsubConfig?.serverUrl ?? "",
    token: pubsubConfig?.token ?? "",
    clientId: panelClientId,
  };

  // New Conversation: reset to setup phase
  const handleNewConversation = useCallback(() => {
    // Clear persisted state
    void setStateArgs({ channelName: undefined, contextId: undefined, pendingAgents: undefined });
    setChatState(null);
    setPhase("setup");
  }, []);

  // Add Agent: open the dialog instead of creating a child panel
  // Use the resolved contextId from useAgenticChat (which may come from the server)
  // rather than relying solely on stateArgs, so deep-link sessions get the canonical contextId.
  const resolvedContextIdRef = useRef<string | undefined>(undefined);
  const handleAddAgent = useCallback(async (_channelName: string, contextId?: string) => {
    resolvedContextIdRef.current = contextId;
    setAddAgentOpen(true);
  }, []);

  const handleFocusPanel = useCallback((panelId: string) => {
    window.location.href = buildFocusLink(panelId);
  }, []);

  const handleReloadPanel = useCallback(async (panelId: string) => {
    try {
      const result = await ensurePanelLoaded(panelId);
      if (!result.success) {
        console.error(`Failed to reload panel ${panelId}:`, result.error);
        window.location.href = buildFocusLink(panelId);
      }
    } catch (error) {
      console.error(`Error reloading panel ${panelId}:`, error);
      window.location.href = buildFocusLink(panelId);
    }
  }, []);

  const chatActions: AgenticChatActions = useMemo(() => ({
    onNewConversation: handleNewConversation,
    onAddAgent: handleAddAgent,
    onFocusPanel: handleFocusPanel,
    onReloadPanel: handleReloadPanel,
    onBecomeVisible: forceRepaint,
  }), [handleNewConversation, handleAddAgent, handleFocusPanel, handleReloadPanel]);

  // Tool provider: creates all tool method definitions + eval
  const toolProvider: ToolProvider = useCallback(({ clientRef }: ToolProviderDeps) => {
    const diagnosticsPublisher = (eventType: string, payload: unknown) => {
      void clientRef.current?.publish(eventType, payload);
    };
    const fileTools = createAllToolMethodDefinitions({
      diagnosticsPublisher,
    });

    // Eval tool definition
    const evalMethodDef: MethodDefinition = {
      description: `Execute TypeScript/JavaScript code for side-effects.

Console output is streamed in real-time as code executes.
Async operations (fetch, await, etc.) are automatically awaited.
Top-level await is supported.

Use standard ESM imports - they're transformed to require() automatically:
- import { useState } from "react"
- import { Button } from "@radix-ui/themes"`,
      parameters: z.object({
        code: z.string().describe("The TypeScript/JavaScript code to execute"),
        syntax: z.enum(["typescript", "jsx", "tsx"]).default("tsx").describe("Target syntax"),
        timeout: z.number().default(EVAL_DEFAULT_TIMEOUT_MS).describe(`Timeout in ms (default: ${EVAL_DEFAULT_TIMEOUT_MS}, max: ${EVAL_MAX_TIMEOUT_MS}).`),
      }),
      streaming: true,
      timeout: EVAL_FRAMEWORK_TIMEOUT_MS,
      execute: async (args, ctx) => {
        let consoleBuffer = "";
        let lastFlush = 0;
        const flushConsole = (_force = false) => {
          const now = Date.now();
          if (!_force && now - lastFlush < 200) return;
          lastFlush = now;
        };

        const result = await executeEvalTool(args as { code: string; syntax?: "typescript" | "jsx" | "tsx"; timeout?: number }, ctx, {
          onConsoleEntry: (formatted: string) => {
            consoleBuffer = consoleBuffer ? `${consoleBuffer}\n${formatted}` : formatted;
            flushConsole();
          },
        });
        if (!result.success) {
          if (result.consoleOutput) consoleBuffer = result.consoleOutput;
          throw new Error(result.error || "Eval failed");
        }
        return {
          consoleOutput: result.consoleOutput || "(no output)",
          returnValue: result.returnValue,
        };
      },
    };

    return { eval: evalMethodDef, ...fileTools };
  }, []);

  // Setup phase
  if (phase === "setup") {
    return (
      <ErrorBoundary>
        <Theme appearance={theme}>
          <Flex direction="column" style={{ height: "100vh" }}>
            <ChatSetup onComplete={handleSetupComplete} />
          </Flex>
        </Theme>
      </ErrorBoundary>
    );
  }

  // Chat phase — chatState is guaranteed non-null when phase === "chat"
  if (!chatState) return null;
  const { channelName, contextId, pendingAgents } = chatState;

  return (
    <>
      <AgenticChat
        config={config}
        channelName={channelName}
        channelConfig={stateArgs.channelConfig}
        contextId={contextId}
        metadata={PANEL_METADATA}
        tools={toolProvider}
        actions={chatActions}
        theme={theme}
        pendingAgents={pendingAgents}
      />
      <AddAgentDialog
        open={addAgentOpen}
        onOpenChange={setAddAgentOpen}
        channelName={channelName}
        contextId={resolvedContextIdRef.current ?? contextId}
      />
    </>
  );
}
