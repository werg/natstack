/**
 * Agentic Chat Panel
 *
 * On mount without a channelName, auto-generates a channel and spawns the
 * default agent DO (AiChatWorker). The panel's own contextId is used
 * directly — no cross-context navigation needed.
 */

import { contextId, rpc, recoveryCoordinator, focusPanel, useStateArgs, getStateArgs, setStateArgs, buildPanelLink, createDurableObjectServiceClient, slotId } from "@workspace/runtime";
import { usePanelTheme } from "@workspace/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Flex, Text, Theme } from "@radix-ui/themes";
import { AgenticChat, ErrorBoundary } from "@workspace/agentic-chat";
import type { ConnectionConfig, AgenticChatActions, ToolProvider, ToolProviderDeps } from "@workspace/agentic-chat";
import { createPanelSandboxConfig, buildEvalTool } from "@workspace/agentic-core";
import type { AvailableAgent, ModelCatalog, AgentSubscriptionConfig, ConnectProviderResult } from "@workspace/agentic-core";
import { toPanelConnectRequest } from "@workspace/model-catalog/providerConnect";
import {
  DEFAULT_AGENT_MODEL_REF,
  MODEL_SETTINGS_SERVICE_PROTOCOL,
  type ModelSettingsSnapshot,
} from "@workspace/model-catalog/catalog";
import { findMatchingUrlAudience } from "@natstack/shared/credentials/urlAudience";
import type { UrlAudience } from "@natstack/shared/credentials/urlAudience";
import type { DurableObjectServiceClient } from "@workspace/runtime";
import { appendInstalledAgent, resolveChatContextId } from "./bootstrap.js";

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

function modelHasMatchingCredential(baseUrl: string | undefined, audiences: UrlAudience[]): boolean {
  if (!baseUrl?.trim() || /\{[^}]+\}/.test(baseUrl)) return false;
  try {
    return findMatchingUrlAudience(baseUrl, audiences) !== null;
  } catch (err) {
    console.warn("[ChatPanel] Ignoring invalid credential audience while matching model:", err);
    return false;
  }
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
const AGENT_SUBSCRIPTION_RETRY_DELAY_MS = 1_000;
const AGENT_SUBSCRIPTION_MAX_ATTEMPTS = 60;

/** Response shape from workers.listSources */
interface WorkerSourceEntry {
  name: string;
  source: string;
  title?: string;
  classes: Array<{ className: string }>;
  /** Present iff this worker declares itself a chat agent (manifest `agent` block). */
  agent?: {
    displayName?: string;
    description?: string;
    icon?: string;
    defaultConfig?: AgentSubscriptionConfig;
  };
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Persisted per-agent record. `key` is the stable DO `objectKey` minted once
 *  when the user first adds the agent, so rehydration reuses the same entity
 *  row rather than spawning a fresh participant. */
interface InstalledAgent {
  agentId: string;
  handle: string;
  key: string;
  source: string;
  className: string;
  /** Per-agent subscription config (model, effort, etc.), layered over the
   *  global `agentConfig` on rehydration so switched/added agents come back
   *  on their own model. Excludes `handle` (stored separately above). */
  config?: Record<string, unknown>;
}

/** Type for chat panel state args */
interface ChatStateArgs {
  channelName?: string;
  channelConfig?: Record<string, unknown>;
  contextId?: string;
  installedAgents?: InstalledAgent[];
  agentSource?: string;
  agentClass?: string;
  /** If set, automatically sent as the first user message once connected */
  initialPrompt?: string;
  /** System prompt for the agent harness */
  systemPrompt?: string;
  /** How systemPrompt interacts with NatStack base, workspace prompt, and skills */
  systemPromptMode?: "append" | "replace-natstack" | "replace";
  /** Extra subscription config for custom/test agents */
  agentConfig?: Record<string, unknown>;
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
  const modelSettingsServiceRef = useRef<DurableObjectServiceClient | null>(null);
  const [modelCatalog, setModelCatalog] = useState<ModelCatalog | null>(null);
  const [workspaceDefaultModelRef, setWorkspaceDefaultModelRef] = useState<string | null>(null);
  const [connectedModelRefs, setConnectedModelRefs] = useState<string[]>([]);
  const catalogRef = useRef<ModelCatalog | null>(null);

