/**
 * AgentWorkerBase — Pi-native agent DO base.
 *
 * Embeds `@mariozechner/pi-agent-core`'s `Agent` in-process via `PiRunner`
 * from `@natstack/harness`. One PiRunner per channel, owned by the DO for
 * the lifetime of the chat. The runner drives agent state (messages,
 * streaming, tool calls); the DO persists `AgentMessage[]` snapshots to
 * its SQL storage and forwards runner events to the channel as ephemeral
 * events.
 *
 * Composes:
 * - `DOIdentity`: stable DO ref + workerd session id
 * - `SubscriptionManager`: channel membership + replay state
 * - `ContinuationStore`: pending callId continuations for tool callMethod
 *   and feedback_form / inline UI awaits (Promise resolution from onCallResult)
 * - `ChannelClient`: typed wrapper around channel DO RPC
 * - `TurnDispatcher` (one per channel): queues user messages, chooses
 *   runTurn vs steer, self-heals pi-core's steering-queue exit race,
 *   drives the typing indicator from real busy state
 * - `ContentBlockProjector` (one per channel): maps Pi content events
 *   onto channel messages
 *
 * Publishes Pi events as real channel messages via `ContentBlockProjector`
 * (one channel message per Pi content block):
 * - Text blocks stream via send → delta updates → complete
 * - Thinking blocks stream via send → delta updates (append flag) → complete
 * - Tool calls publish as contentType "toolCall" (ToolCallPayload snapshot)
 * - Tool-result images fold into the tool call's `execution.resultImages`
 *
 * Message dispatch flow (normal turn):
 *   onChannelEvent → refreshRoster → getOrCreateRunner → resizeAttachments
 *     → runner.buildUserMessage → TurnDispatcher.submit
 *   TurnDispatcher routes to runTurnMessage (idle) or steerMessage (mid-run);
 *   typing indicator reflects `running || pending || pendingSteered > 0`.
 */

import { DurableObjectBase, type DurableObjectContext, type DORef } from "@workspace/runtime/worker";
import type {
  Attachment,
  ChannelEvent,
  ParticipantDescriptor,
  TurnInput,
  UnsubscribeResult,
} from "@natstack/harness/types";
import { isClientParticipantType } from "@natstack/pubsub";
import {
  PiRunner,
  isNotLoggedInError,
  providerDisplayName,
  type ChannelToolMethod,
  type NatStackUIBridgeCallbacks,
  type AskUserParams,
  type ApprovalLevel,
  type ThinkingLevel,
} from "@natstack/harness";
import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
import type { ImageContent } from "@mariozechner/pi-ai";

import { DOIdentity } from "./identity.js";
import { SubscriptionManager } from "./subscription-manager.js";
import { ContinuationStore } from "./continuation-store.js";
import { ChannelClient } from "./channel-client.js";
import { ContentBlockProjector, type ProjectorSink } from "./content-block-projector.js";
import { TurnDispatcher } from "./turn-dispatcher.js";

const SAFE_TOOL_NAMES_DEFAULT: ReadonlySet<string> = new Set([
  "read",
  "ls",
  "grep",
  "find",
]);

/**
 * TSX source for the OAuth Connect card pushed into the chat as an inline_ui
 * message when the model provider is not yet logged in. The chat panel's
 * `useInlineUi` hook compiles this via `compileComponent`/`transformCode` and
 * renders the resulting React component inside `<InlineUiMessage>`.
 *
 * Available imports inside the inline_ui sandbox: see
 * `workspace/skills/sandbox/INLINE_UI.md`. The component receives
 * `{ props, chat }` where `chat.rpc.call` is the panel's runtime RPC.
 *
 * The button calls `auth.startOAuthLogin(providerId)` directly. Server-side
 * idempotency in the auth service handles concurrent / repeated clicks:
 *   - First click → starts the OAuth flow, returns success on completion.
 *   - Concurrent clicks → return the same in-flight Promise.
 *   - Clicks after success → fast path returns success immediately.
 */
const OAUTH_CONNECT_CARD_TSX = `
import { useState } from "react";
import { Box, Button, Card, Flex, Text } from "@radix-ui/themes";

export default function OAuthConnectCard({ props, chat }) {
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState(null);
  const providerId = props.providerId;
  const displayName = props.displayName;

  const handleConnect = async () => {
    setStatus("connecting");
    setError(null);
    try {
      const result = await chat.rpc.call("main", "auth.startOAuthLogin", providerId);
      if (result && result.success) {
        setStatus("connected");
        // Auto-retry: publish a message so the agent's turn restarts with
        // valid credentials. The agent worker's onChannelEvent picks this up
        // and calls runner.runTurn, which calls getApiKey — this time it
        // succeeds because the auth service now has fresh OAuth credentials.
        chat.publish("message", {
          content: "Connected to " + displayName + ". Please continue where you left off."
        });
      } else {
        setStatus("error");
        setError((result && result.error) || "Login failed");
      }
    } catch (err) {
      setStatus("error");
      setError(err && err.message ? err.message : String(err));
    }
  };

  return (
    <Card variant="surface" size="2">
      <Flex direction="column" gap="3">
        <Box>
          <Text as="div" size="2" weight="medium">Sign in to {displayName}</Text>
          <Text as="div" size="1" color="gray" mt="1">
            To continue, this workspace needs to connect your {displayName} account.
            Click below to open the sign-in page in your browser.
          </Text>
        </Box>
        {status === "idle" && (
          <Button onClick={handleConnect}>Connect to {displayName}</Button>
        )}
        {status === "connecting" && (
          <Button disabled>Waiting for browser\\u2026</Button>
        )}
        {status === "connected" && (
          <Text size="2" color="green" weight="medium">Connected to {displayName}</Text>
        )}
        {status === "error" && (
          <Flex direction="column" gap="2">
            <Text size="1" color="red">{error}</Text>
            <Button onClick={handleConnect} variant="soft">Try again</Button>
          </Flex>
        )}
      </Flex>
    </Card>
  );
}
`.trim();

interface RunnerEntry {
  runner: PiRunner;
}

/** Resolves at the channel boundary when `onCallResult` arrives. */
interface PendingResolver {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

export abstract class AgentWorkerBase extends DurableObjectBase {
  static override schemaVersion = 8;

  protected identity: DOIdentity;
  protected subscriptions: SubscriptionManager;
  protected continuations: ContinuationStore;

  /** One PiRunner per channel — created lazily on first user message. */
  private runners = new Map<string, RunnerEntry>();

  /** Channels whose `fs.bindContext` has been called at least once per DO
   *  lifetime. The FsService caller→context map is process-scoped, so we
   *  only need to bind once per DO startup per context. */
  private _fsContextBound = new Set<string>();

