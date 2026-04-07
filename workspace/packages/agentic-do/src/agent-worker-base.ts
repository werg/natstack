/**
 * AgentWorkerBase — Thin composition shell for agentic Durable Objects.
 *
 * Extends DurableObjectBase and composes agent-specific modules:
 * DOIdentity, SubscriptionManager, HarnessManager, TurnManager,
 * ContinuationStore, and StreamWriter.
 *
 * Non-agent DOs extend DurableObjectBase directly.
 */

import { DurableObjectBase, type DurableObjectContext, type DORef } from "@workspace/runtime/worker";
import type { ChannelEvent, HarnessConfig, HarnessOutput, TurnInput, ParticipantDescriptor, UnsubscribeResult, Attachment } from "@natstack/harness/types";
import { needsApprovalForTool, isClientParticipantType } from "@natstack/pubsub";

import { DOIdentity } from "./identity.js";
import { SubscriptionManager } from "./subscription-manager.js";
import { HarnessManager } from "./harness-manager.js";
import { TurnManager, type ActiveTurn, type InFlightTurn, type QueuedTurn } from "./turn-manager.js";
import { ContinuationStore } from "./continuation-store.js";
import { StreamWriter, type PersistedStreamState } from "./stream-writer.js";
import { ChannelClient } from "./channel-client.js";

export abstract class AgentWorkerBase extends DurableObjectBase {
  protected identity: DOIdentity;
  protected subscriptions: SubscriptionManager;
  protected harnesses: HarnessManager;
  protected turns: TurnManager;
  protected continuations: ContinuationStore;

  /** Phase 0D: Transient poison message tracker (event id → attempt count). Resets on hibernation. */
  private failedEvents = new Map<number, number>();
  private static readonly POISON_MAX_ATTEMPTS = 3;

  constructor(ctx: DurableObjectContext, env: unknown) {
    super(ctx, env);

    // Create a lazy RPC proxy that defers to this.rpc (which requires an instance
    // token set by postToDOWithToken before the first fetch). This lets us
    // construct modules eagerly for createTables() while deferring actual RPC
    // calls to when the token is available.
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
    this.harnesses = new HarnessManager(this.sql, lazyRpc);
    this.turns = new TurnManager(this.sql);
    this.continuations = new ContinuationStore(this.sql);

    // Eager schema init — safe because all modules exist.
    this.ensureReady();

    // Restore identity from SQLite if previously bootstrapped
    this.identity.restore();
  }

  static override schemaVersion = 5;

