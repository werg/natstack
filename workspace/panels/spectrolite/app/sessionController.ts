/**
 * Session controller — channel lifecycle + resident-agent management.
 *
 * Replaces the three racing useEffect chains that previously lived in
 * index.tsx (bootstrap / default agent / rehydrate) with one sequential,
 * idempotent `start()` flow:
 *
 *   1. ensure a channel name exists (mint + persist on first run)
 *   2. connect the PubSub client
 *   3. register Spectrolite's custom message types
 *   4. subscribe roster + consume the event stream into the store
 *   5. if a vault is already selected: bootstrap the default agent
 *      (fresh channel) or rehydrate persisted agents (host restart)
 *
 * Vault selection later calls `onVaultSelected()`, which runs step 5 and
 * notifies the resident agents that their workspace root moved.
 */

import { connectViaRpc, type PubSubClient } from "@workspace/pubsub";
import { rpc, panel } from "@workspace/runtime";
import { recoveryCoordinator } from "@workspace/runtime/internal/diagnostics";
import type { ChatParticipantMetadata } from "@workspace/agentic-core";
import type { Store } from "./store";
import type { ChannelMessage, RosterAgent, SpectroliteState } from "./state";
import {
  createAndSubscribeAgent,
  getChannelDOParticipants,
  listAvailableAgents,
  newAgentKey,
  newChannelName,
  unsubscribeDOFromChannel,
  type InstalledAgentRecord,
} from "../bootstrap";
import { registerSpectroliteMessageTypes } from "../messages/register";
import { spectroliteAgentSystemPrompt } from "../agent-prompt";

// The silent agent worker is the default companion: it only sends a chat
// message when it explicitly calls its `say` tool, so the channel stays
// quiet during routine file edits.
const DEFAULT_WORKER_SOURCE = "workers/silent-agent-worker";
const DEFAULT_CLASS_NAME = "SilentAgentWorker";
const DEFAULT_HANDLE = "scribe";

const MAX_MESSAGES = 50;

/** Spectrolite's own participant handle on the channel. */
export const PANEL_HANDLE = "spectrolite";

const PANEL_METADATA = {
  name: "Spectrolite",
  type: "panel" as const,
  handle: PANEL_HANDLE,
};