  /** In-flight Promise resolvers keyed by callId. Used for tool callMethod
   *  and UI feedback_form awaits — when the channel routes the result via
   *  onCallResult, we resolve the corresponding Promise. */
  private pendingResolvers = new Map<string, PendingResolver>();

  /** Streaming callbacks keyed by method callId. When a method-result event
   *  arrives with complete:false, the callback is invoked with the content.
   *  This bridges ctx.stream() from method providers to Pi's onUpdate. */
  private streamCallbacks = new Map<string, (content: unknown) => void>();

  /** OAuth Connect cards already emitted into a channel for a given provider.
   *  Keys are `${channelId}::${providerId}`. Process-scoped — resets on DO
   *  hibernation, which is fine because the next agent run will re-emit if
   *  the user hasn't connected yet. */
  private oauthCardsEmitted = new Set<string>();

  /** Phase 0D: Transient poison message tracker. Resets on hibernation. */
  private failedEvents = new Map<number, number>();
  private static readonly POISON_MAX_ATTEMPTS = 3;

  constructor(ctx: DurableObjectContext, env: unknown) {
    super(ctx, env);

    const lazyRpc = {
      call: <T = unknown>(targetId: string, method: string, ...args: unknown[]): Promise<T> => {
        return this.rpc.call<T>(targetId, method, ...args);
      },
    };

    this.identity = new DOIdentity(this.sql);
    this.subscriptions = new SubscriptionManager(
      this.sql,
      (channelId) => new ChannelClient(lazyRpc, channelId),
      this.identity,
    );
    this.continuations = new ContinuationStore(this.sql);

    this.ensureReady();
    this.identity.restore();
  }

