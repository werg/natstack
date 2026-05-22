/**
 * Spectrolite — Obsidian-style MDX knowledge base panel.
 *
 * On mount without a channelName, auto-generates one and spawns the default
 * AI chat agent DO with the Spectrolite system prompt. The panel and agent
 * share `contextId` so the agent's normal file-editing tools see the same
 * `.mdx` files the user is editing. No special edit RPC.
 *
 * Channel + agent bootstrap follows the chat panel pattern
 * (`workspace/panels/chat/index.tsx`) — same DO subscription, rehydration,
 * and stable-key persistence in stateArgs.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Flex, Spinner, Text, Theme } from "@radix-ui/themes";
import {
  contextId as runtimeContextId,
  useStateArgs,
  setStateArgs,
  getStateArgs,
} from "@workspace/runtime";
import { usePanelTheme } from "@workspace/react";
import { ErrorBoundary } from "@workspace/agentic-chat";
import {
  appendPendingAgent,
  createAndSubscribeAgent,
  getChannelDOParticipants,
  listAvailableAgents,
  newAgentKey,
  newChannelName,
  resolveContextId,
  unsubscribeDOFromChannel,
  type PendingAgentRecord,
} from "./bootstrap";
import { Workspace } from "./components/Workspace";
import { spectroliteAgentSystemPrompt } from "./agent-prompt";
import "./style.css";

// Silent agent worker is the default companion: it only sends a chat
// message when it explicitly calls its `say` tool, so the channel stays
// quiet during routine file edits. Spectrolite's primary signal channel
// is the kb.user_edit / file-edit loop, not chat.
const DEFAULT_WORKER_SOURCE = "workers/silent-agent-worker";
const DEFAULT_CLASS_NAME = "SilentAgentWorker";
const DEFAULT_HANDLE = "scribe";

interface SpectroliteStateArgs {
  channelName?: string;
  contextId?: string;
  pendingAgents?: PendingAgentRecord[];
  openPath?: string;
  /** Context-fs path of the currently selected vault (e.g. `/projects/default`). */
  repoRoot?: string;
}

function buildAgentConfig(opts: { handle: string; repoRoot: string | null }): Record<string, unknown> {
  return {
    handle: opts.handle,
    systemPrompt: spectroliteAgentSystemPrompt({
      workspaceRoot: opts.repoRoot ?? "/projects/<not-selected-yet>",
      handle: opts.handle,
    }),
    systemPromptMode: "append",
  };
}

function buildAddedAgentConfig(opts: { handle: string; repoRoot: string | null; className: string }): Record<string, unknown> {
  const base = buildAgentConfig({ handle: opts.handle, repoRoot: opts.repoRoot });
  if (opts.className === "TestAgentWorker") {
    return {
      ...base,
      deterministicResponse: true,
      writeVaultSwitchMarker: true,
      markerPath: "AgentProof.mdx",
      responseText: `Deterministic Spectrolite test agent @${opts.handle} handled the update.`,
      delayMs: 10,
    };
  }
  return base;
}