  protected createTables(): void {
    this.identity.createTables();
    this.subscriptions.createTables();
    this.harnesses.createTables();
    this.turns.createTables();
    this.continuations.createTables();
    // Phase 0A: Delivery cursor for event dedup
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS delivery_cursor (
        channel_id TEXT PRIMARY KEY,
        last_delivered_seq INTEGER NOT NULL
      )
    `);
  }

  // --- Identity bootstrap ---
  // Self-bootstraps from env bindings (WORKER_SOURCE, WORKER_CLASS_NAME, WORKERD_SESSION_ID)
  // and objectKey (parsed from request URL by DurableObjectBase.fetch()).

  private _bootstrapped = false;

  /** Ensure identity is bootstrapped. Called automatically on first fetch(). */
  private ensureBootstrapped(): void {
    if (this._bootstrapped) return;
    // objectKey may not be available yet (before first fetch)
    try {
      const key = this.objectKey;
      const source = (this.env as Record<string, string>)["WORKER_SOURCE"];
      const className = (this.env as Record<string, string>)["WORKER_CLASS_NAME"];
      const sessionId = (this.env as Record<string, string>)["WORKERD_SESSION_ID"];
      if (source && className && sessionId) {
        const doRef: DORef = { source, className, objectKey: key };
        const { isRestart } = this.identity.bootstrap(doRef, sessionId);
        if (isRestart) {
          this.harnesses.markCrashedOnRestart();
          this.turns.clearAllActive();
          this.turns.clearAllInFlight();
          this.continuations.deleteAll();
        }
        this._bootstrapped = true;
      }
    } catch (err) {
      // objectKey not yet available (before first fetch) — will bootstrap on next call.
      // Log unexpected errors so they don't get silently swallowed.
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("objectKey not available")) {
        console.error("[AgentWorkerBase] ensureBootstrapped failed:", err);
      }
    }
  }

  // --- Convenience accessors (delegate to identity) ---

  protected get doRef(): DORef {
    return this.identity.ref;
  }

  // --- ChannelClient factory ---

  protected createChannelClient(channelId: string): ChannelClient {
    return new ChannelClient(this.rpc, channelId);
  }

  // --- 5 Customization Hooks ---

  protected getHarnessType(): string { return 'claude-sdk'; }
  protected getHarnessConfig(): HarnessConfig { return {}; }

  protected shouldProcess(event: ChannelEvent): boolean {
    if (event.type !== 'message') return false;
    if (event.contentType) return false;
    // Positive whitelist: only process messages from known client participant
    // types (panels, headless clients). This prevents agent-to-agent loops AND
    // prevents unlabeled participants from accidentally driving the worker.
    // To accept a new client kind, add it to isClientParticipantType.
    const senderType = event.senderMetadata?.["type"] as string | undefined;
    if (!isClientParticipantType(senderType)) return false;
    return true;
  }

  protected buildTurnInput(event: ChannelEvent): TurnInput {
    const payload = event.payload as { content?: string; attachments?: Attachment[] };
    return { content: payload.content ?? '', senderId: event.senderId, attachments: event.attachments };
  }

  protected getParticipantInfo(_channelId: string, config?: unknown): ParticipantDescriptor {
    const cfg = config as Record<string, unknown> | undefined;
    return {
      handle: (cfg?.["handle"] as string) ?? 'agent',
      name: 'AI Agent',
      type: 'agent',
      metadata: {},
      methods: [],
    };
  }

  // --- StreamWriter factory ---

  protected createWriter(
    channelId: string,
    turn: { replyToId: string; typingContent: string; streamState: PersistedStreamState },
  ): StreamWriter {
    const participantId = this.subscriptions.getParticipantId(channelId);
    if (!participantId) throw new Error(`No participant ID for channel ${channelId}`);
    const channel = this.createChannelClient(channelId);
    return new StreamWriter(channel, participantId, channelId, turn.replyToId, turn.typingContent, turn.streamState);
  }

  // --- Subscription lifecycle ---

  async subscribeChannel(opts: { channelId: string; contextId: string; config?: unknown; replay?: boolean }): Promise<{ ok: boolean; participantId: string }> {
    const descriptor = this.getParticipantInfo(opts.channelId, opts.config);
    const result = await this.subscriptions.subscribe({
      channelId: opts.channelId,
      contextId: opts.contextId,
      config: opts.config,
      descriptor,
      replay: opts.replay,
    });

    if (result.channelConfig?.["approvalLevel"] != null) {
      this.setApprovalLevel(opts.channelId, result.channelConfig["approvalLevel"] as number);
    }

    // Process replay events (messages sent before this DO subscribed).
    // Best-effort: subscription success must not depend on replay processing.
    // DOs are single-threaded, so live events are queued during this processing.
    // Stop on first error — continuing after failure could skip events that
    // depend on earlier state (e.g. harness spawn must precede turn commands).
    if (result.replay) {
      try {
        for (const event of result.replay) {
          await this.onChannelEvent(opts.channelId, event);
        }
      } catch (err) {
        console.warn(`[AgentWorkerBase] Replay processing stopped:`, err);
      }
    }

    return { ok: result.ok, participantId: result.participantId };
  }

  async unsubscribeChannel(channelId: string): Promise<UnsubscribeResult> {
    const harnessIds = this.harnesses.listAll();

    // Unsubscribe from channel DO
    await this.subscriptions.unsubscribeFromChannel(channelId);

    // Stop harnesses via server API
    for (const hid of harnessIds) {
      await this.harnesses.stop(hid);
      this.turns.deleteForHarness(hid);
    }

    // Clean up all tables for this channel
    this.harnesses.deleteAll();
    this.turns.deleteCheckpointsForChannel(channelId);
    this.continuations.deleteForChannel(channelId);
    this.subscriptions.deleteSubscription(channelId);

    return { harnessIds };
  }

  // --- Delegated helpers (subclass API) ---

  protected getActiveHarness(): string | null {
    return this.harnesses.getActive();
  }

  protected getContextId(channelId: string): string {
    return this.subscriptions.getContextId(channelId);
  }

  protected getSubscriptionConfig(channelId: string): Record<string, unknown> | null {
    return this.subscriptions.getConfig(channelId);
  }

  protected getParticipantId(channelId: string): string | null {
    return this.subscriptions.getParticipantId(channelId);
  }

  // --- Turn management delegates ---

  protected setActiveTurn(harnessId: string, channelId: string, replyToId: string, turnMessageId?: string, senderParticipantId?: string, typingContent?: string): void {
    this.turns.setActive(harnessId, channelId, replyToId, turnMessageId, senderParticipantId, typingContent);
  }

  protected getActiveTurn(harnessId: string): ActiveTurn | null {
    return this.turns.getActive(harnessId);
  }

  protected updateActiveTurnMessageId(harnessId: string, turnMessageId: string): void {
    this.turns.updateActiveMessageId(harnessId, turnMessageId);
  }

  protected clearActiveTurn(harnessId: string): void {
    this.turns.clearActive(harnessId);
  }

  protected setInFlightTurn(channelId: string, harnessId: string, messageId: string, pubsubId: number, input: TurnInput): void {
    this.turns.setInFlight(channelId, harnessId, messageId, pubsubId, input);
  }

  protected getInFlightTurn(channelId: string, harnessId: string): InFlightTurn | null {
    return this.turns.getInFlight(channelId, harnessId);
  }

  protected clearInFlightTurn(channelId: string, harnessId: string): void {
    this.turns.clearInFlight(channelId, harnessId);
  }

  protected enqueueTurn(channelId: string, harnessId: string, messageId: string, pubsubId: number, senderId: string, input: TurnInput, typingContent?: string): void {
    this.turns.enqueue(channelId, harnessId, messageId, pubsubId, senderId, input, typingContent);
  }

  protected dequeueNextTurn(harnessId: string): QueuedTurn | null {
    return this.turns.dequeue(harnessId);
  }

  protected clearTurnQueue(harnessId: string): void {
    this.turns.clearQueueForHarness(harnessId);
  }

  protected advanceCheckpoint(channelId: string, harnessId: string | null, pubsubId: number): void {
    this.turns.advanceCheckpoint(channelId, harnessId, pubsubId);
  }

  protected getCheckpoint(channelId: string, harnessId: string | null): number | null {
    return this.turns.getCheckpoint(channelId, harnessId);
  }

  protected recordTurn(harnessId: string, messageId: string, triggerPubsubId: number, sessionId: string): void {
    this.turns.recordTurn(harnessId, messageId, triggerPubsubId, sessionId);
    this.harnesses.setSessionId(harnessId, sessionId);
    // Consume forkSessionId after first successful turn — the new session
    // is now recorded in turn_map and getResumeSessionIdForChannel() will
    // fall back to it naturally on subsequent spawns.
    if (this.getStateValue("forkSessionId")) {
      this.deleteStateValue("forkSessionId");
    }
  }

  protected getTurnAtOrBefore(harnessId: string, pubsubId: number) {
    return this.turns.getTurnAtOrBefore(harnessId, pubsubId);
  }

  protected getLatestTurn(harnessId: string) {
    return this.turns.getLatestTurn(harnessId);
  }

  protected getResumeSessionId(harnessId: string): string | undefined {
    return this.turns.getResumeSessionId(harnessId);
  }

  protected getResumeSessionIdForChannel(_channelId: string): string | undefined {
    // Prefer fork-specific session (set by postClone). NOT consumed here —
    // consumed in recordTurn() after the first turn succeeds, so retries
    // on transient spawn failures still get the fork-point session.
    const forkSession = this.getStateValue("forkSessionId");
    if (forkSession) {
      return forkSession;
    }
    const harnessIds = this.harnesses.listAll();
    return this.turns.getResumeSessionIdForHarnesses(harnessIds);
  }

  protected persistStreamState(harnessId: string, writer: StreamWriter): void {
    this.turns.persistStreamState(harnessId, writer.getState());
  }

  protected adoptBootstrapTyping(harnessId: string, channelId: string): void {
    const bootstrapKey = `bootstrap_typing:${channelId}`;
    const bootstrapRow = this.getStateValue(bootstrapKey);
    if (!bootstrapRow) return;

    this.deleteStateValue(bootstrapKey);
    const turn = this.getActiveTurn(harnessId);
    if (!turn) return;

    const state = { ...turn.streamState, typingMessageId: bootstrapRow };
    this.turns.persistStreamState(harnessId, state);
  }

  // --- Harness registration ---

  registerHarness(harnessId: string, type: string): void {
    this.harnesses.register(harnessId, type, this.identity.sessionId ?? undefined);
  }

  reactivateHarness(harnessId: string): void {
    this.harnesses.reactivate(harnessId);
  }

  recordTurnStart(harnessId: string, channelId: string, input: TurnInput, triggerMessageId: string, triggerPubsubId: number, senderParticipantId?: string): void {
    const participantInfo = this.getParticipantInfo(channelId);
    const typingContent = JSON.stringify({
      senderId: input.senderId,
      senderName: participantInfo.name,
      senderType: participantInfo.type,
    });
    this.setActiveTurn(harnessId, channelId, triggerMessageId, undefined, senderParticipantId, typingContent);

    this.adoptBootstrapTyping(harnessId, channelId);

    this.setInFlightTurn(channelId, harnessId, triggerMessageId, triggerPubsubId, input);
    this.advanceCheckpoint(channelId, harnessId, triggerPubsubId);
    // Phase 1B: Schedule watchdog when a turn starts
    this.scheduleWatchdog();
  }

  // --- Approval level caching ---

  protected setApprovalLevel(channelId: string, level: number): void {
    this.setStateValue(`approvalLevel:${channelId}`, String(level));
  }

  protected getApprovalLevel(channelId: string): number {
    const value = this.getStateValue(`approvalLevel:${channelId}`);
    if (!value) return 2; // Default: Full Auto
    return parseInt(value, 10) || 2; // Default to Full Auto on parse failure
  }

  protected shouldAutoApprove(channelId: string, toolName: string): boolean {
    return !needsApprovalForTool(toolName, this.getApprovalLevel(channelId));
  }

  // ── Channel event pipeline (dedup → gap repair → dispatch) ──────────────

  /** Top-level handler for incoming channel events. Runs dedup, gap repair, poison skip, then dispatch. */
  private async handleIncomingChannelEvent(channelId: string, event: ChannelEvent): Promise<void> {
    const eventId = event.id;

    // Phase 0A: Delivery cursor dedup — skip already-delivered events
    if (eventId !== undefined && eventId > 0) {
      const lastSeq = this.getDeliveryCursor(channelId);
      if (eventId <= lastSeq) return;

      // Phase 2B: Gap detection — repair missed events before processing this one
      if (eventId > lastSeq + 1) {
        await this.repairGap(channelId, lastSeq, eventId);
      }

      // Phase 0D: Skip poison messages that have failed too many times
      const attempts = this.failedEvents.get(eventId) ?? 0;
      if (attempts >= AgentWorkerBase.POISON_MAX_ATTEMPTS) {
        console.error(`[AgentWorkerBase] Skipping poison event id=${eventId} after ${attempts} failed attempts`);
        this.advanceDeliveryCursor(channelId, eventId);
        this.failedEvents.delete(eventId);
        return;
      }
    }

    // Dispatch and track success/failure
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

  /** Fetch and process events missed between lastSeq and eventId. */
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

  /**
   * Dispatch a channel event through config-update interception then to the subclass.
   * Used by both the live path and gap repair to ensure consistent handling.
   */
  private async dispatchChannelEvent(channelId: string, event: ChannelEvent): Promise<void> {
    // Config-update interception — apply approval level changes before subclass sees the event
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
      if (newLevel !== undefined) {
        this.setApprovalLevel(channelId, newLevel);
        if (newLevel >= 2) {
          try {
            await this.reevaluatePendingApprovals(channelId);
          } catch (err) {
            console.error("[AgentWorkerBase] reevaluatePendingApprovals failed:", err);
          }
        }
      }
      return; // Config-update events are not dispatched to the subclass
    }

    // Dispatch to subclass
    await this.onChannelEvent(channelId, event);
  }

  protected async reevaluatePendingApprovals(channelId: string): Promise<void> {
    const pending = this.continuations.listForChannel(channelId, 'approval');

    for (const call of pending) {
      const context = call.context as { harnessId: string; toolUseId: string };
      const activeHarnessId = this.getActiveHarness();
      if (activeHarnessId === context.harnessId) {
        this.continuations.deleteOne(call.callId);
        await this.rpc.call("main", "harness.sendCommand", context.harnessId, {
          type: "approve-tool",
          toolUseId: context.toolUseId,
          allow: true,
        });
        // Clear continuation flag — harness will resume immediately
        this.turns.setPendingContinuation(context.harnessId, false);
        try {
          const channel = this.createChannelClient(channelId);
          await channel.cancelCall(call.callId);
        } catch { /* best-effort */ }
      }
    }
  }

  // --- Pending call continuations ---

  protected pendingCall(callId: string, channelId: string, type: string, context: Record<string, unknown>): void {
    this.continuations.store(callId, channelId, type, context);
  }

  protected consumePendingCall(callId: string) {
    return this.continuations.consume(callId);
  }

  async onCallResult(callId: string, result: unknown, isError: boolean): Promise<void> {
    const pending = this.consumePendingCall(callId);
    if (!pending) {
      console.warn(`[AgentWorkerBase] onCallResult: no pending call for callId=${callId} (isError=${isError})`);
      return;
    }
    // Phase 1B: Clear pending continuation — the harness will resume
    const harnessId = (pending.context as Record<string, unknown>)["harnessId"] as string | undefined;
    if (harnessId) {
      this.turns.setPendingContinuation(harnessId, false);
    }
    await this.handleCallResult(pending.type, pending.context, pending.channelId, result, isError);
  }

  protected async handleCallResult(
    _type: string, _context: Record<string, unknown>,
    _channelId: string, _result: unknown, _isError: boolean,
  ): Promise<void> {
    // Default: no-op
  }

  // --- Phase 1B: Turn watchdog ---

  private static readonly WATCHDOG_INTERVAL_MS = 2 * 60 * 1000;   // Check every 2 min
  private static readonly WATCHDOG_IDLE_MS = 10 * 60 * 1000;      // 10 min idle = stale

  /** Schedule watchdog alarm to check for stale turns. */
  protected scheduleWatchdog(): void {
    if (this.getStateValue("watchdog_scheduled")) return;
    this.setStateValue("watchdog_scheduled", "1");
    this.setAlarm(AgentWorkerBase.WATCHDOG_INTERVAL_MS);
  }

  /** Check for and recover stale turns. Called from alarm handler. */
  private async checkStaleTurns(): Promise<void> {
    const staleTurns = this.turns.getStaleActiveTurns(AgentWorkerBase.WATCHDOG_IDLE_MS);
    for (const stale of staleTurns) {
      console.error(`[AgentWorkerBase] Watchdog: stale turn detected for harness=${stale.harnessId} on channel=${stale.channelId}`);
      try {
        // Publish error to channel BEFORE clearing active turn
        const participantId = this.subscriptions.getParticipantId(stale.channelId);
        if (participantId) {
          const channel = this.createChannelClient(stale.channelId);
          const writer = new StreamWriter(channel, participantId, stale.channelId, stale.replyToId, stale.typingContent, stale.streamState);
          await writer.startText();
          await writer.updateText("[Turn timed out — the AI process may have crashed or become unresponsive.]");
          await writer.completeText();
        }
      } catch (err) {
        console.error("[AgentWorkerBase] Watchdog: failed to publish error:", err);
      }
      // Clear the stale turn and harness
      this.turns.clearActive(stale.harnessId);
      this.harnesses.stop(stale.harnessId).catch(() => {});
      // Queued turns remain in the queue — the next onChannelEvent will find
      // no active harness, spawn a new one, and drain the queue naturally
    }
  }

  override async alarm(): Promise<void> {
    await super.alarm();
    // Phase 1B: Watchdog check
    if (this.getStateValue("watchdog_scheduled")) {
      this.deleteStateValue("watchdog_scheduled");
      await this.checkStaleTurns();
      // Reschedule if there are still active turns
      const activeTurns = this.sql.exec(`SELECT COUNT(*) as cnt FROM active_turns`).toArray();
      if ((activeTurns[0]?.["cnt"] as number) > 0) {
        this.scheduleWatchdog();
      }
    }
  }

  // --- Fork support ---

  /**
   * Preflight check for fork operations. Returns subscription count so the
   * caller can decide the threshold: cloned DOs allow ≤1 (single-channel),
   * replacement DOs require exactly 0 (must be fresh).
   */
  async canFork(): Promise<{ ok: boolean; subscriptionCount: number; reason?: string }> {
    const count = this.sql.exec(`SELECT COUNT(*) as cnt FROM subscriptions`).toArray();
    const n = (count[0]?.["cnt"] as number) ?? 0;
    if (n > 1) {
      return { ok: false, subscriptionCount: n, reason: "multi-channel" };
    }
    return { ok: true, subscriptionCount: n };
  }

  /**
   * Called on the NEWLY CLONED agent DO after cloneDO copies parent's SQLite.
   * Rewrites identity, clears ephemeral state, resubscribes to forked channel.
   */
  async postClone(
    parentObjectKey: string,
    newChannelId: string,
    oldChannelId: string,
    forkPointPubsubId: number,
  ): Promise<void> {
    // Fix __objectKey (cloneDO copied parent's key).
    // ensureBootstrapped() in fetch() already sets the correct objectKey and doRef,
    // but __objectKey in the state table still has the parent's value from the clone.
    this.sql.exec(
      `INSERT OR REPLACE INTO state (key, value) VALUES ('__objectKey', ?)`,
      this.objectKey,
    );

    // RPC identity is automatically updated: the dispatch that calls postClone
    // delivers the clone's fresh instance token via X-Instance-Token header,
    // and fetch() always overwrites identity from headers.

    // Record fork metadata in state KV
    this.setStateValue("forkedFrom", parentObjectKey);
    this.setStateValue("forkPointPubsubId", String(forkPointPubsubId));
    this.setStateValue("forkSourceChannel", oldChannelId);

    // 4. Resolve fork session ID from turn_map — single deterministic query
    //    across all harnesses, picking the most recent turn at or before the fork point.
    const sessionRow = this.sql.exec(
      `SELECT external_session_id FROM turn_map WHERE trigger_pubsub_id <= ? ORDER BY trigger_pubsub_id DESC LIMIT 1`,
      forkPointPubsubId,
    ).toArray();
    if (sessionRow.length > 0) {
      this.setStateValue("forkSessionId", sessionRow[0]!["external_session_id"] as string);
    }

    // 5. Mark all harnesses as stopped
    this.sql.exec(`UPDATE harnesses SET status = 'stopped' WHERE status != 'stopped'`);

    // 6. Clear ephemeral tables
    this.sql.exec(`DELETE FROM active_turns`);
    this.sql.exec(`DELETE FROM in_flight_turns`);
    this.sql.exec(`DELETE FROM queued_turns`);
    this.sql.exec(`DELETE FROM pending_calls`);
    this.sql.exec(`DELETE FROM checkpoints`);
    this.sql.exec(`DELETE FROM delivery_cursor`);

    // 7. Clean state KV: remove bootstrap typing entries, rename approval level keys
    const stateRows = this.sql.exec(`SELECT key FROM state WHERE key LIKE 'bootstrap_typing:%'`).toArray();
    for (const row of stateRows) {
      this.deleteStateValue(row["key"] as string);
    }

    // Rename approvalLevel from old channel to new channel
    const oldApprovalKey = `approvalLevel:${oldChannelId}`;
    const newApprovalKey = `approvalLevel:${newChannelId}`;
    const approvalValue = this.getStateValue(oldApprovalKey);
    if (approvalValue) {
      this.setStateValue(newApprovalKey, approvalValue);
      this.deleteStateValue(oldApprovalKey);
    }

    // 8. Resubscribe to forked channel
    // Read old subscription data before deleting
    const subRow = this.sql.exec(
      `SELECT context_id, config FROM subscriptions WHERE channel_id = ?`, oldChannelId,
    ).toArray();
    const contextId = subRow.length > 0 ? (subRow[0]!["context_id"] as string) : undefined;
    const configRaw = subRow.length > 0 ? (subRow[0]!["config"] as string | null) : null;
    const config = configRaw ? JSON.parse(configRaw) : undefined;

    // Delete old subscription
    this.sql.exec(`DELETE FROM subscriptions`);

    // Subscribe to forked channel (calls SubscriptionManager which calls channel.subscribe)
    if (contextId) {
      await this.subscribeChannel({ channelId: newChannelId, contextId, config });
    }

    // 9. Subclass hook
    await this.onPostClone(parentObjectKey, newChannelId, oldChannelId, forkPointPubsubId);
  }

  /** Subclass hook called at end of postClone(). Override for custom cleanup. */
  protected async onPostClone(
    _parentObjectKey: string,
    _newChannelId: string,
    _oldChannelId: string,
    _forkPointPubsubId: number,
  ): Promise<void> {
    // Default: no-op
  }

  // --- Abstract methods ---

  abstract onChannelEvent(channelId: string, event: ChannelEvent): Promise<void>;
  abstract onHarnessEvent(harnessId: string, event: HarnessOutput): Promise<void>;

  async onMethodCall(_channelId: string, _callId: string, _methodName: string, _args: unknown): Promise<{ result: unknown; isError?: boolean }> {
    return { result: { error: 'not implemented' }, isError: true };
  }

  // --- Fetch override for agent-specific event handling ---

  override async fetch(request: Request): Promise<Response> {
    this.ensureReady();

    // Parse /{objectKey}/{method} from URL (same as base class)
    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length >= 1 && !(this as any)._objectKey) {
      (this as any)._objectKey = decodeURIComponent(segments[0]!);
    }

    // Self-bootstrap from env bindings now that objectKey is available
    this.ensureBootstrapped();

    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return this.handleWebSocketUpgrade(request);
    }

    const method = segments.slice(1).join("/") || "getState";

    // RPC infrastructure endpoints (must match DurableObjectBase)
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

      // Channel DO sends proper ChannelEvent objects — intercept for dedup, gap detection, dispatch
      if (method === "onChannelEvent" && args.length === 2) {
        await this.handleIncomingChannelEvent(args[0] as string, args[1] as ChannelEvent);
        return new Response(JSON.stringify(null), {
          headers: { "Content-Type": "application/json" },
        });
      }

      // Phase 0C: Harness fencing — validate session for harness events
      if (method === "onHarnessEvent" && args.length === 2) {
        const harnessId = args[0] as string;
        const sessionId = this.identity.sessionId;
        if (sessionId && !this.harnesses.isCurrentSession(harnessId, sessionId)) {
          console.warn(`[AgentWorkerBase] Rejecting event from stale harness ${harnessId} (wrong session)`);
          // Best-effort stop of zombie harness
          this.harnesses.stop(harnessId).catch(() => {});
          return new Response(JSON.stringify(null), {
            headers: { "Content-Type": "application/json" },
          });
        }
        // Phase 1B: Touch activity timestamp for watchdog
        this.turns.touchActive(harnessId);
        // Phase 1B: Track continuation state based on harness event type
        const harnessEvent = args[1] as { type: string };
        if (harnessEvent.type === "approval-needed" || harnessEvent.type === "tool-call") {
          this.turns.setPendingContinuation(harnessId, true);
        } else if (harnessEvent.type === "turn-complete" || harnessEvent.type === "error") {
          this.turns.setPendingContinuation(harnessId, false);
        }
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
    const harnesses = this.sql.exec(`SELECT * FROM harnesses`).toArray();
    const activeTurns = this.sql.exec(`SELECT * FROM active_turns`).toArray();
    const checkpoints = this.sql.exec(`SELECT * FROM checkpoints`).toArray();
    const inFlightTurns = this.sql.exec(`SELECT * FROM in_flight_turns`).toArray();
    const queuedTurns = this.sql.exec(`SELECT * FROM queued_turns`).toArray();
    const pendingCalls = this.sql.exec(`SELECT * FROM pending_calls`).toArray();
    const deliveryCursors = this.sql.exec(`SELECT * FROM delivery_cursor`).toArray();
    return { subscriptions, harnesses, activeTurns, checkpoints, inFlightTurns, queuedTurns, pendingCalls, deliveryCursors };
  }
}
