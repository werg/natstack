/**
 * Agentic Chat Panel
 *
 * Two modes based on stateArgs:
 * - No channelName: Shows setup phase (agent selection + chat creation)
 * - With channelName: Shows active chat session
 *
 * Setup completes via URL navigation to the same panel with a new contextId
 * (cross-context absolute URL). The browser navigates to a different subdomain,
 * the old panel's WS disconnects and gets cleaned up via grace-period, and the
 * new panel bootstraps with contextId = channel contextId.
 */

import { pubsubConfig, id as panelClientId, contextId, focusPanel, useStateArgs, buildPanelLink, forceRepaint } from "@workspace/runtime";
import { usePanelTheme } from "@workspace/react";
import { useCallback, useMemo, useRef, useState } from "react";
import { Flex, Theme } from "@radix-ui/themes";
import { AgenticChat, ErrorBoundary } from "@workspace/agentic-chat";
import type { ConnectionConfig, AgenticChatActions, ToolProvider, ToolProviderDeps } from "@workspace/agentic-chat";
import { executeEvalTool, EVAL_DEFAULT_TIMEOUT_MS, EVAL_MAX_TIMEOUT_MS, EVAL_FRAMEWORK_TIMEOUT_MS } from "@workspace/agentic-tools";
import { z } from "zod";
import type { MethodDefinition } from "@workspace/agentic-messaging";
import { ChatSetup } from "./components/ChatSetup";
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

  // Add Agent dialog state
  const [addAgentOpen, setAddAgentOpen] = useState(false);

  // Build ConnectionConfig from runtime
  const config: ConnectionConfig = {
    serverUrl: pubsubConfig?.serverUrl ?? "",
    token: pubsubConfig?.token ?? "",
    clientId: panelClientId,
  };

  // New Conversation: force re-bootstrap to get a fresh panel with no stateArgs.
  // ?_fresh clears sessionStorage identity and triggers server-side on-demand creation.
  const handleNewConversation = useCallback(() => {
    sessionStorage.clear();
    window.location.href = buildPanelLink("panels/chat") + "?_fresh";
  }, []);

  // Add Agent: open the dialog instead of creating a child panel
  const resolvedContextIdRef = useRef<string | undefined>(undefined);
  const handleAddAgent = useCallback(async (_channelName: string, ctxId?: string) => {
    resolvedContextIdRef.current = ctxId;
    setAddAgentOpen(true);
  }, []);

  const handleFocusPanel = useCallback((panelId: string) => {
    void focusPanel(panelId);
  }, []);

  const handleReloadPanel = useCallback(async (panelId: string) => {
    void focusPanel(panelId);
  }, []);

  const chatActions: AgenticChatActions = useMemo(() => ({
    onNewConversation: handleNewConversation,
    onAddAgent: handleAddAgent,
    onFocusPanel: handleFocusPanel,
    onReloadPanel: handleReloadPanel,
    onBecomeVisible: forceRepaint,
  }), [handleNewConversation, handleAddAgent, handleFocusPanel, handleReloadPanel]);

  // Tool provider: only eval tool — all other operations use eval + runtime APIs
  const toolProvider: ToolProvider = useCallback((_deps: ToolProviderDeps) => {
    const evalMethodDef: MethodDefinition = {
      description: `Execute TypeScript/JavaScript code for side-effects.

Console output is streamed in real-time as code executes.
Async operations (fetch, await, etc.) are automatically awaited.
Top-level await is supported.

Use static ESM imports (transformed to require() automatically):
- import { rpc, focusPanel, buildPanelLink } from "@workspace/runtime"

The variable \`contextId\` is pre-injected — use it directly, do NOT import it from @workspace/runtime.
IMPORTANT: Use static import syntax, NOT dynamic await import().`,
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

        // The panel's contextId (from runtime) IS the channel contextId because
        // ChatSetup replaced this panel with contextId = channel contextId.
        // Inject it so eval code can use it directly.
        const codeWithContext = `const contextId = ${JSON.stringify(contextId)};\n${(args as { code: string }).code}`;
        const evalArgs = { ...(args as { code: string; syntax?: "typescript" | "jsx" | "tsx"; timeout?: number }), code: codeWithContext };

        const result = await executeEvalTool(evalArgs, ctx, {
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

    return { eval: evalMethodDef };
  }, []);

  // Setup phase — no channelName in stateArgs
  if (!stateArgs.channelName) {
    return (
      <ErrorBoundary>
        <Theme appearance={theme}>
          <Flex direction="column" style={{ height: "100vh" }}>
            <ChatSetup />
          </Flex>
        </Theme>
      </ErrorBoundary>
    );
  }

  // Chat phase — channelName present in stateArgs
  const { channelName, pendingAgents } = stateArgs;

  return (
    <>
      <AgenticChat
        config={config}
        channelName={channelName}
        channelConfig={stateArgs.channelConfig}
        contextId={stateArgs.contextId}
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
        contextId={resolvedContextIdRef.current ?? stateArgs.contextId}
      />
    </>
  );
}
