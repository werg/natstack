/**
 * Agentic Chat Panel
 *
 * On mount without a channelName, auto-generates a channel and spawns the
 * default agent DO (AiChatWorker). The panel's own contextId is used
 * directly — no cross-context navigation needed.
 */

import { pubsubConfig, id as panelClientId, contextId, rpc, focusPanel, useStateArgs, setStateArgs, buildPanelLink } from "@workspace/runtime";
import { usePanelTheme } from "@workspace/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Flex, Spinner, Text, Theme } from "@radix-ui/themes";
import { AgenticChat, ErrorBoundary } from "@workspace/agentic-chat";
import type { ConnectionConfig, AgenticChatActions, ToolProvider, ToolProviderDeps, SandboxConfig } from "@workspace/agentic-chat";
import { SANDBOX_DEFAULT_TIMEOUT_MS, SANDBOX_MAX_TIMEOUT_MS, SANDBOX_FRAMEWORK_TIMEOUT_MS } from "@workspace/eval";
import { z } from "zod";
import type { MethodDefinition } from "@natstack/pubsub";

/** Stable metadata object — avoids creating a new object every render */
const PANEL_METADATA = { name: "Chat Panel", type: "panel" as const, handle: "user" };

/** Default DO worker source and class for the AI chat agent */
const DEFAULT_WORKER_SOURCE = "workers/agent-worker";
const DEFAULT_CLASS_NAME = "AiChatWorker";
const DEFAULT_HANDLE = "ai-chat";

/** Response shape from workers.listSources */
interface WorkerSourceEntry {
  name: string;
  source: string;
  title?: string;
  classes: Array<{ className: string }>;
}

/** Type for chat panel state args */
interface ChatStateArgs {
  channelName?: string;
  channelConfig?: Record<string, unknown>;
  contextId?: string;
  pendingAgents?: Array<{ agentId: string; handle: string }>;
  agentSource?: string;
  agentClass?: string;
  /** If set, automatically sent as the first user message once connected */
  initialPrompt?: string;
  /** System prompt for the agent harness */
  systemPrompt?: string;
}

/**
 * Subscribe a DO to a channel via the workers service.
 * Ensures the DO is reachable (idempotent) then calls subscribeChannel.
 */
async function subscribeDOToChannel(
  source: string,
  className: string,
  objectKey: string,
  channelId: string,
  channelContextId: string,
  config?: Record<string, unknown>,
  replay?: boolean,
): Promise<{ ok: boolean; participantId?: string }> {
  // callDO dispatches via DODispatch which internally ensures the DO is alive
  // on failure (ensureDO + retry). No eager setup needed.
  return rpc.call<{ ok: boolean; participantId?: string }>(
    "main",
    "workers.callDO",
    source,
    className,
    objectKey,
    "subscribeChannel",
    { channelId, contextId: channelContextId, config, replay },
  );
}

/**
 * Unsubscribe a DO from a channel via the workers service.
 */
