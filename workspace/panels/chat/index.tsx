/**
 * Agentic Chat Panel
 *
 * On mount without a channelName, auto-generates a channel and spawns the
 * default agent (claude-code-responder). The panel's own contextId is used
 * directly — no cross-context navigation needed.
 */

import { pubsubConfig, id as panelClientId, contextId, rpc, focusPanel, useStateArgs, buildPanelLink, db } from "@workspace/runtime";
import { usePanelTheme } from "@workspace/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentManifest } from "@natstack/types";
import { Flex, Spinner, Text, Theme } from "@radix-ui/themes";
import { AgenticChat, ErrorBoundary } from "@workspace/agentic-chat";
import type { ConnectionConfig, AgenticChatActions, ToolProvider, ToolProviderDeps } from "@workspace/agentic-chat";
import { executeEvalTool, EVAL_DEFAULT_TIMEOUT_MS, EVAL_MAX_TIMEOUT_MS, EVAL_FRAMEWORK_TIMEOUT_MS } from "@workspace/agentic-tools";
import { z } from "zod";
import type { MethodDefinition } from "@natstack/agentic-messaging";
import { setDbOpen } from "@natstack/agentic-messaging";
// Configure agentic-messaging to use runtime's db (needed for session persistence)
setDbOpen(db.open);

/** Stable metadata object — avoids creating a new object every render */
const PANEL_METADATA = { name: "Chat Panel", type: "panel" as const, handle: "user" };

const DEFAULT_AGENT = "claude-code-responder";
const DEFAULT_HANDLE = "cc";

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

  // Auto-bootstrap: when no channelName, generate one and spawn the default agent
  const [bootstrapChannel, setBootstrapChannel] = useState<string | null>(null);
  const [bootstrapPending, setBootstrapPending] = useState<Array<{ agentId: string; handle: string }> | null>(null);
  const bootstrapAttempted = useRef(false);

  useEffect(() => {
    if (stateArgs.channelName || bootstrapAttempted.current) return;
    bootstrapAttempted.current = true;

    const channelName = `chat-${crypto.randomUUID().slice(0, 8)}`;
    const pending = [{ agentId: DEFAULT_AGENT, handle: DEFAULT_HANDLE }];

    // Spawn default agent — fire-and-forget, AgenticChat handles pending display
    rpc.call("main", "agents.spawn", DEFAULT_AGENT, channelName, DEFAULT_HANDLE, {
      contextId,
    }).catch((err: unknown) => {
      console.warn(`[ChatPanel] Failed to spawn default agent:`, err);
    });

    setBootstrapChannel(channelName);
    setBootstrapPending(pending);
  }, [stateArgs.channelName]);

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

  const handleFocusPanel = useCallback((panelId: string) => {
    void focusPanel(panelId);
  }, []);

  const handleReloadPanel = useCallback(async (panelId: string) => {
    void focusPanel(panelId);
  }, []);

  // Fetch available agents on mount
  const [availableAgents, setAvailableAgents] = useState<Array<{ id: string; name: string; proposedHandle: string }>>([]);
  useEffect(() => {
    rpc.call<AgentManifest[]>("main", "agents.list").then((agents) => {
      setAvailableAgents(agents.map(a => ({
        id: a.id,
        name: a.name,
        proposedHandle: a.proposedHandle ?? a.id.split("-")[0] ?? a.id,
      })));
    }).catch(() => {});
  }, []);

  const handleAddAgent = useCallback(async (channelName: string, channelContextId?: string, agentId?: string) => {
    const selectedId = agentId ?? DEFAULT_AGENT;
    const agent = availableAgents.find(a => a.id === selectedId);
    const baseHandle = agent?.proposedHandle ?? DEFAULT_HANDLE;
    const handle = `${baseHandle}-${crypto.randomUUID().slice(0, 4)}`;
    await rpc.call("main", "agents.spawn", selectedId, channelName, handle, {
      contextId: channelContextId ?? contextId,
    });
    return { agentId: selectedId, handle };
  }, [availableAgents]);

  const handleRemoveAgent = useCallback(async (channelName: string, handle: string) => {
    await rpc.call("main", "agents.killByHandle", channelName, handle);
  }, []);

  const chatActions: AgenticChatActions = useMemo(() => ({
    onNewConversation: handleNewConversation,
    onAddAgent: handleAddAgent,
    onRemoveAgent: handleRemoveAgent,
    availableAgents,
    onFocusPanel: handleFocusPanel,
    onReloadPanel: handleReloadPanel,
  }), [handleNewConversation, handleAddAgent, handleRemoveAgent, availableAgents, handleFocusPanel, handleReloadPanel]);

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
        imports: z.record(z.string(), z.string()).optional()
          .describe("Workspace packages to build on-demand. Values: \"latest\" (current HEAD) or a git ref (branch/tag/SHA). E.g. { \"@workspace-skills/paneldev\": \"latest\" }"),
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

        // The panel's contextId (from runtime) IS the channel contextId.
        // Inject it so eval code can use it directly.
        const typedArgs = args as { code: string; syntax?: "typescript" | "jsx" | "tsx"; timeout?: number; imports?: Record<string, string> };
        const codeWithContext = `const contextId = ${JSON.stringify(contextId)};\n${typedArgs.code}`;
        const evalArgs = { ...typedArgs, code: codeWithContext };

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

  // Resolve channel name: from stateArgs (existing chat) or bootstrap (new chat)
  const channelName = stateArgs.channelName ?? bootstrapChannel;
  const pendingAgents = stateArgs.pendingAgents ?? bootstrapPending ?? undefined;
  const resolvedContextId = stateArgs.contextId ?? contextId;

  // Still bootstrapping — show a brief loading indicator
  if (!channelName) {
    return (
      <ErrorBoundary>
        <Theme appearance={theme}>
          <Flex align="center" justify="center" gap="2" style={{ height: "100vh" }}>
            <Spinner />
            <Text size="2" color="gray">Starting chat...</Text>
          </Flex>
        </Theme>
      </ErrorBoundary>
    );
  }

  return (
    <>
      <AgenticChat
        config={config}
        channelName={channelName}
        channelConfig={stateArgs.channelConfig}
        contextId={resolvedContextId}
        metadata={PANEL_METADATA}
        tools={toolProvider}
        actions={chatActions}
        theme={theme}
        pendingAgents={pendingAgents}
      />
    </>
  );
}
