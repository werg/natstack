/**
 * Agentic Chat Panel
 *
 * On mount without a channelName, auto-generates a channel and spawns the
 * default agent DO (AiChatWorker). The panel's own contextId is used
 * directly — no cross-context navigation needed.
 */

import { contextId, rpc, recoveryCoordinator, focusPanel, useStateArgs, getStateArgs, setStateArgs, buildPanelLink } from "@workspace/runtime";
import { usePanelTheme } from "@workspace/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Flex, Spinner, Text, Theme } from "@radix-ui/themes";
import { AgenticChat, ErrorBoundary } from "@workspace/agentic-chat";
import type { ConnectionConfig, AgenticChatActions, ToolProvider, ToolProviderDeps } from "@workspace/agentic-chat";
import { createPanelSandboxConfig, buildEvalTool } from "@workspace/agentic-core";
import { appendPendingAgent, resolveChatContextId } from "./bootstrap.js";

function detectHostPlatform(): "mobile" | "electron" {
  const explicitPlatform = (globalThis as { __natstackHostPlatform?: unknown }).__natstackHostPlatform;
  if (explicitPlatform === "mobile") {
    return "mobile";
  }
  if (typeof navigator !== "undefined" && /\bNatStack-Mobile\//.test(navigator.userAgent)) {
    return "mobile";
  }
  return "electron";
}

/** Stable metadata object — avoids creating a new object every render */
const PANEL_METADATA = {
  name: "Chat Panel",
  type: "panel" as const,
  handle: "user",
  hostPlatform: detectHostPlatform(),
};

/** Default DO worker source and class for the AI chat agent */
const DEFAULT_WORKER_SOURCE = "workers/agent-worker";
const DEFAULT_CLASS_NAME = "AiChatWorker";
const DEFAULT_HANDLE = "ai-chat";
const CHANNEL_SERVICE_PROTOCOL = "natstack.channel.v1";

/** Response shape from workers.listSources */
interface WorkerSourceEntry {
  name: string;
  source: string;
  title?: string;
  classes: Array<{ className: string }>;
}

interface ChannelParticipant {
  participantId: string;
  metadata: Record<string, unknown>;
}

interface ChannelDORef {
  source: string;
  className: string;
  objectKey: string;
}

function parseDoTargetId(participantId: string): ChannelDORef | null {
  if (!participantId.startsWith("do:")) return null;
  const body = participantId.slice(3);
  const slashIdx = body.indexOf("/");
  const colonAfterSlash = slashIdx >= 0 ? body.indexOf(":", slashIdx) : -1;
  if (colonAfterSlash === -1) return null;
  const source = body.slice(0, colonAfterSlash);
  const rest = body.slice(colonAfterSlash + 1);
  const nextColon = rest.indexOf(":");
  if (nextColon === -1) return null;
  return {
    source,
    className: rest.slice(0, nextColon),
    objectKey: rest.slice(nextColon + 1),
  };
}

async function getChannelDOParticipants(channelId: string): Promise<ChannelDORef[]> {
  const channelService = await rpc.call<{ kind: string; targetId?: string }>(
    "main",
    "workers.resolveService",
    [CHANNEL_SERVICE_PROTOCOL, channelId],
  );
  if (channelService.kind !== "durable-object" || !channelService.targetId) {
    throw new Error("Channel service must resolve to a Durable Object service");
  }
  const participants = await rpc.call<ChannelParticipant[]>(
    channelService.targetId,
    "getParticipants",
    [],
  );
  return participants.map((p) => parseDoTargetId(p.participantId)).filter((p): p is ChannelDORef => p !== null);
}

/** Persisted per-agent record. `key` is the stable DO `objectKey` minted once
 *  when the user first adds the agent, so rehydration reuses the same entity
 *  row rather than spawning a fresh participant. */
interface PendingAgent {
  agentId: string;
  handle: string;
  key: string;
  source: string;
  className: string;
}

/** Type for chat panel state args */
interface ChatStateArgs {
  channelName?: string;
  channelConfig?: Record<string, unknown>;
  contextId?: string;
  pendingAgents?: PendingAgent[];
  agentSource?: string;
  agentClass?: string;
  /** If set, automatically sent as the first user message once connected */
  initialPrompt?: string;
  /** System prompt for the agent harness */
  systemPrompt?: string;
  /** How systemPrompt interacts with NatStack base, workspace prompt, and skills */
  systemPromptMode?: "append" | "replace-natstack" | "replace";
  /** Context-relative TSX file to load into the panel-local action bar */
  actionBarFile?: string | null;
  /** Props for actionBarFile */
  actionBarProps?: Record<string, unknown> | null;
  /** Preferred max height for actionBarFile */
  actionBarMaxHeight?: number | null;
}