  protected createTables(): void {
    this.identity.createTables();
    this.subscriptions.createTables();
    this.continuations.createTables();
    // Delivery cursor for event dedup + gap repair.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS delivery_cursor (
        channel_id TEXT PRIMARY KEY,
        last_delivered_seq INTEGER NOT NULL
      )
    `);
    // Legacy table — kept for lazy migration to pi_messages.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS pi_sessions (
        channel_id TEXT PRIMARY KEY,
        messages_blob TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    // Per-channel Pi agent message history for warm restore after DO hibernation.
    // One row per message — avoids SQLITE_TOOBIG on long conversations and
    // makes persist append-only instead of full-rewrite.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS pi_messages (
        channel_id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        content TEXT NOT NULL,
        PRIMARY KEY (channel_id, idx)
      )
    `);
  }

  // ── Identity bootstrap ──────────────────────────────────────────────────

  private _bootstrapped = false;

  private ensureBootstrapped(): void {
    if (this._bootstrapped) return;
    try {
      const key = this.objectKey;
      const source = (this.env as Record<string, string>)["WORKER_SOURCE"];
      const className = (this.env as Record<string, string>)["WORKER_CLASS_NAME"];
      const sessionId = (this.env as Record<string, string>)["WORKERD_SESSION_ID"];
      if (source && className && sessionId) {
        const doRef: DORef = { source, className, objectKey: key };
        this.identity.bootstrap(doRef, sessionId);
        this._bootstrapped = true;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("objectKey not available")) {
        console.error("[AgentWorkerBase] ensureBootstrapped failed:", err);
      }
    }
  }

  protected get doRef(): DORef {
    return this.identity.ref;
  }

  protected createChannelClient(channelId: string): ChannelClient {
    return new ChannelClient(this.rpc, channelId);
  }

  // ── Customization hooks (Pi-native) ─────────────────────────────────────

  /**
   * Model id in `provider:model` format (e.g. `anthropic:claude-sonnet-4-20250514`,
   * `openai-codex:gpt-5`). Subclasses override to pick a different default.
   * PiRunner passes this directly to `pi-ai.getModel(provider, modelId)`.
   */
  protected getModel(): string {
    return "anthropic:claude-sonnet-4-20250514";
  }

  protected getThinkingLevel(): ThinkingLevel {
    return "medium";
  }

  protected getApprovalLevel(channelId: string): ApprovalLevel {
    const value = this.getStateValue(`approvalLevel:${channelId}`);
    if (!value) return 2; // Default: full auto
    const parsed = parseInt(value, 10);
    if (parsed === 0 || parsed === 1 || parsed === 2) return parsed;
    return 2;
  }

  protected setApprovalLevel(channelId: string, level: ApprovalLevel): void {
    this.setStateValue(`approvalLevel:${channelId}`, String(level));
    const entry = this.runners.get(channelId);
    if (entry) entry.runner.setApprovalLevel(level);
  }

  protected shouldProcess(event: ChannelEvent): boolean {
    if (event.type !== "message") return false;
    if (event.contentType) return false;
    const senderType = event.senderMetadata?.["type"] as string | undefined;
    if (!isClientParticipantType(senderType)) return false;
    return true;
  }

  protected buildTurnInput(event: ChannelEvent): TurnInput {
    const payload = event.payload as { content?: string; attachments?: Attachment[] };
    return { content: payload.content ?? "", senderId: event.senderId, attachments: event.attachments };
  }

  protected getParticipantInfo(_channelId: string, config?: unknown): ParticipantDescriptor {
    const cfg = config as Record<string, unknown> | undefined;
    return {
      handle: (cfg?.["handle"] as string) ?? "agent",
      name: "AI Agent",
      type: "agent",
      metadata: {},
      methods: [],
    };
  }

  // ── Subscription lifecycle ──────────────────────────────────────────────

  async subscribeChannel(opts: {
    channelId: string;
    contextId: string;
    config?: unknown;
    replay?: boolean;
  }): Promise<{ ok: boolean; participantId: string }> {
    const descriptor = this.getParticipantInfo(opts.channelId, opts.config);
    const result = await this.subscriptions.subscribe({
      channelId: opts.channelId,
      contextId: opts.contextId,
      config: opts.config,
      descriptor,
      replay: opts.replay,
    });

    // Bind this DO's caller identity to the context folder in FsService's
    // caller→context map. Required before `runtime.fs.*` calls can resolve
    // paths. Idempotent; guarded by _fsContextBound so we don't re-call
    // across repeated subscribes to the same context.
    if (!this._fsContextBound.has(opts.contextId)) {
      try {
        await this.rpc.call<void>("main", "fs.bindContext", opts.contextId);
        this._fsContextBound.add(opts.contextId);
      } catch (err) {
        console.warn(
          `[AgentWorkerBase] fs.bindContext failed for contextId=${opts.contextId}:`,
          err,
        );
      }
    }

    if (result.channelConfig?.["approvalLevel"] != null) {
      const level = result.channelConfig["approvalLevel"] as number;
      if (level === 0 || level === 1 || level === 2) {
        this.setApprovalLevel(opts.channelId, level);
      }
    }

    if (result.replay) {
      try {
        for (const event of result.replay) {
          // Sequential mode: missed messages run as independent turns rather
          // than collapsing into a single steered run. Without this, the 2nd
          // and later replay events would hit `running=true` (set by the 1st
          // event's drainLoop pre-await) and route to steer.
          await this.onChannelEvent(opts.channelId, event, { mode: "sequential" });
        }
      } catch (err) {
        console.warn(`[AgentWorkerBase] Replay processing stopped:`, err);
      }
    }

    // Proactive auth check. Two reasons to do this here:
    //  1. With ephemeral OAuth Connect cards, panel reload erases any
    //     prior card; the user would be stuck staring at chat history
    //     with no Connect button until they typed a message. Pushing on
    //     subscribe keeps the card present across reloads.
    //  2. On a fresh chat panel (no message sent yet) we can already see
    //     the configured model needs auth — surfacing the card early
    //     means the user signs in before composing, not after.
    void this.maybeEmitOAuthCardOnSubscribe(opts.channelId);

    return { ok: result.ok, participantId: result.participantId };
  }

  /**
   * Reset the OAuth-card dedupe entry for this channel and probe the
   * configured model's auth status. If the provider needs OAuth and we
   * don't have a valid token, push a fresh ephemeral Connect card.
   */
  private async maybeEmitOAuthCardOnSubscribe(channelId: string): Promise<void> {
    const model = this.getModel();
    const colon = model.indexOf(":");
    const providerId = colon > 0 ? model.slice(0, colon) : model;
    // Drop any stale dedupe entry from before the panel reloaded so the
    // card can re-emit. The set is in-memory; entries from a hibernated
    // DO are already gone, but a same-process re-subscribe also needs
    // this to push afresh.
    this.oauthCardsEmitted.delete(`${channelId}::${providerId}`);
    try {
      await this.rpc.call<string>("main", "authTokens.getProviderToken", providerId);
    } catch (err) {
      if (!isNotLoggedInError(err)) return; // network blip etc — ignore here, the next turn will surface it
      this.buildUICallbacks(channelId).requestProviderOAuth(
        providerId,
        providerDisplayName(providerId),
      );
    }
  }

  async unsubscribeChannel(channelId: string): Promise<UnsubscribeResult> {
    await this.subscriptions.unsubscribeFromChannel(channelId);

    // Dispose dispatcher before the runner — unsubscribes its listener
    // and broadcasts typing off.
    const dispatcher = this.dispatchers.get(channelId);
    if (dispatcher) {
      dispatcher.dispose();
      this.dispatchers.delete(channelId);
    }

    const entry = this.runners.get(channelId);
    if (entry) {
      entry.runner.dispose();
      this.runners.delete(channelId);
    }

    // Clean up per-channel projector state. closeAll before deletion so any
    // still-open channel messages receive their final `complete` (defensive —
    // the runner.dispose above should have drained pi events already).
    const projector = this.projectors.get(channelId);
    if (projector) {
      try { await projector.closeAll(); }
      catch (err) {
        console.warn(`[AgentWorkerBase] projector.closeAll on unsubscribe failed for ${channelId}:`, err);
      }
      this.projectors.delete(channelId);
    }

    this.continuations.deleteForChannel(channelId);
    this.subscriptions.deleteSubscription(channelId);
    this.sql.exec(`DELETE FROM pi_messages WHERE channel_id = ?`, channelId);
    this.sql.exec(`DELETE FROM pi_sessions WHERE channel_id = ?`, channelId);

    return { ok: true };
  }

  // ── Channel event pipeline (dedup → gap repair → dispatch) ──────────────

  private async handleIncomingChannelEvent(channelId: string, event: ChannelEvent): Promise<void> {
    const eventId = event.id;

    if (eventId !== undefined && eventId > 0) {
      const lastSeq = this.getDeliveryCursor(channelId);
      if (eventId <= lastSeq) return;

      if (eventId > lastSeq + 1) {
        await this.repairGap(channelId, lastSeq, eventId);
      }

      const attempts = this.failedEvents.get(eventId) ?? 0;
      if (attempts >= AgentWorkerBase.POISON_MAX_ATTEMPTS) {
        console.error(`[AgentWorkerBase] Skipping poison event id=${eventId} after ${attempts} failed attempts`);
        this.advanceDeliveryCursor(channelId, eventId);
        this.failedEvents.delete(eventId);
        return;
      }
    }

    try {
      await this.dispatchChannelEvent(channelId, event);
      if (eventId !== undefined && eventId > 0) {
        this.advanceDeliveryCursor(channelId, eventId);
        this.failedEvents.delete(eventId);
      }
    } catch (err) {
      if (eventId !== undefined && eventId > 0) {
        const count = (this.failedEvents.get(eventId) ?? 0) + 1;
        this.failedEvents.set(eventId, count);
        if (count >= AgentWorkerBase.POISON_MAX_ATTEMPTS) {
          console.error(`[AgentWorkerBase] Poison event id=${eventId} failed ${count} times, will skip on next delivery:`, err);
        } else {
          console.warn(`[AgentWorkerBase] onChannelEvent failed for id=${eventId} (attempt ${count}/${AgentWorkerBase.POISON_MAX_ATTEMPTS}):`, err);
        }
      } else {
        console.error("[AgentWorkerBase] onChannelEvent failed for ephemeral event:", err);
      }
    }
  }

  private getDeliveryCursor(channelId: string): number {
    const cursor = this.sql.exec(
      `SELECT last_delivered_seq FROM delivery_cursor WHERE channel_id = ?`, channelId,
    ).toArray();
    return cursor.length > 0 ? (cursor[0]!["last_delivered_seq"] as number) : 0;
  }

  private advanceDeliveryCursor(channelId: string, seq: number): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO delivery_cursor (channel_id, last_delivered_seq) VALUES (?, ?)`,
      channelId, seq,
    );
  }

  private async repairGap(channelId: string, lastSeq: number, eventId: number): Promise<void> {
    const gap = eventId - lastSeq - 1;
    if (gap > 1000) {
      console.error(`[AgentWorkerBase] Gap too large (${gap} events) in channel=${channelId}, skipping repair`);
      return;
    }
    try {
      const channel = this.createChannelClient(channelId);
      const missed = await channel.getEventRange(lastSeq, eventId - 1);
      if (!missed || !Array.isArray(missed)) return;

      for (const missedEvent of missed) {
        try {
          await this.dispatchChannelEvent(channelId, missedEvent);
          if (missedEvent.id !== undefined && missedEvent.id > 0) {
            this.advanceDeliveryCursor(channelId, missedEvent.id);
          }
        } catch (missedErr) {
          const missedId = missedEvent.id;
          if (missedId !== undefined && missedId > 0) {
            const count = (this.failedEvents.get(missedId) ?? 0) + 1;
            this.failedEvents.set(missedId, count);
            if (count >= AgentWorkerBase.POISON_MAX_ATTEMPTS) {
              console.error(`[AgentWorkerBase] Poison event id=${missedId} in gap repair, skipping:`, missedErr);
              this.advanceDeliveryCursor(channelId, missedId);
            } else {
              console.warn(`[AgentWorkerBase] Gap repair event id=${missedId} failed (attempt ${count}):`, missedErr);
            }
          }
        }
      }
    } catch (err) {
      console.warn(`[AgentWorkerBase] Gap repair failed for channel=${channelId} gap=${lastSeq+1}..${eventId-1}:`, err);
    }
  }

  private async dispatchChannelEvent(channelId: string, event: ChannelEvent): Promise<void> {
    if (event.type === "config-update") {
      let newLevel: number | undefined;
      try {
        const config = typeof event.payload === "object" && event.payload !== null
          ? event.payload as Record<string, unknown>
          : {};
        if ("approvalLevel" in config) {
          newLevel = config["approvalLevel"] as number;
        }
      } catch { /* ignore parse errors */ }
      if (newLevel !== undefined && (newLevel === 0 || newLevel === 1 || newLevel === 2)) {
        this.setApprovalLevel(channelId, newLevel);
      }
      return;
    }

    // Intercept streaming method-result events (complete: false) and forward
    // to the registered stream callback. This bridges ctx.stream() from method
    // providers through to Pi's tool_execution_update event system.
    if (event.type === "method-result") {
      const payload = event.payload as Record<string, unknown> | undefined;
      if (payload && payload["complete"] === false) {
        const callId = payload["callId"] as string | undefined;
        if (callId) {
          const cb = this.streamCallbacks.get(callId);
          if (cb) cb(payload["content"]);
        }
      }
      return;
    }

    await this.onChannelEvent(channelId, event);
  }

  // ── PiRunner lifecycle (one per channel, lazy) ──────────────────────────

  protected async getOrCreateRunner(channelId: string): Promise<PiRunner> {
    const existing = this.runners.get(channelId);
    if (existing) return existing.runner;

    // Restore prior messages from SQL (warm-restart after DO hibernation,
    // or freshly cloned DO whose parent's blob was copied in postClone).
    let initialMessages: AgentMessage[] = [];

    // Try normalized pi_messages table first.
    const msgRows = this.sql.exec(
      `SELECT content FROM pi_messages WHERE channel_id = ? ORDER BY idx`,
      channelId,
    ).toArray();
    if (msgRows.length > 0) {
      try {
        initialMessages = msgRows.map(r => JSON.parse(r["content"] as string) as AgentMessage);
      } catch (err) {
        console.warn(`[AgentWorkerBase] failed to parse pi_messages for channel=${channelId}:`, err);
      }
    } else {
      // Lazy migration: read from legacy pi_sessions blob, migrate to pi_messages.
      const sessionRow = this.sql.exec(
        `SELECT messages_blob FROM pi_sessions WHERE channel_id = ?`, channelId,
      ).toArray();
      if (sessionRow.length > 0 && sessionRow[0]!["messages_blob"]) {
        try {
          initialMessages = JSON.parse(sessionRow[0]!["messages_blob"] as string) as AgentMessage[];
          // Migrate to normalized table.
          for (let i = 0; i < initialMessages.length; i++) {
            this.sql.exec(
              `INSERT INTO pi_messages (channel_id, idx, content) VALUES (?, ?, ?)`,
              channelId, i, JSON.stringify(initialMessages[i]),
            );
          }
          this.sql.exec(`DELETE FROM pi_sessions WHERE channel_id = ?`, channelId);
        } catch (err) {
          console.warn(`[AgentWorkerBase] failed to migrate pi_sessions for channel=${channelId}:`, err);
        }
      }
    }

    const runner = new PiRunner({
      rpc: {
        call: <T = unknown>(target: string, method: string, ...args: unknown[]): Promise<T> =>
          this.rpc.call<T>(target, method, ...args),
      },
      fs: this.fs,
      uiCallbacks: this.buildUICallbacks(channelId),
      rosterCallback: () => this.buildRoster(channelId),
      callMethodCallback: (handle, method, args, signal, onStreamUpdate) =>
        this.invokeChannelMethod(channelId, handle, method, args, signal, onStreamUpdate),
      askUserCallback: (params, signal) => this.askUser(channelId, params, signal),
      model: this.getModel(),
      thinkingLevel: this.getThinkingLevel(),
      approvalLevel: this.getApprovalLevel(channelId),
      initialMessages,
      onPersist: (messages) => this.persistMessages(channelId, messages),
    });

    await runner.init();

    // Warm-restore: no synthetic snapshot needed — the channel already has
    // persisted messages that replay on panel connect.

    const projector = this.getOrCreateProjector(channelId);
    runner.subscribe((event) => projector.handleEvent(event));

    this.runners.set(channelId, { runner });
    // Dispatcher self-subscribes to runner events for absorption tracking
    // and sweep. Created here so it exists before the first onChannelEvent
    // (which expects to hand messages to it).
    this.getOrCreateDispatcher(channelId, runner, projector);
    return runner;
  }

  // ── Per-channel projector (Pi events → channel messages) ───────────────

  /** One projector per channel, created lazily when the runner is wired up. */
  protected projectors = new Map<string, ContentBlockProjector>();

  protected getOrCreateProjector(channelId: string): ContentBlockProjector {
    const existing = this.projectors.get(channelId);
    if (existing) return existing;
    const projector = new ContentBlockProjector(this.createProjectorSink(channelId));
    this.projectors.set(channelId, projector);
    return projector;
  }

  private createProjectorSink(channelId: string): ProjectorSink {
    return {
      send: async (msgId, content, opts) => {
        const participantId = this.subscriptions.getParticipantId(channelId);
        if (!participantId) return;
        const channel = this.createChannelClient(channelId);
        await channel.send(participantId, msgId, content, {
          persist: true,
          contentType: opts?.contentType,
          attachments: opts?.attachments,
        });
      },
      update: async (msgId, content, opts) => {
        const participantId = this.subscriptions.getParticipantId(channelId);
        if (!participantId) return;
        const channel = this.createChannelClient(channelId);
        await channel.update(participantId, msgId, content, undefined, opts);
      },
      complete: async (msgId) => {
        const participantId = this.subscriptions.getParticipantId(channelId);
        if (!participantId) return;
        const channel = this.createChannelClient(channelId);
        await channel.complete(participantId, msgId);
      },
      error: async (msgId, message, code) => {
        const participantId = this.subscriptions.getParticipantId(channelId);
        if (!participantId) return;
        const channel = this.createChannelClient(channelId);
        await channel.error(participantId, msgId, message, code);
      },
    };
  }

  /** Persist the current `AgentMessage[]` snapshot for warm restart. Called
   *  by PiRunner's `onPersist` hook on every `message_end` / `agent_end`.
   *  Append-only: only new messages are INSERTed. The last existing row is
   *  always updated because pi-agent-core mutates the last message in-place
   *  during streaming (partial → final). */
  private persistMessages(channelId: string, messages: AgentMessage[]): void {
    const rows = this.sql.exec(
      `SELECT COUNT(*) as cnt FROM pi_messages WHERE channel_id = ?`, channelId,
    ).toArray();
    const existingCount = (rows[0]?.["cnt"] as number) ?? 0;

    if (messages.length < existingCount) {
      // Context window management trimmed messages — remove excess rows.
      this.sql.exec(
        `DELETE FROM pi_messages WHERE channel_id = ? AND idx >= ?`,
        channelId, messages.length,
      );
    }

    // Update the last existing row (pi-agent-core mutates last message in-place).
    if (existingCount > 0 && messages.length >= existingCount) {
      this.sql.exec(
        `UPDATE pi_messages SET content = ? WHERE channel_id = ? AND idx = ?`,
        JSON.stringify(messages[existingCount - 1]), channelId, existingCount - 1,
      );
    }

    // Append new messages.
    for (let i = existingCount; i < messages.length; i++) {
      this.sql.exec(
        `INSERT INTO pi_messages (channel_id, idx, content) VALUES (?, ?, ?)`,
        channelId, i, JSON.stringify(messages[i]),
      );
    }
  }

  // ── Dispatch + typing (delegated to TurnDispatcher) ─────────────────────
  //
  // One TurnDispatcher per channel. Every incoming user message flows
  // through `dispatcher.submit`; the dispatcher owns the queue, steer
  // tracking, self-healing sweep, and typing-indicator broadcasts.
  // See `turn-dispatcher.ts` for the full state-machine doc.

  protected dispatchers = new Map<string, TurnDispatcher>();

  protected getOrCreateDispatcher(
    channelId: string,
    runner: PiRunner,
    projector: ContentBlockProjector,
  ): TurnDispatcher {
    const existing = this.dispatchers.get(channelId);
    if (existing) return existing;
    const dispatcher = new TurnDispatcher({
      runner,
      projector,
      notifyTyping: (busy) => this.broadcastTyping(channelId, busy),
    });
    this.dispatchers.set(channelId, dispatcher);
    return dispatcher;
  }

  /** Ephemeral setTypingState broadcast. Fire-and-forget; errors logged. */
  private broadcastTyping(channelId: string, busy: boolean): void {
    const participantId = this.subscriptions.getParticipantId(channelId);
    if (!participantId) return;
    const channel = this.createChannelClient(channelId);
    void channel.setTypingState(participantId, busy).catch((err) => {
      console.warn(`[AgentWorkerBase] setTypingState(${busy}) failed for channel=${channelId}:`, err);
    });
  }


  // ── Channel-tools extension wiring ──────────────────────────────────────

  /** Sync getter for the channel-tools extension. The extension expects a
   *  sync callback; we serve from the most-recently-cached roster. Refresh
   *  happens before each turn via `refreshRoster`. */
  private buildRoster(channelId: string): ChannelToolMethod[] {
    return this.cachedRoster.get(channelId) ?? [];
  }

  private cachedRoster = new Map<string, ChannelToolMethod[]>();

  /** Refresh the cached roster for a channel. Called before each turn. */
  protected async refreshRoster(channelId: string): Promise<void> {
    const channel = this.createChannelClient(channelId);
    const participants = await channel.getParticipants();
    const selfId = this.subscriptions.getParticipantId(channelId);
    const roster: ChannelToolMethod[] = [];
    for (const p of participants) {
      if (p.participantId === selfId) continue;
      const handle = p.metadata["handle"] as string | undefined;
      if (!handle) continue;
      const advertised = p.metadata["methods"];
      if (!Array.isArray(advertised)) continue;
      for (const m of advertised) {
        const method = m as Record<string, unknown>;
        const name = method["name"] as string | undefined;
        if (!name) continue;
        roster.push({
          participantHandle: handle,
          name,
          description: (method["description"] as string) ?? "",
          parameters: method["parameters"] ?? { type: "object" },
        });
      }
    }
    this.cachedRoster.set(channelId, roster);
  }

  private async invokeChannelMethod(
    channelId: string,
    participantHandle: string,
    method: string,
    args: unknown,
    signal: AbortSignal | undefined,
    onStreamUpdate?: (content: unknown) => void,
  ): Promise<unknown> {
    const channel = this.createChannelClient(channelId);
    const participants = await channel.getParticipants();
    const target = participants.find((p) => p.metadata["handle"] === participantHandle);
    if (!target) {
      throw new Error(`No participant with handle "${participantHandle}" in channel ${channelId}`);
    }
    const callerId = this.subscriptions.getParticipantId(channelId);
    if (!callerId) throw new Error(`Not subscribed to channel ${channelId}`);

    const callId = crypto.randomUUID();
    if (onStreamUpdate) this.streamCallbacks.set(callId, onStreamUpdate);
    const promise = this.awaitContinuation(callId, signal);
    this.continuations.store(callId, channelId, "tool-call", { handle: participantHandle, method });
    await channel.callMethod(callerId, target.participantId, callId, method, args);
    return promise;
  }

  private async askUser(
    channelId: string,
    params: AskUserParams,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const callerId = this.subscriptions.getParticipantId(channelId);
    if (!callerId) throw new Error(`Not subscribed to channel ${channelId}`);
    const channel = this.createChannelClient(channelId);
    // Find a panel-type participant to ask.
    const participants = await channel.getParticipants();
    const panel = participants.find((p) => {
      const t = p.metadata["type"] as string | undefined;
      return t === "panel" || t === "client";
    });
    if (!panel) {
      throw new Error(`No panel participant in channel ${channelId} to ask`);
    }

    const callId = crypto.randomUUID();
    const promise = this.awaitContinuation(callId, signal);
    this.continuations.store(callId, channelId, "ask-user", {});
    await channel.callMethod(callerId, panel.participantId, callId, "feedback_form", params);
    const result = await promise;
    return typeof result === "string" ? result : JSON.stringify(result);
  }

  private buildUICallbacks(channelId: string): NatStackUIBridgeCallbacks {
    const askPanel = async (
      kind: "select" | "confirm" | "input" | "editor",
      params: Record<string, unknown>,
      signal?: AbortSignal,
    ): Promise<unknown> => {
      const callerId = this.subscriptions.getParticipantId(channelId);
      if (!callerId) throw new Error(`Not subscribed to channel ${channelId}`);
      const channel = this.createChannelClient(channelId);
      const participants = await channel.getParticipants();
      const panel = participants.find((p) => {
        const t = p.metadata["type"] as string | undefined;
        return t === "panel" || t === "client";
      });
      if (!panel) throw new Error(`No panel participant in channel ${channelId}`);

      const callId = crypto.randomUUID();
      const promise = this.awaitContinuation(callId, signal);
      this.continuations.store(callId, channelId, "ui-prompt", { kind });
      await channel.callMethod(callerId, panel.participantId, callId, "ui_prompt", { kind, ...params });
      return promise;
    };

    return {
      showSelect: async (title, options, opts) => {
        const result = await askPanel("select", { title, options }, opts?.signal);
        return typeof result === "string" ? result : undefined;
      },
      showConfirm: async (title, message, opts) => {
        const result = await askPanel("confirm", { title, message }, opts?.signal);
        return result === true || result === "true" || result === "yes";
      },
      showInput: async (title, placeholder, opts) => {
        const result = await askPanel("input", { title, placeholder }, opts?.signal);
        return typeof result === "string" ? result : undefined;
      },
      showEditor: async (title, prefill) => {
        const result = await askPanel("editor", { title, prefill });
        return typeof result === "string" ? result : undefined;
      },
      notify: (message, type) => {
        const participantId = this.subscriptions.getParticipantId(channelId);
        if (!participantId) return;
        const channel = this.createChannelClient(channelId);
        void channel.sendEphemeral(participantId, message, `notify:${type ?? "info"}`);
      },
      setStatus: (key, text) => {
        const participantId = this.subscriptions.getParticipantId(channelId);
        if (!participantId) return;
        const channel = this.createChannelClient(channelId);
        void channel.sendEphemeralEvent(participantId, "natstack-ext-status", { key, text });
      },
      setWidget: (key, content, options) => {
        const participantId = this.subscriptions.getParticipantId(channelId);
        if (!participantId) return;
        const channel = this.createChannelClient(channelId);
        void channel.sendEphemeralEvent(participantId, "natstack-ext-widget", { key, content, options });
      },
      setWorkingMessage: (message) => {
        const participantId = this.subscriptions.getParticipantId(channelId);
        if (!participantId) return;
        const channel = this.createChannelClient(channelId);
        void channel.sendEphemeralEvent(participantId, "natstack-ext-working", { message: message ?? null });
      },
      requestProviderOAuth: (providerId, displayName) => {
        const participantId = this.subscriptions.getParticipantId(channelId);
        if (!participantId) return;
        const key = `${channelId}::${providerId}`;
        if (this.oauthCardsEmitted.has(key)) return;
        this.oauthCardsEmitted.add(key);

        const channel = this.createChannelClient(channelId);
        const messageId = crypto.randomUUID();
        const content = JSON.stringify({
          id: `oauth-connect-${providerId}-${messageId}`,
          code: OAUTH_CONNECT_CARD_TSX,
          props: { providerId, displayName },
        });
        // Push as ephemeral: the card carries TSX source which would
        // otherwise freeze into chat history. If the underlying flow code
        // ships a fix in a later release, persisted cards would keep
        // re-running the broken old TSX on every reload. Ephemeral cards
        // disappear on panel reload; we proactively re-emit on the next
        // subscribe (see clearAndCheckOAuthOnSubscribe).
        void channel
          .send(participantId, messageId, content, {
            contentType: "inline_ui",
            persist: false,
          })
          .catch((err) => {
            console.error(`[AgentWorkerBase] Failed to emit OAuth Connect card for ${providerId}:`, err);
            this.oauthCardsEmitted.delete(key);
          });
      },
    };
  }

  // ── Continuation Promise plumbing ───────────────────────────────────────
  //
  // No timer-based cleanup of pending continuations. A continuation becomes
  // orphaned only when the DO hibernates or restarts mid-`await` — the
  // in-memory resolver is lost, but the SQL row persists. Orphans are
  // detected off real events:
  //
  //   • `onCallResult`: result arrives but no resolver → orphan. Handled
  //     inline (consume row, notify channel).
  //   • `onChannelEvent`: a new message arrives for a channel that has
  //     `pending_calls` rows without resolvers → orphan. Handled inline by
  //     `sweepOrphanedContinuationsFor(channelId)` before dispatching the
  //     new turn.
  //   • Channel unsubscribe: `deleteForChannel` in the subscription teardown.
  //
  // User think time is not a failure. An arbitrary timer was — it would fire
  // while the user was still looking at feedback_custom UIs, cleaning up SQL
  // rows that the soon-to-arrive response would then fail to find.

  private awaitContinuation(callId: string, signal?: AbortSignal): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      this.pendingResolvers.set(callId, { resolve, reject });

      if (signal) {
        const onAbort = () => {
          this.pendingResolvers.delete(callId);
          this.continuations.deleteOne(callId);
          reject(new Error("aborted"));
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  async onCallResult(callId: string, result: unknown, isError: boolean): Promise<void> {
    this.streamCallbacks.delete(callId);
    const pending = this.continuations.consume(callId);
    if (!pending) {
      console.warn(`[AgentWorkerBase] onCallResult: no pending call for callId=${callId} (isError=${isError})`);
      return;
    }
    const resolver = this.pendingResolvers.get(callId);
    if (resolver) {
      this.pendingResolvers.delete(callId);
      if (isError) {
        const err = new Error(typeof result === "string" ? result : JSON.stringify(result));
        resolver.reject(err);
      } else {
        resolver.resolve(result);
      }
    } else {
      // Resolver lost — DO restarted while waiting for this result.
      // The agent turn that was awaiting this is gone. Notify the channel.
      console.warn(
        `[AgentWorkerBase] onCallResult: orphaned continuation callId=${callId} channel=${pending.channelId} — DO restarted while waiting`,
      );
      this.notifyOrphanedContinuation(pending.channelId);
    }
  }

  // ── Orphaned continuation recovery ─────────────────────────────────────
  //
  // Called opportunistically from `onChannelEvent` before dispatching a new
  // turn. If there are `pending_calls` rows for this channel that lack an
  // in-memory resolver, the awaiter of those rows is gone (DO hibernated or
  // restarted). Clean them up and notify once per channel.

  private sweepOrphanedContinuationsFor(channelId: string): void {
    const pending = this.continuations.listForChannel(channelId);
    if (pending.length === 0) return;

    let notified = false;
    for (const { callId } of pending) {
      if (this.pendingResolvers.has(callId)) continue;
      console.warn(
        `[AgentWorkerBase] sweep: cleaning orphaned continuation callId=${callId} channel=${channelId}`,
      );
      this.continuations.deleteOne(callId);
      if (!notified) {
        notified = true;
        this.notifyOrphanedContinuation(channelId);
      }
    }
  }

  /** Send a system message to the channel that the agent was interrupted. */
  private notifyOrphanedContinuation(channelId: string): void {
    const participantId = this.subscriptions.getParticipantId(channelId);
    if (!participantId) return;
    const channel = this.createChannelClient(channelId);
    const msgId = `interrupted-${crypto.randomUUID()}`;
    void channel.send(
      participantId,
      msgId,
      "The agent was interrupted while waiting for a response. Please resend your message to continue.",
      { persist: true },
    ).then(() => channel.complete(participantId, msgId));
  }

  // ── Default channel event handler ────────────────────────────────────────
  //
  // Subclasses MAY override this for custom routing, but the default behavior
  // covers the common case: incoming user messages are forwarded to Pi via the
  // per-channel runner. Pi handles the rest.

  async onChannelEvent(
    channelId: string,
    event: ChannelEvent,
    opts?: { mode?: "auto" | "sequential" },
  ): Promise<void> {
    if (!this.shouldProcess(event)) return;

    // Before dispatching, clean up any continuations whose awaiter is gone.
    // A new channel event proves the user is active; any SQL `pending_calls`
    // row without an in-memory resolver was awaited by a turn that died
    // (hibernation / restart).
    this.sweepOrphanedContinuationsFor(channelId);

    const input = this.buildTurnInput(event);

    // Pre-submit setup: roster refresh, runner init, image resize. All
    // have to happen before we hand the message to the dispatcher so it
    // can make the steer-vs-runTurn decision and pass a prebuilt
    // AgentMessage through absorption tracking.
    await this.refreshRoster(channelId);
    const runner = await this.getOrCreateRunner(channelId);
    const projector = this.getOrCreateProjector(channelId);
    const images = await this.resizeAttachments(channelId, input.attachments);

    const agentMsg = runner.buildUserMessage(input.content, images);
    const dispatcher = this.getOrCreateDispatcher(channelId, runner, projector);
    dispatcher.submit(agentMsg, opts);
  }

  /** Resize user-pasted image attachments via the server-side image service.
   *  Best-effort: on failure, fall through to the original bytes. */
  private async resizeAttachments(
    channelId: string,
    attachments: Attachment[] | undefined,
  ): Promise<ImageContent[] | undefined> {
    if (!attachments || attachments.length === 0) return undefined;
    const images: ImageContent[] = [];
    for (const att of attachments) {
      if (!att.mimeType?.startsWith("image/")) continue;
      try {
        const bytes = Buffer.from(att.data, "base64");
        const resized = await this.rpc.call<{
          data: Uint8Array;
          mimeType: string;
          wasResized: boolean;
        }>(
          "main",
          "image.resize",
          bytes,
          att.mimeType,
          { maxWidth: 2000, maxHeight: 2000 },
        );
        images.push({
          type: "image",
          mimeType: resized.mimeType,
          data: Buffer.from(resized.data).toString("base64"),
        });
      } catch (err) {
        console.warn(
          `[AgentWorkerBase] image.resize failed for channel=${channelId}; passing original:`,
          err,
        );
        images.push({ type: "image", mimeType: att.mimeType, data: att.data });
      }
    }
    return images.length > 0 ? images : undefined;
  }

  // ── Method calls (subclass hook) ─────────────────────────────────────────

  async onMethodCall(_channelId: string, _callId: string, _methodName: string, _args: unknown): Promise<{ result: unknown; isError?: boolean }> {
    return { result: { error: "not implemented" }, isError: true };
  }

  /** Interrupt the in-flight Pi turn for every active channel runner. */
  protected async interruptAllRunners(): Promise<void> {
    for (const [channelId, entry] of this.runners.entries()) {
      const projector = this.projectors.get(channelId);
      if (projector) await projector.closeAll();
      this.dispatchers.get(channelId)?.reset();
      await entry.runner.interrupt();
    }
  }

  /** Interrupt the in-flight Pi turn for a specific channel. */
  protected async interruptRunner(channelId: string): Promise<void> {
    const entry = this.runners.get(channelId);
    if (entry) {
      // Close every in-flight channel message (text/thinking/toolCall) before
      // tearing down the runner, so the client sees clean completion events
      // even though the *_end Pi events won't fire post-abort.
      const projector = this.projectors.get(channelId);
      if (projector) await projector.closeAll();
      // Drop any pending/steered messages — interrupt means the user wants
      // everything stopped, not just the current turn. Dispatcher's reset()
      // also clears pi-core's steering queue.
      this.dispatchers.get(channelId)?.reset();
      await entry.runner.interrupt();
    }
  }

  // ── Fork support (Pi-native) ────────────────────────────────────────────

  async canFork(): Promise<{ ok: boolean; subscriptionCount: number; reason?: string }> {
    const count = this.sql.exec(`SELECT COUNT(*) as cnt FROM subscriptions`).toArray();
    const n = (count[0]?.["cnt"] as number) ?? 0;
    if (n > 1) {
      return { ok: false, subscriptionCount: n, reason: "multi-channel" };
    }
    return { ok: true, subscriptionCount: n };
  }

  /**
   * Called on the newly cloned agent DO after cloneDO copies parent's SQLite.
   * Rewrites identity, clears ephemeral state, resubscribes to forked channel.
   * The cloned worker boots its own PiRunner from the persisted pi_messages
   * on first user message (optionally truncated to `forkAtMessageIndex`).
   */
  async postClone(
    parentObjectKey: string,
    newChannelId: string,
    oldChannelId: string,
    forkAtMessageIndex: number | null,
  ): Promise<void> {
    this.sql.exec(
      `INSERT OR REPLACE INTO state (key, value) VALUES ('__objectKey', ?)`,
      this.objectKey,
    );

    this.setStateValue("forkedFrom", parentObjectKey);
    if (forkAtMessageIndex != null) {
      this.setStateValue("forkAtMessageIndex", String(forkAtMessageIndex));
    }
    this.setStateValue("forkSourceChannel", oldChannelId);

    // Clear ephemeral state copied from parent.
    this.sql.exec(`DELETE FROM delivery_cursor`);
    this.sql.exec(`DELETE FROM pending_calls`);

    // Migrate parent's message history from oldChannelId → newChannelId.
    // Check pi_messages first (normalized), fall back to legacy pi_sessions blob.
    const hasPiMessages = (this.sql.exec(
      `SELECT COUNT(*) as cnt FROM pi_messages WHERE channel_id = ?`, oldChannelId,
    ).toArray()[0]?.["cnt"] as number ?? 0) > 0;

    if (hasPiMessages) {
      // Normalized path: rename channel via UPDATE, trim via DELETE.
      this.sql.exec(
        `UPDATE pi_messages SET channel_id = ? WHERE channel_id = ?`,
        newChannelId, oldChannelId,
      );
      if (forkAtMessageIndex != null) {
        this.sql.exec(
          `DELETE FROM pi_messages WHERE channel_id = ? AND idx >= ?`,
          newChannelId, forkAtMessageIndex,
        );
      }
    } else {
      // Legacy blob path: migrate to pi_messages during fork.
      const parentSession = this.sql.exec(
        `SELECT messages_blob FROM pi_sessions WHERE channel_id = ?`, oldChannelId,
      ).toArray();
      if (parentSession.length > 0) {
        try {
          let messages = JSON.parse(parentSession[0]!["messages_blob"] as string) as AgentMessage[];
          if (forkAtMessageIndex != null) messages = messages.slice(0, forkAtMessageIndex);
          for (let i = 0; i < messages.length; i++) {
            this.sql.exec(
              `INSERT INTO pi_messages (channel_id, idx, content) VALUES (?, ?, ?)`,
              newChannelId, i, JSON.stringify(messages[i]),
            );
          }
        } catch (err) {
          console.warn(`[AgentWorkerBase] failed to migrate pi_sessions during fork:`, err);
        }
        this.sql.exec(`DELETE FROM pi_sessions WHERE channel_id = ?`, oldChannelId);
      }
    }

    // Rename approvalLevel state key.
    const oldApprovalKey = `approvalLevel:${oldChannelId}`;
    const newApprovalKey = `approvalLevel:${newChannelId}`;
    const approvalValue = this.getStateValue(oldApprovalKey);
    if (approvalValue) {
      this.setStateValue(newApprovalKey, approvalValue);
      this.deleteStateValue(oldApprovalKey);
    }

    // Resubscribe to the forked channel.
    const subRow = this.sql.exec(
      `SELECT context_id, config FROM subscriptions WHERE channel_id = ?`, oldChannelId,
    ).toArray();
    const contextId = subRow.length > 0 ? (subRow[0]!["context_id"] as string) : undefined;
    const configRaw = subRow.length > 0 ? (subRow[0]!["config"] as string | null) : null;
    const config = configRaw ? JSON.parse(configRaw) : undefined;

    this.sql.exec(`DELETE FROM subscriptions`);
    // Dispose dispatchers first (releases their runner subscriptions)
    // before wiping the runner map. On a freshly-cloned DO these maps
    // are already empty, but this keeps the teardown order correct if
    // postClone is ever re-entered.
    for (const dispatcher of this.dispatchers.values()) dispatcher.dispose();
    this.dispatchers.clear();
    this.runners.clear();
    this.projectors.clear();
    this._fsContextBound.clear(); // Re-bind fs context on first resubscribe.

    if (contextId) {
      await this.subscribeChannel({ channelId: newChannelId, contextId, config });
    }

    await this.onPostClone(parentObjectKey, newChannelId, oldChannelId, forkAtMessageIndex);
  }

  protected async onPostClone(
    _parentObjectKey: string,
    _newChannelId: string,
    _oldChannelId: string,
    _forkAtMessageIndex: number | null,
  ): Promise<void> {
    // Default: no-op
  }

  // ── Fetch override ───────────────────────────────────────────────────────

  override async fetch(request: Request): Promise<Response> {
    this.ensureReady();

    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length >= 1 && !(this as unknown as { _objectKey?: string })._objectKey) {
      (this as unknown as { _objectKey?: string })._objectKey = decodeURIComponent(segments[0]!);
    }

    this.ensureBootstrapped();

    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return this.handleWebSocketUpgrade(request);
    }

    const method = segments.slice(1).join("/") || "getState";

    if (method === "__rpc") {
      const body = await request.json();
      const result = await this.rpc.handleIncomingPost(body);
      return new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (method === "__event") {
      let args: unknown[] = [];
      if (request.method === "POST") {
        const body = await request.text();
        if (body) {
          const result = this.parseRequestBody(body);
          if (result.error) {
            return new Response(JSON.stringify({ error: result.error }), {
              status: 400, headers: { "Content-Type": "application/json" },
            });
          }
          args = result.args;
        }
      }
      if (args.length < 2) {
        return new Response(JSON.stringify({ error: "__event requires at least [event, payload]" }), {
          status: 400, headers: { "Content-Type": "application/json" },
        });
      }
      const [event, payload, fromId] = args as [string, unknown, string | undefined];
      await this.rpc.handleIncomingPost({ type: "emit", event, payload, fromId: fromId ?? "" });
      return new Response(JSON.stringify({ result: "ok" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    try {
      let args: unknown[] = [];
      if (request.method === "POST") {
        const body = await request.text();
        if (body) {
          const result = this.parseRequestBody(body);
          if (result.error) {
            return new Response(JSON.stringify({ error: result.error }), {
              status: 400, headers: { "Content-Type": "application/json" },
            });
          }
          args = result.args;
        }
      }

      if (method === "onChannelEvent" && args.length === 2) {
        await this.handleIncomingChannelEvent(args[0] as string, args[1] as ChannelEvent);
        return new Response(JSON.stringify(null), {
          headers: { "Content-Type": "application/json" },
        });
      }

      const fn = (this as unknown as Record<string, unknown>)[method];
      if (typeof fn !== "function") {
        return new Response(JSON.stringify({ error: `Unknown method: ${method}` }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }

      const result = await (fn as (...a: unknown[]) => Promise<unknown>).call(this, ...args);
      return new Response(JSON.stringify(result ?? null), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return new Response(JSON.stringify({ error: message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  override async getState(): Promise<Record<string, unknown>> {
    const subscriptions = this.sql.exec(`SELECT * FROM subscriptions`).toArray();
    const piMessages = this.sql.exec(
      `SELECT channel_id, idx, LENGTH(content) as content_len FROM pi_messages`,
    ).toArray();
    const piSessionsLegacy = this.sql.exec(`SELECT channel_id, updated_at FROM pi_sessions`).toArray();
    const pendingCalls = this.sql.exec(`SELECT * FROM pending_calls`).toArray();
    const deliveryCursors = this.sql.exec(`SELECT * FROM delivery_cursor`).toArray();
    return { subscriptions, piMessages, piSessionsLegacy, pendingCalls, deliveryCursors };
  }

  // Reference SAFE_TOOL_NAMES_DEFAULT to suppress unused-import warnings;
  // it's exported from the harness package via DEFAULT_SAFE_TOOL_NAMES, but
  // we keep a local reference here for documentation/symmetry.
  protected static readonly _SAFE_TOOL_NAMES_REFERENCE = SAFE_TOOL_NAMES_DEFAULT;
}