export default function SpectrolitePanel() {
  const theme = usePanelTheme();
  const stateArgs = useStateArgs<SpectroliteStateArgs>();
  const resolvedContextId = resolveContextId(stateArgs.contextId, runtimeContextId);
  // No default — until the user picks a vault, repoRoot is null and the
  // Workspace renders the VaultPicker instead of the editor. (The picker
  // surfaces `projects/default` as a pre-init'd option if it exists in
  // the workspace; that's the closest thing to a "default vault".)
  const repoRoot = stateArgs.repoRoot ?? null;

  const handleSelectVault = useCallback((contextPath: string) => {
    void setStateArgs({ repoRoot: contextPath, openPath: undefined });
  }, []);

  const handleSwitchVault = useCallback(() => {
    void setStateArgs({ repoRoot: undefined, openPath: undefined });
  }, []);

  const [bootstrapChannel, setBootstrapChannel] = useState<string | null>(null);
  const [bootstrapPending, setBootstrapPending] = useState<PendingAgentRecord[] | null>(null);
  const bootstrapAttempted = useRef(false);
  const defaultAgentAttempted = useRef(false);

  // Auto-bootstrap the channel on first mount. The default agent is
  // deliberately delayed until a vault is selected so its system prompt
  // contains a real workspace root instead of a placeholder.
  useEffect(() => {
    if (stateArgs.channelName || bootstrapAttempted.current || !resolvedContextId) return;
    bootstrapAttempted.current = true;

    const channelName = newChannelName();

    void setStateArgs({
      channelName,
      contextId: resolvedContextId,
      repoRoot,
    });

    setBootstrapChannel(channelName);
  }, [resolvedContextId, stateArgs.channelName, repoRoot]);

  // Create the default resident agent only after the user has picked a
  // vault. Additional manually-added agents still go through handleAddAgent.
  useEffect(() => {
    const channelName = stateArgs.channelName ?? bootstrapChannel;
    const pending = stateArgs.pendingAgents ?? bootstrapPending ?? [];
    if (!repoRoot || !resolvedContextId || !channelName) return;
    if (pending.length > 0 || defaultAgentAttempted.current) return;
    defaultAgentAttempted.current = true;

    const agentKey = newAgentKey(DEFAULT_HANDLE);
    const defaultAgent: PendingAgentRecord = {
      agentId: DEFAULT_CLASS_NAME,
      handle: DEFAULT_HANDLE,
      key: agentKey,
      source: DEFAULT_WORKER_SOURCE,
      className: DEFAULT_CLASS_NAME,
    };
    setBootstrapPending([defaultAgent]);
    void setStateArgs({ pendingAgents: [defaultAgent] });

    createAndSubscribeAgent({
      source: DEFAULT_WORKER_SOURCE,
      className: DEFAULT_CLASS_NAME,
      key: agentKey,
      channelId: channelName,
      channelContextId: resolvedContextId,
      config: buildAgentConfig({ handle: DEFAULT_HANDLE, repoRoot }),
      replay: true,
    }).catch((err: unknown) => {
      defaultAgentAttempted.current = false;
      setBootstrapPending(null);
      const cur = getStateArgs<SpectroliteStateArgs>();
      if ((cur.pendingAgents ?? []).some((agent) => agent.key === agentKey)) {
        void setStateArgs({
          pendingAgents: (cur.pendingAgents ?? []).filter((agent) => agent.key !== agentKey),
        });
      }
      console.warn("[Spectrolite] failed to subscribe default agent:", err);
    });
  }, [bootstrapChannel, bootstrapPending, resolvedContextId, repoRoot, stateArgs.channelName, stateArgs.pendingAgents]);

  // Rehydration: if channelName persists but no DO participants are subscribed
  // (host restart), re-create each persisted agent with the same stable key.
  const rehydrated = useRef(false);
  useEffect(() => {
    if (rehydrated.current || bootstrapAttempted.current) return;
    if (!stateArgs.channelName || !resolvedContextId) return;
    if (!repoRoot) return;
    rehydrated.current = true;
    const channelName = stateArgs.channelName;
    void (async () => {
      try {
        const dos = await getChannelDOParticipants(channelName);
        if (dos.length > 0) return;
        const list = stateArgs.pendingAgents ?? [];
        if (list.length === 0) return;
        for (const agent of list) {
          try {
            await createAndSubscribeAgent({
              source: agent.source,
              className: agent.className,
              key: agent.key,
              channelId: channelName,
              channelContextId: resolvedContextId,
              config: buildAgentConfig({ handle: agent.handle, repoRoot }),
              replay: true,
            });
          } catch (err) {
            console.warn(`[Spectrolite] rehydrate failed for @${agent.handle}:`, err);
          }
        }
      } catch (err) {
        console.warn("[Spectrolite] rehydration check failed:", err);
      }
    })();
  }, [stateArgs.channelName, stateArgs.pendingAgents, resolvedContextId, repoRoot]);

  const handleAddAgent = useCallback(async (agentId: string) => {
    if (!resolvedContextId) return;
    const channelName = (getStateArgs<SpectroliteStateArgs>().channelName) ?? bootstrapChannel;
    if (!channelName) return;
    const agents = await listAvailableAgents();
    const agent = agents.find((a) => a.id === agentId || a.className === agentId) ?? agents[0];
    if (!agent) return;
    const handle = `${agent.proposedHandle}-${crypto.randomUUID().slice(0, 4)}`;
    const key = newAgentKey(handle);
    await createAndSubscribeAgent({
      source: agent.id,
      className: agent.className,
      key,
      channelId: channelName,
      channelContextId: resolvedContextId,
      config: buildAddedAgentConfig({ handle, repoRoot, className: agent.className }),
    });
    const cur = getStateArgs<SpectroliteStateArgs>();
    await setStateArgs({
      pendingAgents: appendPendingAgent(cur.pendingAgents, {
        agentId: agent.className,
        handle,
        key,
        source: agent.id,
        className: agent.className,
      }),
    });
  }, [resolvedContextId, bootstrapChannel, repoRoot]);

  const handleRemoveAgent = useCallback(async (handle: string) => {
    const args = getStateArgs<SpectroliteStateArgs>();
    const channelName = args.channelName ?? bootstrapChannel;
    if (!channelName) return;
    const workers = await getChannelDOParticipants(channelName);
    // Look up the persisted record for this handle to get the EXACT
    // objectKey we minted on subscribe; prefix-matching by handle is
    // unsafe when handles share prefixes (e.g. "scribe" vs "scribe-x").
    const pendingRecord = (args.pendingAgents ?? []).find((a) => a.handle === handle);
    const match = pendingRecord
      ? workers.find((w) => w.objectKey === pendingRecord.key)
      : null;
    if (match) {
      await unsubscribeDOFromChannel(match.source, match.className, match.objectKey, channelName);
    } else if (!pendingRecord && workers.length === 1) {
      // Legacy fallback only when we have no persisted record — and only
      // if there's a single worker, so we can't pick wrong.
      const w = workers[0]!;
      await unsubscribeDOFromChannel(w.source, w.className, w.objectKey, channelName);
    } else if (!match) {
      console.warn(`[Spectrolite] no DO worker matches handle "${handle}" (key=${pendingRecord?.key ?? "?"})`);
    }
    const cur = getStateArgs<SpectroliteStateArgs>();
    await setStateArgs({
      pendingAgents: (cur.pendingAgents ?? []).filter((a) => a.handle !== handle),
    });
  }, [bootstrapChannel]);

  const channelName = stateArgs.channelName ?? bootstrapChannel;
  const pending = stateArgs.pendingAgents ?? bootstrapPending ?? [];

  if (!channelName || !resolvedContextId) {
    return (
      <ErrorBoundary>
        <Theme appearance={theme}>
          <Flex align="center" justify="center" gap="2" style={{ height: "100dvh" }}>
            <Spinner />
            <Text size="2" color="gray">Starting Spectrolite…</Text>
          </Flex>
        </Theme>
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <Workspace
        channelName={channelName}
        channelContextId={resolvedContextId}
        repoRoot={repoRoot}
        primaryAgentHandle={pending[0]?.handle}
        onAddAgent={handleAddAgent}
        onRemoveAgent={handleRemoveAgent}
        onSelectVault={handleSelectVault}
        onSwitchVault={handleSwitchVault}
      />
    </ErrorBoundary>
  );
}