/** Create the agent DO entity (or reactivate it if it already exists), then
 *  subscribe it to the channel. Two explicit steps so the entity is created
 *  by name via `runtime.createEntity` rather than as a side effect of dispatch. */
async function createAndSubscribeAgent(args: {
  source: string;
  className: string;
  key: string;
  channelId: string;
  channelContextId: string;
  config?: Record<string, unknown>;
  replay?: boolean;
}): Promise<{ ok: boolean; participantId?: string }> {
  if (!args.channelContextId) {
    throw new Error("Cannot subscribe an agent DO without a context ID");
  }
  const handle = await rpc.call<{ targetId: string }>(
    "main",
    "runtime.createEntity",
    [{
      kind: "do",
      source: args.source,
      className: args.className,
      key: args.key,
      contextId: args.channelContextId,
    }],
  );
  return rpc.call<{ ok: boolean; participantId?: string }>(
    handle.targetId,
    "subscribeChannel",
    [{
      channelId: args.channelId,
      contextId: args.channelContextId,
      config: args.config,
      replay: args.replay,
    }],
  );
}

/** Unsubscribe a DO from a channel via unified RPC. */
async function unsubscribeDOFromChannel(
  source: string,
  className: string,
  objectKey: string,
  channelId: string,
): Promise<void> {
  const target = await rpc.call<{ targetId: string }>(
    "main",
    "workers.resolveDurableObject",
    [source, className, objectKey],
  );
  await rpc.call(target.targetId, "unsubscribeChannel", [channelId]);
}

