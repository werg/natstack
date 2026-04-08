/**
 * Agentic Chat Panel
 *
 * On mount without a channelName, auto-generates a channel and spawns the
 * default agent DO (AiChatWorker). The panel's own contextId is used
 * directly — no cross-context navigation needed.
 */

import { pubsubConfig, id as panelClientId, contextId, rpc, focusPanel, useStateArgs, setStateArgs, buildPanelLink, db } from "@workspace/runtime";
import { usePanelTheme } from "@workspace/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Flex, Spinner, Text, Theme } from "@radix-ui/themes";
import { AgenticChat, ErrorBoundary } from "@workspace/agentic-chat";
import type { ConnectionConfig, AgenticChatActions, ToolProvider, ToolProviderDeps } from "@workspace/agentic-chat";
import { createPanelSandboxConfig, buildEvalTool } from "@workspace/agentic-core";
import { resolveChatContextId } from "./bootstrap.js";

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
  if (!channelContextId) {
    throw new Error("Cannot subscribe an agent DO without a context ID");
  }
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
  const resolvedContextId = resolveChatContextId(stateArgs.contextId, contextId);

  // Auto-bootstrap: when no channelName, generate one and spawn the default agent
  const [bootstrapChannel, setBootstrapChannel] = useState<string | null>(null);
  const [bootstrapPending, setBootstrapPending] = useState<Array<{ agentId: string; handle: string }> | null>(null);
  const bootstrapAttempted = useRef(false);

  useEffect(() => {
    if (stateArgs.channelName || bootstrapAttempted.current || !resolvedContextId) return;
    bootstrapAttempted.current = true;

    const workerSource = stateArgs.agentSource ?? DEFAULT_WORKER_SOURCE;
    const className = stateArgs.agentClass ?? DEFAULT_CLASS_NAME;
    const baseHandle = className === DEFAULT_CLASS_NAME
      ? DEFAULT_HANDLE
      : className.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();

    const channelName = `chat-${crypto.randomUUID().slice(0, 8)}`;
    const objectKey = `${baseHandle}-${crypto.randomUUID().slice(0, 8)}`;
    const pending = [{ agentId: className, handle: baseHandle }];

    void setStateArgs({ channelName, contextId: resolvedContextId, pendingAgents: pending });

    const subscribeConfig: Record<string, unknown> = { handle: baseHandle };
    subscribeDOToChannel(workerSource, className, objectKey, channelName, resolvedContextId, subscribeConfig, true).catch((err: unknown) => {
      console.warn(`[ChatPanel] Failed to subscribe agent DO:`, err);
    });

    setBootstrapChannel(channelName);
    setBootstrapPending(pending);
  }, [
    resolvedContextId,
    stateArgs.agentClass,
    stateArgs.agentSource,
    stateArgs.channelName,
  ]);

  // Clear initialPrompt from persisted stateArgs after capture.
  // useChatCore captures the value in a ref on first render, so this
  // won't interfere with the auto-send — but prevents re-send on reload.
  // Use null (not undefined) because undefined is dropped by JSON serialization.
  const initialPromptCleared = useRef(false);
  useEffect(() => {
    if (stateArgs.initialPrompt && !initialPromptCleared.current) {
      initialPromptCleared.current = true;
      void setStateArgs({ initialPrompt: null });
    }
  }, [stateArgs.initialPrompt]);

  // Build ConnectionConfig from runtime
  const config: ConnectionConfig = {
    serverUrl: pubsubConfig?.serverUrl ?? "",
    token: pubsubConfig?.token ?? "",
    clientId: panelClientId,
    rpc,
  };

  const handleNewConversation = useCallback(() => {
    window.location.href = buildPanelLink("panels/chat");
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
    }).catch((err) => { console.warn("[ChatPanel] Failed to load worker sources:", err); });
  }, []);

  const handleAddAgent = useCallback(async (channelName: string, channelContextId?: string, agentId?: string) => {
    const activeContextId = resolveChatContextId(channelContextId, contextId);
    if (!activeContextId) {
      throw new Error("Cannot add an agent without a context ID");
    }
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
      activeContextId,
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

  // Sandbox config — provides RPC, import loading, and DB to agentic-chat (keeps it runtime-agnostic)
  const sandboxConfig = useMemo(() => createPanelSandboxConfig(rpc, db), []);

  // Tool provider: only eval tool — all other operations use eval + runtime APIs
  const toolProvider: ToolProvider = useCallback((deps: ToolProviderDeps) => {
    return {
      eval: buildEvalTool({
        sandbox: sandboxConfig,
        rpc: sandboxConfig.rpc,
        runtimeTarget: "panel",
        // Panel's useAgenticChat provides boundExecuteSandbox which handles
        // scope enter/exit lifecycle, so we pass it as the override.
        executeSandbox: deps.executeSandbox,
        getChatSandboxValue: () => deps.chat,
        getScope: () => deps.scope,
      }),
    };
  }, []);

  // Resolve channel name: from stateArgs (existing chat) or bootstrap (new chat)
  const channelName = stateArgs.channelName ?? bootstrapChannel;
  const pendingAgents = stateArgs.pendingAgents ?? bootstrapPending ?? undefined;

  // Still bootstrapping — show a brief loading indicator
  if (!channelName) {
    return (
      <ErrorBoundary>
        <Theme appearance={theme}>
          <Flex align="center" justify="center" gap="2" style={{ height: "100dvh" }}>
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