async function unsubscribeDOFromChannel(
  source: string,
  className: string,
  objectKey: string,
  channelId: string,
): Promise<void> {
  await rpc.call("main", "workers.callDO", source, className, objectKey, "unsubscribeChannel", channelId);
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

    const workerSource = stateArgs.agentSource ?? DEFAULT_WORKER_SOURCE;
    const className = stateArgs.agentClass ?? DEFAULT_CLASS_NAME;
    const baseHandle = className === DEFAULT_CLASS_NAME
      ? DEFAULT_HANDLE
      : className.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();

    const channelName = `chat-${crypto.randomUUID().slice(0, 8)}`;
    const objectKey = `${baseHandle}-${crypto.randomUUID().slice(0, 8)}`;
    const pending = [{ agentId: className, handle: baseHandle }];

    void setStateArgs({ channelName });

    const subscribeConfig: Record<string, unknown> = { handle: baseHandle };
    if (stateArgs.systemPrompt) subscribeConfig["systemPrompt"] = stateArgs.systemPrompt;
    subscribeDOToChannel(workerSource, className, objectKey, channelName, contextId, subscribeConfig, true).catch((err: unknown) => {
      console.warn(`[ChatPanel] Failed to subscribe agent DO:`, err);
    });

    setBootstrapChannel(channelName);
    setBootstrapPending(pending);
  }, [stateArgs.channelName]);

  // Clear initialPrompt from persisted stateArgs after capture.
  // useChatCore captures the value in a ref on first render, so this
  // won't interfere with the auto-send — but prevents re-send on reload.
  const initialPromptCleared = useRef(false);
  useEffect(() => {
    if (stateArgs.initialPrompt && !initialPromptCleared.current) {
      initialPromptCleared.current = true;
      void setStateArgs({ initialPrompt: undefined });
    }
  }, [stateArgs.initialPrompt]);

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

  // Fetch available worker sources (DO agents) on mount
  const [availableAgents, setAvailableAgents] = useState<Array<{ id: string; name: string; proposedHandle: string; className: string }>>([]);
  useEffect(() => {
    rpc.call<WorkerSourceEntry[]>("main", "workers.listSources").then((sources) => {
      const agents: Array<{ id: string; name: string; proposedHandle: string; className: string }> = [];
      for (const source of sources) {
        for (const cls of source.classes) {
          agents.push({
            id: source.source,
            name: source.title ?? source.name,
            proposedHandle: source.name.split("-")[0] ?? source.name,
            className: cls.className,
          });
        }
      }
      setAvailableAgents(agents);
    }).catch(() => {});
  }, []);

  const handleAddAgent = useCallback(async (channelName: string, channelContextId?: string, agentId?: string) => {
    const agent = agentId
      ? availableAgents.find(a => a.id === agentId || a.className === agentId)
      : availableAgents[0];
    const className = agent?.className ?? DEFAULT_CLASS_NAME;
    const baseHandle = agent?.proposedHandle ?? DEFAULT_HANDLE;
    const handle = `${baseHandle}-${crypto.randomUUID().slice(0, 4)}`;
    const objectKey = `${handle}-${crypto.randomUUID().slice(0, 8)}`;
    await subscribeDOToChannel(
      agent?.id ?? DEFAULT_WORKER_SOURCE,
      className,
      objectKey,
      channelName,
      channelContextId ?? contextId,
    );
    return { agentId: agent?.id ?? DEFAULT_WORKER_SOURCE, handle };
  }, [availableAgents]);

  const handleRemoveAgent = useCallback(async (channelName: string, handle: string) => {
    // Find the DO participant on this channel that matches the handle.
    // getChannelWorkers returns all DO participants subscribed to the channel.
    const channelWorkers = await rpc.call<Array<{
      participantId: string;
      source: string;
      className: string;
      objectKey: string;
      channelId: string;
    }>>("main", "workers.getChannelWorkers", channelName);

    // Match by objectKey containing the handle prefix (objectKey is "{handle}-{uuid}")
    const match = channelWorkers.find(w => w.objectKey.startsWith(handle));
    if (match) {
      await unsubscribeDOFromChannel(match.source, match.className, match.objectKey, channelName);
    } else {
      // Fallback: try to unsubscribe the first worker if only one is present
      // TODO: improve handle-to-objectKey resolution when multiple DOs are present
      console.warn(`[ChatPanel] No DO found matching handle "${handle}" on channel "${channelName}"`);
      if (channelWorkers.length === 1) {
        const w = channelWorkers[0]!;
        await unsubscribeDOFromChannel(w.source, w.className, w.objectKey, channelName);
      }
    }
  }, []);

  const chatActions: AgenticChatActions = useMemo(() => ({
    onNewConversation: handleNewConversation,
    onAddAgent: handleAddAgent,
    onRemoveAgent: handleRemoveAgent,
    availableAgents,
    onFocusPanel: handleFocusPanel,
    onReloadPanel: handleReloadPanel,
  }), [handleNewConversation, handleAddAgent, handleRemoveAgent, availableAgents, handleFocusPanel, handleReloadPanel]);

  // Sandbox config — provides RPC and import loading to agentic-chat (keeps it runtime-agnostic)
  const sandboxConfig: SandboxConfig = useMemo(() => ({
    rpc: { call: (t: string, m: string, ...a: unknown[]) => rpc.call(t, m, ...a) },
    loadImport: async (specifier: string, ref: string | undefined, externals: string[]) => {
      const result = await rpc.call("main", "build.getBuild", specifier, ref, { library: true, externals }) as { bundle: string };
      return result.bundle;
    },
  }), []);

  // Tool provider: only eval tool — all other operations use eval + runtime APIs
  const toolProvider: ToolProvider = useCallback((deps: ToolProviderDeps) => {
    const evalMethodDef: MethodDefinition = {
      description: `Execute TypeScript/JavaScript code in the panel sandbox.

**Capabilities:**
- Top-level await supported (async operations, fetch, timers)
- Console output streams to the agent in real-time
- Dynamic imports: build workspace packages on-demand from any git ref

**Available modules** (via import/require):
- @workspace/runtime — rpc, fs, db, workers, workspace APIs
- react, @radix-ui/themes, @radix-ui/react-icons — for component rendering
- Any module in the panel's exposeModules list

**Side effects you can trigger:**
- File system: read/write files via rpc.call("main", "fs.readFile", path)
- Database: query/mutate via rpc.call("main", "db.query", sql)
- Worker management: create/destroy workers via rpc
- Panel navigation: openPanel(source) to open panels, focusPanel(id) to focus existing ones
- Send messages to chat: chat.publish("message", { content: "..." })
- Call channel methods: chat.callMethod(participantId, method, args)

**Pre-injected variables:** contextId, chat

Use static ESM imports (transformed to require() automatically):
- import { rpc, openPanel, createBrowserPanel, focusPanel } from "@workspace/runtime"

The variable \`contextId\` is pre-injected — use it directly, do NOT import it from @workspace/runtime.
IMPORTANT: Use static import syntax, NOT dynamic await import().`,
      parameters: z.object({
        code: z.string().describe("The TypeScript/JavaScript code to execute"),
        syntax: z.enum(["typescript", "jsx", "tsx"]).default("tsx").describe("Target syntax"),
        timeout: z.number().default(SANDBOX_DEFAULT_TIMEOUT_MS).describe(`Timeout in ms (default: ${SANDBOX_DEFAULT_TIMEOUT_MS}, max: ${SANDBOX_MAX_TIMEOUT_MS}).`),
        imports: z.record(z.string(), z.string()).optional()
          .describe("Workspace packages to build on-demand. Values: \"latest\" (current HEAD) or a git ref (branch/tag/SHA). E.g. { \"@workspace-skills/paneldev\": \"latest\" }"),
      }),
      streaming: true,
      timeout: SANDBOX_FRAMEWORK_TIMEOUT_MS,
      execute: async (args, ctx) => {
        const typedArgs = args as { code: string; syntax?: "typescript" | "jsx" | "tsx"; timeout?: number; imports?: Record<string, string> };

        const result = await deps.executeSandbox(typedArgs.code, {
          syntax: typedArgs.syntax,
          timeout: typedArgs.timeout,
          imports: typedArgs.imports,
          bindings: { contextId: deps.contextId, chat: deps.chat },
          onConsole: (formatted: string) => {
            void ctx.stream({ type: "console", content: formatted }).catch(() => {});
          },
        });

        if (!result.success) {
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
        initialPrompt={stateArgs.initialPrompt}
        sandbox={sandboxConfig}
      />
    </>
  );
}