export default function ChatPanel() {
  const theme = usePanelTheme();
  const stateArgs = useStateArgs<ChatStateArgs>();
  const resolvedContextId = resolveChatContextId(stateArgs.contextId, contextId);
  const initialPromptCaptured = useRef(stateArgs.initialPrompt);

  // Auto-bootstrap: when no channelName, generate one and spawn the default agent
  const [bootstrapChannel, setBootstrapChannel] = useState<string | null>(null);
  const [bootstrapPending, setBootstrapPending] = useState<PendingAgent[] | null>(null);
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
    // Mint `key` once and persist; rehydration must reuse it.
    const agentKey = `${baseHandle}-${crypto.randomUUID().slice(0, 8)}`;
    const pending: PendingAgent[] = [{
      agentId: className,
      handle: baseHandle,
      key: agentKey,
      source: workerSource,
      className,
    }];

    void setStateArgs({ channelName, contextId: resolvedContextId, pendingAgents: pending });

    const subscribeConfig: Record<string, unknown> = { handle: baseHandle };
    if (stateArgs.systemPrompt) subscribeConfig["systemPrompt"] = stateArgs.systemPrompt;
    if (stateArgs.systemPromptMode) subscribeConfig["systemPromptMode"] = stateArgs.systemPromptMode;
    createAndSubscribeAgent({
      source: workerSource,
      className,
      key: agentKey,
      channelId: channelName,
      channelContextId: resolvedContextId,
      config: subscribeConfig,
      replay: true,
    }).catch((err: unknown) => {
      console.warn(`[ChatPanel] Failed to subscribe agent DO:`, err);
    });

    setBootstrapChannel(channelName);
    setBootstrapPending(pending);
  }, [
    resolvedContextId,
    stateArgs.agentClass,
    stateArgs.agentSource,
    stateArgs.channelName,
    stateArgs.systemPrompt,
    stateArgs.systemPromptMode,
  ]);

  // Rehydration recovery: when a panel mounts with channelName already set
  // (persisted from a prior session) but no DO participants are in the
  // channel, re-create+subscribe each persisted agent using its stable
  // `key` so we hit the same entity row idempotently. Skipped when this
  // session ran the bootstrap itself.
  const rehydrationCheckedRef = useRef(false);
  useEffect(() => {
    if (
      rehydrationCheckedRef.current ||
      bootstrapAttempted.current ||
      !stateArgs.channelName ||
      !resolvedContextId
    ) return;
    rehydrationCheckedRef.current = true;

    const channelName = stateArgs.channelName;
    void (async () => {
      try {
        const dos = await getChannelDOParticipants(channelName);
        if (dos.length > 0) return;

        const workerSource = stateArgs.agentSource ?? DEFAULT_WORKER_SOURCE;
        const fallbackClass = stateArgs.agentClass ?? DEFAULT_CLASS_NAME;
        const fallbackHandle = fallbackClass === DEFAULT_CLASS_NAME
          ? DEFAULT_HANDLE
          : fallbackClass.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
        // Persisted pendingAgents carry the original `key`. If state was
        // written by an older build that only stored `{agentId, handle}`, mint
        // and persist a key now so subsequent rehydrations are stable.
        let pendingList: PendingAgent[];
        if (stateArgs.pendingAgents && stateArgs.pendingAgents.length > 0) {
          let mutated = false;
          pendingList = stateArgs.pendingAgents.map((agent) => {
            if (agent.key && agent.source && agent.className) return agent;
            mutated = true;
            const handle = agent.handle;
            return {
              agentId: agent.agentId,
              handle,
              key: agent.key ?? `${handle}-${crypto.randomUUID().slice(0, 8)}`,
              source: agent.source ?? workerSource,
              className: agent.className ?? agent.agentId,
            };
          });
          if (mutated) void setStateArgs({ pendingAgents: pendingList });
        } else {
          pendingList = [{
            agentId: fallbackClass,
            handle: fallbackHandle,
            key: `${fallbackHandle}-${crypto.randomUUID().slice(0, 8)}`,
            source: workerSource,
            className: fallbackClass,
          }];
          void setStateArgs({ pendingAgents: pendingList });
        }

        for (const agent of pendingList) {
          const subscribeConfig: Record<string, unknown> = { handle: agent.handle };
          if (stateArgs.systemPrompt) subscribeConfig["systemPrompt"] = stateArgs.systemPrompt;
          if (stateArgs.systemPromptMode) subscribeConfig["systemPromptMode"] = stateArgs.systemPromptMode;
          try {
            await createAndSubscribeAgent({
              source: agent.source,
              className: agent.className,
              key: agent.key,
              channelId: channelName,
              channelContextId: resolvedContextId,
              config: subscribeConfig,
              replay: true,
            });
          } catch (err) {
            console.warn(`[ChatPanel] Failed to re-subscribe agent "${agent.handle}" on rehydration:`, err);
          }
        }
      } catch (err) {
        console.warn(`[ChatPanel] Rehydration agent check failed:`, err);
      }
    })();
  }, [stateArgs.channelName, resolvedContextId]);

  // Build ConnectionConfig from runtime
  const config: ConnectionConfig = {
    clientId: rpc.selfId,
    rpc,
    recoveryCoordinator,
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

  const handleActionBarFileChange = useCallback((value: {
    path: string | null;
    props?: Record<string, unknown>;
    maxHeight?: number;
  }) => {
    void setStateArgs({
      actionBarFile: value.path,
      actionBarProps: value.path ? (value.props ?? null) : null,
      actionBarMaxHeight: value.path ? (value.maxHeight ?? null) : null,
    });
  }, []);

  // Fetch available worker sources (DO agents) on mount
  const [availableAgents, setAvailableAgents] = useState<Array<{ id: string; name: string; proposedHandle: string; className: string }>>([]);
  useEffect(() => {
    rpc.call<WorkerSourceEntry[]>("main", "workers.listSources", []).then((sources) => {
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
    const source = agent?.id ?? DEFAULT_WORKER_SOURCE;
    const baseHandle = agent?.proposedHandle ?? DEFAULT_HANDLE;
    const handle = `${baseHandle}-${crypto.randomUUID().slice(0, 4)}`;
    // Mint key once and persist into pendingAgents so rehydration reuses it.
    const agentKey = `${handle}-${crypto.randomUUID().slice(0, 8)}`;
    await createAndSubscribeAgent({
      source,
      className,
      key: agentKey,
      channelId: channelName,
      channelContextId: activeContextId,
    });
    // Persist into stateArgs.pendingAgents so the agent rehydrates on reload.
    // Read the latest snapshot (rather than the captured `stateArgs`) to avoid
    // clobbering concurrent additions.
    const currentArgs = getStateArgs<ChatStateArgs>();
    const nextPending = appendPendingAgent(currentArgs.pendingAgents, {
      agentId: className,
      handle,
      key: agentKey,
      source,
      className,
    });
    await setStateArgs({ pendingAgents: nextPending });
    return { agentId: source, handle };
  }, [availableAgents]);

  const handleRemoveAgent = useCallback(async (channelName: string, handle: string) => {
    const channelWorkers = await getChannelDOParticipants(channelName);

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

  // Sandbox config — provides RPC and import loading to agentic-chat.
  const sandboxConfig = useMemo(() => createPanelSandboxConfig(rpc), []);

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
        initialPrompt={initialPromptCaptured.current}
        sandbox={sandboxConfig}
        initialActionBarFile={stateArgs.actionBarFile ?? undefined}
        initialActionBarProps={stateArgs.actionBarProps ?? undefined}
        initialActionBarMaxHeight={stateArgs.actionBarMaxHeight ?? undefined}
        onActionBarFileChange={handleActionBarFileChange}
      />
    </>
  );
}
