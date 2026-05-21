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

const DEFAULT_WORKER_SOURCE = "workers/agent-worker";
const DEFAULT_CLASS_NAME = "AiChatWorker";
const DEFAULT_HANDLE = "scribe";
const DEFAULT_WORKSPACE_ROOT = "/workspace";

interface SpectroliteStateArgs {
  channelName?: string;
  contextId?: string;
  pendingAgents?: PendingAgentRecord[];
  openPath?: string;
  /** Absolute repo root inside the panel's context filesystem. */
  repoRoot?: string;
}

function buildAgentConfig(opts: { handle: string; repoRoot: string }): Record<string, unknown> {
  return {
    handle: opts.handle,
    systemPrompt: spectroliteAgentSystemPrompt({
      workspaceRoot: opts.repoRoot,
      handle: opts.handle,
    }),
    systemPromptMode: "append",
  };
}

export default function SpectrolitePanel() {
  const theme = usePanelTheme();
  const stateArgs = useStateArgs<SpectroliteStateArgs>();
  const resolvedContextId = resolveContextId(stateArgs.contextId, runtimeContextId);
  const repoRoot = stateArgs.repoRoot ?? DEFAULT_WORKSPACE_ROOT;

  const [bootstrapChannel, setBootstrapChannel] = useState<string | null>(null);
  const [bootstrapPending, setBootstrapPending] = useState<PendingAgentRecord[] | null>(null);
  const bootstrapAttempted = useRef(false);

  // Auto-bootstrap on first mount when no channel exists
  useEffect(() => {
    if (stateArgs.channelName || bootstrapAttempted.current || !resolvedContextId) return;
    bootstrapAttempted.current = true;

    const channelName = newChannelName();
    const agentKey = newAgentKey(DEFAULT_HANDLE);
    const pending: PendingAgentRecord[] = [{
      agentId: DEFAULT_CLASS_NAME,
      handle: DEFAULT_HANDLE,
      key: agentKey,
      source: DEFAULT_WORKER_SOURCE,
      className: DEFAULT_CLASS_NAME,
    }];

    void setStateArgs({
      channelName,
      contextId: resolvedContextId,
      pendingAgents: pending,
      repoRoot,
    });

    createAndSubscribeAgent({
      source: DEFAULT_WORKER_SOURCE,
      className: DEFAULT_CLASS_NAME,
      key: agentKey,
      channelId: channelName,
      channelContextId: resolvedContextId,
      config: buildAgentConfig({ handle: DEFAULT_HANDLE, repoRoot }),
      replay: true,
    }).catch((err: unknown) => {
      console.warn("[Spectrolite] failed to subscribe default agent:", err);
    });

    setBootstrapChannel(channelName);
    setBootstrapPending(pending);
  }, [resolvedContextId, stateArgs.channelName, repoRoot]);

  // Rehydration: if channelName persists but no DO participants are subscribed
  // (host restart), re-create each persisted agent with the same stable key.
  const rehydrated = useRef(false);
  useEffect(() => {
    if (rehydrated.current || bootstrapAttempted.current) return;
    if (!stateArgs.channelName || !resolvedContextId) return;
    rehydrated.current = true;
    const channelName = stateArgs.channelName;
    void (async () => {
      try {
        const dos = await getChannelDOParticipants(channelName);
        if (dos.length > 0) return;
        const list = stateArgs.pendingAgents ?? [{
          agentId: DEFAULT_CLASS_NAME,
          handle: DEFAULT_HANDLE,
          key: newAgentKey(DEFAULT_HANDLE),
          source: DEFAULT_WORKER_SOURCE,
          className: DEFAULT_CLASS_NAME,
        }];
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
      config: buildAgentConfig({ handle, repoRoot }),
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
    const channelName = (getStateArgs<SpectroliteStateArgs>().channelName) ?? bootstrapChannel;
    if (!channelName) return;
    const workers = await getChannelDOParticipants(channelName);
    const match = workers.find((w) => w.objectKey.startsWith(handle));
    if (match) {
      await unsubscribeDOFromChannel(match.source, match.className, match.objectKey, channelName);
    } else if (workers.length === 1) {
      const w = workers[0]!;
      await unsubscribeDOFromChannel(w.source, w.className, w.objectKey, channelName);
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
      />
    </ErrorBoundary>
  );
}