  const getModelSettingsService = useCallback(() => {
    modelSettingsServiceRef.current ??= createDurableObjectServiceClient(
      MODEL_SETTINGS_SERVICE_PROTOCOL
    );
    return modelSettingsServiceRef.current;
  }, []);

  const loadModelSettings = useCallback(async (): Promise<ModelSettingsSnapshot> => {
    const settings = await getModelSettingsService().call<ModelSettingsSnapshot>("getSettings");
    catalogRef.current = settings.catalog;
    setModelCatalog(settings.catalog);
    setWorkspaceDefaultModelRef(settings.defaultModel);
    return settings;
  }, [getModelSettingsService]);

  const resolveWorkspaceDefaultModel = useCallback(async (): Promise<string> => {
    try {
      return (await loadModelSettings()).defaultModel || DEFAULT_AGENT_MODEL_REF;
    } catch (err) {
      console.warn("[ChatPanel] Failed to load workspace model default:", err);
      return DEFAULT_AGENT_MODEL_REF;
    }
  }, [loadModelSettings]);

  // Auto-bootstrap: when no channelName, generate one and spawn the default agent
  const [bootstrapChannel, setBootstrapChannel] = useState<string | null>(null);
  const [bootstrapInstalled, setBootstrapInstalled] = useState<InstalledAgent[] | null>(null);
  const bootstrapAttempted = useRef(false);

  useEffect(() => {
    if (stateArgs.channelName || bootstrapAttempted.current || !resolvedContextId) return;
    bootstrapAttempted.current = true;

    void (async () => {
      const workerSource = stateArgs.agentSource ?? DEFAULT_WORKER_SOURCE;
      const className = stateArgs.agentClass ?? DEFAULT_CLASS_NAME;
      const baseHandle = className === DEFAULT_CLASS_NAME
        ? DEFAULT_HANDLE
        : className.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
      const defaultModel = await resolveWorkspaceDefaultModel();

      const channelName = `chat-${crypto.randomUUID().slice(0, 8)}`;
      // Mint `key` once and persist; rehydration must reuse it.
      const agentKey = `${baseHandle}-${crypto.randomUUID().slice(0, 8)}`;
      const perAgentConfig: Record<string, unknown> = {
        model: (stateArgs.agentConfig?.["model"] as string | undefined) ?? defaultModel,
      };
      const installed: InstalledAgent[] = [{
        agentId: className,
        handle: baseHandle,
        key: agentKey,
        source: workerSource,
        className,
        config: perAgentConfig,
      }];

      void setStateArgs({ channelName, contextId: resolvedContextId, installedAgents: installed });

      const subscribeConfig: Record<string, unknown> = {
        model: defaultModel,
        ...(stateArgs.agentConfig ?? {}),
        handle: baseHandle,
      };
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
      setBootstrapInstalled(installed);
    })();
  }, [
    resolvedContextId,
    resolveWorkspaceDefaultModel,
    stateArgs.agentClass,
    stateArgs.agentSource,
    stateArgs.agentConfig,
    stateArgs.channelName,
    stateArgs.systemPrompt,
    stateArgs.systemPromptMode,
  ]);