function buildAgentConfig(opts: { handle: string; repoRoot: string | null; className?: string }): Record<string, unknown> {
  const base: Record<string, unknown> = {
    handle: opts.handle,
    systemPrompt: spectroliteAgentSystemPrompt({
      workspaceRoot: opts.repoRoot ?? "/projects/<not-selected-yet>",
      handle: opts.handle,
    }),
    systemPromptMode: "append",
  };
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

export class SessionController {
  private client: PubSubClient<ChatParticipantMetadata> | null = null;
  private disposed = false;
  private started = false;
  /** Vault the agents were last scoped to; null until the first selection is observed. */
  private agentVault: string | null = null;
  private agentsEnsured = false;
  private agentsEnsureInFlight = false;
  private agentEnsureRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private agentEnsureRetryAttempt = 0;
  private unsubscribeRoster: (() => void) | null = null;

  constructor(
    private readonly store: Store<SpectroliteState>,
  ) {}

  async start(): Promise<void> {
    if (this.started || this.disposed) return;
    this.started = true;
    const state = this.store.getState();
    const contextId = state.contextId;
    if (!contextId) {
      console.warn("[Spectrolite] no context id — cannot start a channel session");
      return;
    }

    let channelName = state.channelName;
    if (!channelName) {
      channelName = newChannelName();
      this.store.setState({ channelName });
      void panel.stateArgs.set({ channelName, contextId, repoRoot: state.repoRoot ?? undefined });
    }

    const client = connectViaRpc<ChatParticipantMetadata>({
      rpc,
      channel: channelName,
      contextId,
      clientId: panel.slotId,
      metadata: PANEL_METADATA,
      recoveryCoordinator,
    });
    this.client = client;
    this.store.setState({ client });

    void client.ready()
      .then(() => registerSpectroliteMessageTypes(client))
      .catch((err) => console.warn("[Spectrolite] message type registration failed:", err));

    this.unsubscribeRoster = client.onRoster(() => this.handleRosterUpdate());
    void this.consumeEvents(client);
    void listAvailableAgents()
      .then((agents) => { if (!this.disposed) this.store.setState({ availableAgents: agents }); })
      .catch(() => {});

    // A vault may already be selected (persisted stateArgs / initPanels).
    const repoRoot = this.store.getState().repoRoot;
    if (repoRoot) {
      this.agentVault = repoRoot;
      await this.ensureAgents();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribeRoster?.();
    this.unsubscribeRoster = null;
    if (this.agentEnsureRetryTimer) {
      clearTimeout(this.agentEnsureRetryTimer);
      this.agentEnsureRetryTimer = null;
    }
    this.client?.close();
    this.client = null;
  }

  /**
   * The vault is bound (this panel runs under the vault's context). Ensure the
   * resident scribe exists for this vault. Switching vault reopens the panel
   * under a new context, so a single session only ever sees one vault.
   */
  onVaultSelected(repoRoot: string): void {
    if (this.agentVault === repoRoot) return;
    this.agentVault = repoRoot;
    void this.ensureAgents();
  }

  async send(content: string, options?: { mentions?: string[] }): Promise<void> {
    const client = this.client;
    if (!client) throw new Error("Channel not connected");
    await client.send(content, options);
  }

  openDock(): void {
    this.store.setState((prev) => ({ dockOpenSignal: prev.dockOpenSignal + 1 }));
  }

  // ---- agent management ----

  async addAgent(agentId: string): Promise<void> {
    const state = this.store.getState();
    const channelName = state.channelName;
    const contextId = state.contextId;
    if (!channelName || !contextId) return;
    const agents = state.availableAgents.length > 0 ? state.availableAgents : await listAvailableAgents();
    const agent = agents.find((a) => a.id === agentId || a.className === agentId) ?? agents[0];
    if (!agent) return;
    const handle = `${agent.proposedHandle}-${crypto.randomUUID().slice(0, 4)}`;
    const key = newAgentKey(handle);
    await createAndSubscribeAgent({
      source: agent.id,
      className: agent.className,
      key,
      channelId: channelName,
      channelContextId: contextId,
      config: buildAgentConfig({ handle, repoRoot: this.store.getState().repoRoot, className: agent.className }),
    });
    this.persistInstalled([
      ...this.store.getState().installedAgents,
      { agentId: agent.className, handle, key, source: agent.id, className: agent.className },
    ]);
  }

  async removeAgent(handle: string): Promise<void> {
    const state = this.store.getState();
    const channelName = state.channelName;
    if (!channelName) return;
    // Optimistic hide; rolled back if the unsubscribe fails.
    this.store.setState((prev) => ({ removedHandles: [...prev.removedHandles, handle] }));
    try {
      const workers = await getChannelDOParticipants(channelName);
      // Match by the EXACT objectKey we minted on subscribe; prefix-matching
      // by handle is unsafe when handles share prefixes ("scribe" vs "scribe-x").
      const record = state.installedAgents.find((a) => a.handle === handle);
      const match = record ? workers.find((w) => w.objectKey === record.key) : null;
      if (match) {
        await unsubscribeDOFromChannel(match.source, match.className, match.objectKey, channelName);
      } else {
        console.warn(`[Spectrolite] no DO worker matches handle "${handle}" (key=${record?.key ?? "?"})`);
      }
      this.persistInstalled(this.store.getState().installedAgents.filter((a) => a.handle !== handle));
    } catch (err) {
      this.store.setState((prev) => ({ removedHandles: prev.removedHandles.filter((h) => h !== handle) }));
      throw err;
    }
  }

  // ---- internals ----

  private persistInstalled(installed: InstalledAgentRecord[]): void {
    this.store.setState({ installedAgents: installed });
    void panel.stateArgs.set({ installedAgents: installed });
  }

  /**
   * Make sure the persisted agents actually exist as channel DOs.
   * No persisted agents → create the default scribe. Persisted agents
   * without live DO participants → re-create each with its stable key
   * (replay so it catches up on missed events).
   */
  private async ensureAgents(): Promise<void> {
    if (this.agentsEnsured || this.agentsEnsureInFlight || this.disposed) return;
    this.agentsEnsureInFlight = true;
    const state = this.store.getState();
    const { channelName, contextId, repoRoot } = state;
    if (!channelName || !contextId || !repoRoot) {
      this.agentsEnsureInFlight = false;
      return;
    }

    try {
      if (state.installedAgents.length === 0) {
        const agentKey = newAgentKey(DEFAULT_HANDLE);
        const defaultAgent: InstalledAgentRecord = {
          agentId: DEFAULT_CLASS_NAME,
          handle: DEFAULT_HANDLE,
          key: agentKey,
          source: DEFAULT_WORKER_SOURCE,
          className: DEFAULT_CLASS_NAME,
        };
        this.persistInstalled([defaultAgent]);
        try {
          await createAndSubscribeAgent({
            source: DEFAULT_WORKER_SOURCE,
            className: DEFAULT_CLASS_NAME,
            key: agentKey,
            channelId: channelName,
            channelContextId: contextId,
            config: buildAgentConfig({ handle: DEFAULT_HANDLE, repoRoot }),
            replay: true,
          });
        } catch (err) {
          this.persistInstalled(this.store.getState().installedAgents.filter((a) => a.key !== agentKey));
          console.warn("[Spectrolite] failed to subscribe default agent:", err);
          this.scheduleEnsureAgentsRetry();
          return;
        }
        this.markAgentsEnsured();
        return;
      }

      // Rehydration: if persisted agent keys are missing from the channel
      // DO list, re-create those agents with stable keys. This covers
      // host restarts, picker-screen restarts, and partial rehydrate failures.
      const dos = await getChannelDOParticipants(channelName);
      const liveKeys = new Set(dos.map((worker) => worker.objectKey));
      const missing = state.installedAgents.filter((agent) => !liveKeys.has(agent.key));
      if (missing.length === 0) {
        this.markAgentsEnsured();
        return;
      }

      let failed = false;
      for (const agent of missing) {
        try {
          await createAndSubscribeAgent({
            source: agent.source,
            className: agent.className,
            key: agent.key,
            channelId: channelName,
            channelContextId: contextId,
            config: buildAgentConfig({ handle: agent.handle, repoRoot, className: agent.className }),
            replay: true,
          });
        } catch (err) {
          failed = true;
          console.warn(`[Spectrolite] rehydrate failed for @${agent.handle}:`, err);
        }
      }
      if (failed) this.scheduleEnsureAgentsRetry();
      else this.markAgentsEnsured();
    } catch (err) {
      console.warn("[Spectrolite] rehydration check failed:", err);
      this.scheduleEnsureAgentsRetry();
    } finally {
      this.agentsEnsureInFlight = false;
    }
  }

  private markAgentsEnsured(): void {
    this.agentsEnsured = true;
    this.agentEnsureRetryAttempt = 0;
    if (this.agentEnsureRetryTimer) {
      clearTimeout(this.agentEnsureRetryTimer);
      this.agentEnsureRetryTimer = null;
    }
  }

  private scheduleEnsureAgentsRetry(): void {
    if (this.disposed || this.agentEnsureRetryTimer) return;
    this.agentsEnsured = false;
    const delayMs = Math.min(30_000, 1_000 * (2 ** this.agentEnsureRetryAttempt));
    this.agentEnsureRetryAttempt += 1;
    this.agentEnsureRetryTimer = setTimeout(() => {
      this.agentEnsureRetryTimer = null;
      void this.ensureAgents();
    }, delayMs);
  }

  private handleRosterUpdate(): void {
    const client = this.client;
    if (!client || this.disposed) return;
    const next: RosterAgent[] = [];
    for (const participant of Object.values(client.roster)) {
      const meta = participant.metadata as { handle?: string; type?: string };
      if (meta.type === "panel" || !meta.handle) continue;
      next.push({ handle: meta.handle, participantId: participant.id, status: "live" });
    }
    this.store.setState((prev) => {
      const liveHandles = new Set(next.map((agent) => agent.handle));
      const removedHandles = prev.removedHandles.filter((handle) => liveHandles.has(handle));
      return {
        roster: next,
        removedHandles: removedHandles.length === prev.removedHandles.length ? prev.removedHandles : removedHandles,
      };
    });
  }

  /** Stream completed chat messages into the store for the channel dock. */
  private async consumeEvents(client: PubSubClient<ChatParticipantMetadata>): Promise<void> {
    try {
      for await (const event of client.events({ includeReplay: true, includeSignals: false })) {
        if (this.disposed || this.client !== client) return;
        const wire = event as unknown as {
          type?: string;
          messageId?: string;
          senderId?: string;
          senderMetadata?: { handle?: string; name?: string; type?: string };
          ts?: number;
          payload?: { kind?: string; payload?: { content?: string } };
        };
        if (wire.type !== "agentic.trajectory.v1/event") continue;
        const evt = wire.payload;
        // Only completed messages — partial streaming chunks would flicker.
        if (!evt || evt.kind !== "message.completed") continue;
        const content = evt.payload?.content;
        if (typeof content !== "string" || !content) continue;
        const id = wire.messageId ?? `${wire.senderId ?? "?"}-${wire.ts ?? Date.now()}`;
        const message: ChannelMessage = {
          id,
          senderId: wire.senderId ?? "?",
          senderHandle: wire.senderMetadata?.handle,
          senderName: wire.senderMetadata?.name,
          senderType: wire.senderMetadata?.type,
          content,
          ts: wire.ts ?? Date.now(),
        };
        this.store.setState((prev) => {
          if (prev.messages.some((m) => m.id === id)) return {};
          return { messages: [...prev.messages, message].slice(-MAX_MESSAGES) };
        });
      }
    } catch (err) {
      if (!this.disposed) console.warn("[Spectrolite] channel event stream ended:", err);
    }
  }
}