  // Agent subscription recovery: when a panel has a channel but no DO
  // participants, re-create+subscribe each persisted agent using its stable
  // `key` so we hit the same entity row idempotently. This also covers fresh
  // bootstrap, where server-side startup approvals/builds can briefly race
  // the first create+subscribe attempt.
  const rehydrationCheckedRef = useRef(false);
  useEffect(() => {
    if (
      rehydrationCheckedRef.current ||
      !stateArgs.channelName ||
      !resolvedContextId
    ) return;
    rehydrationCheckedRef.current = true;
    let cancelled = false;

    const channelName = stateArgs.channelName;
    void (async () => {
      for (let attempt = 1; attempt <= AGENT_SUBSCRIPTION_MAX_ATTEMPTS && !cancelled; attempt += 1) {
        try {
          const dos = await getChannelDOParticipants(channelName);
          if (dos.length > 0) return;

          const installedList = stateArgs.installedAgents ?? [];
          if (installedList.length === 0) return;
          const defaultModel = await resolveWorkspaceDefaultModel();

          for (const agent of installedList) {
            // Layer the per-agent persisted config over the global default so a
            // switched/added agent comes back on its own model after reload.
            const subscribeConfig: Record<string, unknown> = {
              model: defaultModel,
              ...(stateArgs.agentConfig ?? {}),
              ...(agent.config ?? {}),
              handle: agent.handle,
            };
            if (stateArgs.systemPrompt && subscribeConfig["systemPrompt"] === undefined) subscribeConfig["systemPrompt"] = stateArgs.systemPrompt;
            if (stateArgs.systemPromptMode && subscribeConfig["systemPromptMode"] === undefined) subscribeConfig["systemPromptMode"] = stateArgs.systemPromptMode;
            await createAndSubscribeAgent({
              source: agent.source,
              className: agent.className,
              key: agent.key,
              channelId: channelName,
              channelContextId: resolvedContextId,
              config: subscribeConfig,
              replay: true,
            });
          }
          return;
        } catch (err) {
          if (attempt === AGENT_SUBSCRIPTION_MAX_ATTEMPTS) {
            console.warn(`[ChatPanel] Agent subscription recovery failed:`, err);
            return;
          }
          await delay(AGENT_SUBSCRIPTION_RETRY_DELAY_MS);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    stateArgs.channelName,
    stateArgs.installedAgents,
    stateArgs.agentConfig,
    stateArgs.systemPrompt,
    stateArgs.systemPromptMode,
    resolvedContextId,
    resolveWorkspaceDefaultModel,
  ]);

  // Build ConnectionConfig from runtime
  const config: ConnectionConfig = {
    clientId: slotId,
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

  // Fetch available worker sources (DO agents) on mount. Only sources that
  // declare an `agent` manifest block are chat agents — this filters out
  // service DOs (pubsub-channel, gad-store, fork, …).
  const [availableAgents, setAvailableAgents] = useState<AvailableAgent[]>([]);
  useEffect(() => {
    rpc.call<WorkerSourceEntry[]>("main", "workers.listSources", []).then((sources) => {
      const agents: AvailableAgent[] = [];
      for (const source of sources) {
        if (!source.agent) continue;
        for (const cls of source.classes) {
          agents.push({
            id: source.source,
            className: cls.className,
            name: source.agent.displayName ?? source.title ?? source.name,
            description: source.agent.description,
            icon: source.agent.icon,
            defaultConfig: source.agent.defaultConfig,
            proposedHandle: source.name.split("-")[0] ?? source.name,
          });
        }
      }
      setAvailableAgents(agents);
    }).catch((err) => { console.warn("[ChatPanel] Failed to load worker sources:", err); });
  }, []);

  // Model catalog (static pi data) + panel-scoped connection status. Connection
  // is computed here so it stays scoped to this panel's own credentials rather
  // than leaking global state.
  const refreshConnectedRefs = useCallback(async () => {
    const cat = catalogRef.current;
    if (!cat) return;
    try {
      const creds = await rpc.call<Array<{ audience: UrlAudience[] }>>(
        "main",
        "credentials.listStoredCredentials",
        [],
      );
      const audiences = creds.flatMap((c) => c.audience ?? []);
      const refs = cat.models
        .filter((m) => modelHasMatchingCredential(m.baseUrl, audiences))
        .map((m) => m.ref);
      setConnectedModelRefs(refs);
    } catch (err) {
      console.warn("[ChatPanel] Failed to load credentials for model picker:", err);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        await loadModelSettings();
        await refreshConnectedRefs();
      } catch (err) {
        console.warn("[ChatPanel] Failed to load model settings:", err);
      }
    })();
  }, [loadModelSettings, refreshConnectedRefs]);

  /** Build the subscription config for a new agent: global agentConfig, then the
   *  per-agent config, with the resolved handle last. Returns both the wire
   *  config and the per-agent config to persist (handle stored separately). */
  const buildSubscribeConfig = useCallback((handle: string, config?: AgentSubscriptionConfig) => {
    const perAgent: Record<string, unknown> = { ...(config ?? {}) };
    delete perAgent["handle"];
    const globalConfig = getStateArgs<ChatStateArgs>().agentConfig ?? {};
    const subscribeConfig: Record<string, unknown> = {
      model: workspaceDefaultModelRef ?? DEFAULT_AGENT_MODEL_REF,
      ...globalConfig,
      ...perAgent,
      handle,
    };
    if (typeof perAgent["model"] !== "string" && typeof subscribeConfig["model"] === "string") {
      perAgent["model"] = subscribeConfig["model"];
    }
    if (stateArgs.systemPrompt && subscribeConfig["systemPrompt"] === undefined) {
      subscribeConfig["systemPrompt"] = stateArgs.systemPrompt;
    }
    if (stateArgs.systemPromptMode && subscribeConfig["systemPromptMode"] === undefined) {
      subscribeConfig["systemPromptMode"] = stateArgs.systemPromptMode;
    }
    return { subscribeConfig, perAgent };
  }, [stateArgs.systemPrompt, stateArgs.systemPromptMode, workspaceDefaultModelRef]);

  const persistWorkspaceDefaultModel = useCallback(async (model: string): Promise<void> => {
    const settings = await getModelSettingsService().call<ModelSettingsSnapshot>(
      "setDefaultModel",
      model
    );
    catalogRef.current = settings.catalog;
    setModelCatalog(settings.catalog);
    setWorkspaceDefaultModelRef(settings.defaultModel);
  }, [getModelSettingsService]);

  const handleAddAgent = useCallback(async (channelName: string, channelContextId?: string, agentId?: string, config?: AgentSubscriptionConfig) => {
    const activeContextId = resolveChatContextId(channelContextId, contextId);
    if (!activeContextId) {
      throw new Error("Cannot add an agent without a context ID");
    }
    const agent = agentId
      ? availableAgents.find(a => a.id === agentId || a.className === agentId)
      : availableAgents[0];
    const className = agent?.className ?? DEFAULT_CLASS_NAME;
    const source = agent?.id ?? DEFAULT_WORKER_SOURCE;
    const configHandle = typeof config?.["handle"] === "string" ? (config["handle"] as string) : "";
    const requestedHandle = configHandle.trim() || agent?.proposedHandle || DEFAULT_HANDLE;
    const handle = `${requestedHandle}-${crypto.randomUUID().slice(0, 4)}`;
    // Mint key once and persist into installedAgents so rehydration reuses it.
    const agentKey = `${handle}-${crypto.randomUUID().slice(0, 8)}`;
    const { subscribeConfig, perAgent } = buildSubscribeConfig(handle, config);
    await createAndSubscribeAgent({
      source,
      className,
      key: agentKey,
      channelId: channelName,
      channelContextId: activeContextId,
      config: subscribeConfig,
      replay: true,
    });
    const selectedModel = typeof perAgent["model"] === "string" ? perAgent["model"] : null;
    if (selectedModel) {
      void persistWorkspaceDefaultModel(selectedModel).catch((err: unknown) => {
        console.warn("[ChatPanel] Failed to persist workspace default model:", err);
      });
    }
    // Persist into stateArgs.installedAgents so the agent rehydrates on reload.
    // Read the latest snapshot (rather than the captured `stateArgs`) to avoid
    // clobbering concurrent additions.
    const currentArgs = getStateArgs<ChatStateArgs>();
    const nextInstalled = appendInstalledAgent(currentArgs.installedAgents, {
      agentId: className,
      handle,
      key: agentKey,
      source,
      className,
      ...(Object.keys(perAgent).length > 0 ? { config: perAgent } : {}),
    });
    await setStateArgs({ installedAgents: nextInstalled });
    return { agentId: source, handle };
  }, [availableAgents, buildSubscribeConfig, persistWorkspaceDefaultModel]);

  const handleReplaceAgent = useCallback(async (channelName: string, participantId: string, agentId?: string, config?: AgentSubscriptionConfig) => {
    const activeContextId = resolveChatContextId(stateArgs.contextId, contextId);
    if (!activeContextId) {
      throw new Error("Cannot replace an agent without a context ID");
    }
    const target = parseDoTargetId(participantId);
    if (!target) {
      throw new Error(`Cannot resolve agent participant: ${participantId}`);
    }
    // Resolve the new agent type. When agentId is omitted (restart-with-model),
    // reuse the existing DO's source/className.
    const agent = agentId
      ? availableAgents.find(a => a.id === agentId || a.className === agentId)
      : undefined;
    const source = agent?.id ?? target.source;
    const className = agent?.className ?? target.className;
    // Reuse the existing handle for a stable identity across the switch.
    const configHandle = typeof config?.["handle"] === "string" ? (config["handle"] as string) : "";
    const handle = configHandle.trim() || agent?.proposedHandle || DEFAULT_HANDLE;
    const agentKey = `${handle}-${crypto.randomUUID().slice(0, 8)}`;
    const { subscribeConfig, perAgent } = buildSubscribeConfig(handle, config);

    // Kick the exact DO, then invite the replacement (replay restores history).
    await unsubscribeDOFromChannel(target.source, target.className, target.objectKey, channelName);
    await createAndSubscribeAgent({
      source,
      className,
      key: agentKey,
      channelId: channelName,
      channelContextId: activeContextId,
      config: subscribeConfig,
      replay: true,
    });
    const selectedModel = typeof perAgent["model"] === "string" ? perAgent["model"] : null;
    if (selectedModel) {
      void persistWorkspaceDefaultModel(selectedModel).catch((err: unknown) => {
        console.warn("[ChatPanel] Failed to persist workspace default model:", err);
      });
    }

    // Rewrite the matching persisted record (matched by old objectKey) so reload
    // rehydrates the new model rather than the old one.
    const currentArgs = getStateArgs<ChatStateArgs>();
    const newRecord = {
      agentId: className,
      handle,
      key: agentKey,
      source,
      className,
      ...(Object.keys(perAgent).length > 0 ? { config: perAgent } : {}),
    };
    const existing = currentArgs.installedAgents ?? [];
    const replaced = existing.some((a) => a.key === target.objectKey);
    const nextInstalled = replaced
      ? existing.map((a) => (a.key === target.objectKey ? newRecord : a))
      : [...existing, newRecord];
    await setStateArgs({ installedAgents: nextInstalled });
    return { agentId: source, handle };
  }, [availableAgents, buildSubscribeConfig, persistWorkspaceDefaultModel]);

  const handleConnectProvider = useCallback(async (
    providerId: string,
    modelBaseUrl: string,
    opts?: { browser?: "internal" | "external" },
  ): Promise<ConnectProviderResult> => {
    const request = toPanelConnectRequest(providerId, modelBaseUrl, { browser: opts?.browser });
    if (!request) {
      return { ok: false, error: `No connect flow available for ${providerId}` };
    }
    try {
      await rpc.call("main", "credentials.connect", [request]);
      await refreshConnectedRefs();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }, [refreshConnectedRefs]);

  const handlePersistAgentModel = useCallback(async (
    _channelName: string,
    participantId: string,
    model: string,
  ): Promise<void> => {
    const target = parseDoTargetId(participantId);
    if (!target) {
      throw new Error(`Cannot resolve agent participant: ${participantId}`);
    }
    const currentArgs = getStateArgs<ChatStateArgs>();
    const existing = currentArgs.installedAgents ?? [];
    const nextInstalled = existing.map((agent) => {
      if (agent.key !== target.objectKey) return agent;
      return {
        ...agent,
        config: {
          ...(agent.config ?? {}),
          model,
        },
      };
    });
    if (!existing.some((agent) => agent.key === target.objectKey)) {
      throw new Error(`No persisted agent record found for ${participantId}`);
    }
    await setStateArgs({ installedAgents: nextInstalled });
    void persistWorkspaceDefaultModel(model).catch((err: unknown) => {
      console.warn("[ChatPanel] Failed to persist workspace default model:", err);
    });
  }, [persistWorkspaceDefaultModel]);

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
    onReplaceAgent: handleReplaceAgent,
    onConnectProvider: handleConnectProvider,
    onPersistAgentModel: handlePersistAgentModel,
    onRemoveAgent: handleRemoveAgent,
    availableAgents,
    modelCatalog,
    defaultModelRef: workspaceDefaultModelRef,
    connectedModelRefs,
    onFocusPanel: handleFocusPanel,
    onReloadPanel: handleReloadPanel,
  }), [handleNewConversation, handleAddAgent, handleReplaceAgent, handleConnectProvider, handlePersistAgentModel, handleRemoveAgent, availableAgents, modelCatalog, workspaceDefaultModelRef, connectedModelRefs, handleFocusPanel, handleReloadPanel]);

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
  const installedAgents = stateArgs.installedAgents ?? bootstrapInstalled ?? undefined;

  // Still bootstrapping — show a brief loading indicator
  if (!channelName) {
    return (
      <ErrorBoundary surfaceName="chat panel">
        <Theme appearance={theme}>
          <Flex
            align="center"
            justify="center"
            style={{
              minHeight: "100dvh",
              width: "100vw",
              maxWidth: "100%",
              boxSizing: "border-box",
              padding: 16,
              overflow: "hidden",
            }}
          >
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
        installedAgents={installedAgents}
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
