/**
 * Agent loop driver (WS1 §2) — the only impure layer of the event-sourced
 * harness. Owns the effect outbox, the fold cache, executor dispatch, and
 * the gad-store client. One LoopInstance per subscribed channel; shared
 * outbox; one alarm.
 *
 * Discipline (P2): every append carries `expectedHeadHash = state.lastHash`;
 * outcome events are appended BEFORE their outbox row is deleted; the
 * reconcile (§2.2) converges both crash directions and full cache amnesia.
 */

import {
  composeStep,
  classifyModelFailure,
  derivePendingEffects,
  ids,
  outcomeEvents,
  type AgentLoopConfig,
  type AgentState,
  type AppendItem,
  type EffectDescriptor,
  type EffectOutcome,
  type Incoming,
  type StepContext,
  type StepFn,
  type StepPolicy,
  applyEvent,
  modelFailureInputFromUnknown,
} from "@workspace/agent-loop";
import {
  AGENTIC_PROTOCOL_VERSION,
  classifyGadAppendError,
  encodeAgenticEventStoredValues,
  hydrateStoredValueRefs,
  type AgenticEvent,
  type LogEnvelope,
  type ParticipantRef,
} from "@workspace/agentic-protocol";
import type { SqlStorage } from "@workspace/runtime/worker";
import {
  EffectOutbox,
  maxAttempts,
  outboxExternalId,
  parseOutboxExternalId,
  type OutboxRow,
} from "./effect-outbox.js";
import { FoldCache, type GadPort } from "./fold-cache.js";
import {
  executorFor,
  type EffectExecutor,
  type EphemeralEmit,
  type ExecutorDeps,
} from "./effect-executors/index.js";
import { modelCredentialReconnectOutcome } from "./model-credential-suspension.js";

export interface LoopInstance {
  channelId: string;
  logId: string;
  head: string;
  state: AgentState;
  step: StepFn;
}

export interface DriverDeps {
  sql: SqlStorage;
  gad: GadPort;
  executorDeps: ExecutorDeps;
  selfRefFor(channelId: string): ParticipantRef;
  configFor(channelId: string): AgentLoopConfig;
  policiesFor(channelId: string): StepPolicy[];
  onEphemeral(emit: EphemeralEmit): void;
  now(): number;
  scheduleAlarm(atMs: number): void;
  /** Run work as a background continuation of the current execution context
   *  (DO waitUntil). The pump uses it as the low-latency dispatch path; the
   *  alarm remains the durable backstop. */
  runBackground?(fn: () => Promise<unknown>): void;
  /** Live fan-out for GAD-created channel publication rows. The trajectory log
   *  append is authoritative; this only wakes channel subscribers in-process. */
  broadcastStoredEnvelopes?(channelId: string, envelopeIds: string[]): Promise<void>;
  onHeartbeatOutcome?(input: {
    channelId: string;
    descriptor: EffectDescriptor;
    outcome: EffectOutcome;
  }): void | Promise<void>;
  /** Compaction trigger thresholds. The vessel sizes `triggerBytes` relative
   *  to the model context window (the deleted CompactionTrigger used ~0.8× the
   *  window); the constants are conservative fallbacks. A turn is never
   *  compacted (the openTurn guard), so the trigger only governs how much
   *  idle history accumulates before a fold-shrinking compaction runs. */
  compaction?: { minEntries?: number; triggerBytes?: number };
  /** test seam: executor override (crash injection / fakes). */
  executorOverride?(descriptor: EffectDescriptor): EffectExecutor | null;
  /** test seam: invoked between named kill points; throw to simulate a crash. */
  killPoint?(point: string): void;
}

type OutcomeAddress = { branchId?: string; channelId?: string };

const APPEND_RETRIES = 1;
const COMPACTION_MIN_ENTRIES = 24;
const COMPACTION_TRIGGER_BYTES = 64 * 1024;
const RECOVERY_READ_PAGE = 500;
const textEncoder = new TextEncoder();
/** Head conflicts mean our events are NEW and the fold is merely behind —
 *  worth more persistence than the divergence errors. */
const HEAD_CONFLICT_RETRIES = 3;

interface ScheduledModelResumeRow {
  channelId: string;
  messageId: string;
  resetAtMs: number;
  createdAt: number;
}

function ensureScheduledModelResumeSchema(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_model_resumes (
      channel_id  TEXT NOT NULL,
      message_id  TEXT NOT NULL,
      reset_at_ms INTEGER NOT NULL,
      created_at  INTEGER NOT NULL,
      PRIMARY KEY (channel_id, message_id)
    )
  `);
  sql.exec(`
    CREATE INDEX IF NOT EXISTS idx_scheduled_model_resumes_due
      ON scheduled_model_resumes(reset_at_ms)
  `);
}

function mapScheduledModelResumeRow(row: Record<string, unknown>): ScheduledModelResumeRow {
  return {
    channelId: String(row["channel_id"]),
    messageId: String(row["message_id"]),
    resetAtMs: Number(row["reset_at_ms"]),
    createdAt: Number(row["created_at"] ?? 0),
  };
}

function recordPayload(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function deferredErrorMessage(result: unknown): string {
  if (result instanceof Error) return result.message;
  if (result && typeof result === "object") {
    const message = (result as Record<string, unknown>)["message"];
    if (typeof message === "string" && message.trim()) return message;
  }
  return typeof result === "string" && result.trim() ? result : "Deferred call failed";
}

/** Append failures that mean "our in-memory fold is behind the log" —
 *  classified by the store's typed error contract, never by prose. */
function isStaleStateAppendError(err: Error): boolean {
  return classifyGadAppendError(err) !== null;
}

export class AgentLoopDriver {
  readonly outbox: EffectOutbox;
  readonly foldCache: FoldCache;
  private readonly loops = new Map<string, LoopInstance>();
  private readonly aborts = new Map<
    string,
    { controller: AbortController; branchId: string; effectId: string; channelId: string }
  >();

  constructor(private readonly deps: DriverDeps) {
    this.outbox = new EffectOutbox(deps.sql);
    ensureScheduledModelResumeSchema(deps.sql);
    this.foldCache = new FoldCache(deps.sql, deps.gad);
  }

  private kill(point: string): void {
    this.deps.killPoint?.(point);
  }

  private rowKey(row: Pick<OutboxRow, "branchId" | "effectId">): string {
    return `${row.branchId}\u0000${row.effectId}`;
  }

  private dispatchDescriptor(row: OutboxRow, descriptor: EffectDescriptor): EffectDescriptor {
    if (
      descriptor.kind !== "model_call" &&
      descriptor.kind !== "http_call" &&
      descriptor.kind !== "credential_wait"
    ) {
      return descriptor;
    }
    return {
      ...descriptor,
      effectId: outboxExternalId(row.branchId, row.effectId),
    } as EffectDescriptor;
  }

  private outcomeRow(effectId: string, address: OutcomeAddress = {}): OutboxRow | null {
    const parsed = parseOutboxExternalId(effectId);
    if (parsed) return this.outbox.get(parsed.branchId, parsed.effectId);
    if (address.branchId) return this.outbox.get(address.branchId, effectId);
    if (address.channelId) return this.outbox.getForChannel(address.channelId, effectId);
    return this.outbox.getUnique(effectId);
  }

  private selfRef(channelId: string): ParticipantRef {
    return this.deps.selfRefFor(channelId);
  }

  private executorDeps(channelId: string): ExecutorDeps {
    return { ...this.deps.executorDeps, selfRef: this.selfRef(channelId) };
  }

  private stepCtx(channelId: string): StepContext {
    let counter = 0;
    return {
      now: new Date(this.deps.now()).toISOString(),
      random: () => `r:${this.deps.now()}:${(counter += 1)}`,
      selfRef: this.selfRef(channelId),
    };
  }

  async loop(channelId: string): Promise<LoopInstance> {
    const existing = this.loops.get(channelId);
    if (existing) return existing;
    const logId = ids.logIdForChannel(channelId);
    const state = await this.foldCache.loadState({
      logId,
      head: logId,
      channelId,
      config: this.deps.configFor(channelId),
    });
    const instance: LoopInstance = {
      channelId,
      logId,
      head: logId,
      state,
      step: composeStep(this.deps.policiesFor(channelId)),
    };
    this.loops.set(channelId, instance);
    return instance;
  }

  dropLoop(channelId: string): void {
    this.loops.delete(channelId);
  }

  /** Wake protocol: validate fold, run the wake command, reconcile, dispatch. */
  async wake(channelId: string): Promise<void> {
    this.loops.delete(channelId); // force re-validation against the remote head
    const loop = await this.loop(channelId);
    if (this.inFlightModelCallIsQueuedOrRunningHere(loop)) {
      await this.settle(channelId);
      await this.recoverOpenTurnAfterReplay(channelId);
      return;
    }
    await this.runStep(loop, { type: "command", command: { kind: "wake" } }, APPEND_RETRIES);
    await this.settle(channelId);
    await this.recoverOpenTurnAfterReplay(channelId);
  }

  private inFlightModelCallIsQueuedOrRunningHere(loop: LoopInstance): boolean {
    const inFlight = loop.state.inFlightModelCall;
    if (!inFlight) return false;
    const row = this.outbox.get(loop.logId, ids.modelEffect(inFlight.messageId));
    if (!row) return false;
    // A queued/backing-off row is not an orphan; let the pump dispatch/retry it.
    if (row.leaseExpiresAt === null) return true;
    // A leased row with a live AbortController is running in this isolate. This
    // covers model fetches parked behind credential-use approval prompts.
    return this.aborts.has(this.rowKey(row));
  }

  /**
   * Hibernation-first execution discipline: inbound interactions (channel
   * deliveries, method calls, outcome callbacks) only JOURNAL (bounded
   * appends), reconcile the outbox, and arm the alarm. The DO alarm is the
   * single effect pump — no inbound RPC ever blocks on effect latency (a
   * model stream can outlive any request/connection), and work orphaned by
   * eviction or a hung stream becomes due again exactly at lease expiry.
   */
  async handleIncoming(channelId: string, incoming: Incoming): Promise<void> {
    const loop = await this.loop(channelId);
    await this.runStep(loop, incoming, APPEND_RETRIES);
    await this.settle(channelId);
  }

  /** Post-processing chokepoint shared by handleIncoming and applyOutcome.
   *  ALWAYS re-fetches the live loop via this.loop() — runStep may have
   *  reloaded and replaced the instance, so the caller's binding can be
   *  stale; operating on a dropped instance would mis-evaluate openTurn and
   *  let reconcile churn rows the fresh retry just inserted. Compaction is
   *  checked here (at idle, AFTER a turn closes) rather than on the inbound
   *  prompt — a prompt opens a turn in the same runStep, so the openTurn
   *  guard would otherwise skip compaction for the entire active session. */
  private async settle(channelId: string): Promise<void> {
    await this.maybeCompact(await this.loop(channelId));
    await this.reconcile(await this.loop(channelId));
    this.requestPump();
  }

  /**
   * Replay invariant: after a subscribe/reload wake, an open turn must have a
   * concrete path forward. Normal recovery is handled by C-wake and reconcile:
   * in-flight model calls become model rows, pending invocations/approvals/
   * credential waits derive effects, and scheduled reset resumes remain
   * parked as explicit waiting turns. The only remaining unsafe state is an
   * open, non-waiting turn with no in-flight call, no derived effects, and no
   * scheduled resume. That usually means the process crashed after appending a
   * terminal event but before running its event-appended cascade. Re-feed the
   * latest durable cascade event first; only if the log cannot explain the
   * open turn do we publish a deterministic recovery failure and close it.
   */
  private async recoverOpenTurnAfterReplay(channelId: string): Promise<void> {
    let loop = await this.loop(channelId);
    if (!this.isOpenTurnStranded(loop)) return;

    const cascade = await this.latestCascadeEnvelopeForOpenTurn(loop);
    if (cascade) {
      await this.runStep(loop, { type: "event-appended", envelope: cascade }, APPEND_RETRIES);
      await this.settle(channelId);
      loop = await this.loop(channelId);
      if (!this.isOpenTurnStranded(loop)) return;
    }

    await this.appendStrandedOpenTurnFailure(loop);
    await this.settle(channelId);
  }

  private isOpenTurnStranded(loop: LoopInstance): boolean {
    const turn = loop.state.openTurn;
    if (!turn) return false;
    if (loop.state.inFlightModelCall) return false;
    if (turn.waitingCount > 0) return false;
    if (derivePendingEffects(loop.state).length > 0) return false;
    if (this.outbox.forBranch(loop.logId).length > 0) return false;
    if (this.hasScheduledModelResumeForTurn(loop.channelId, turn.turnId)) return false;
    return true;
  }

  private hasScheduledModelResumeForTurn(channelId: string, turnId: string): boolean {
    const rows = this.deps.sql
      .exec(
        `SELECT message_id FROM scheduled_model_resumes
         WHERE channel_id = ?`,
        channelId
      )
      .toArray() as Record<string, unknown>[];
    const prefix = `m:${turnId}:`;
    return rows.some((row) => String(row["message_id"] ?? "").startsWith(prefix));
  }

  private async latestCascadeEnvelopeForOpenTurn(loop: LoopInstance): Promise<LogEnvelope | null> {
    const turn = loop.state.openTurn;
    if (!turn) return null;
    let cursor = Math.max(0, turn.openedAtSeq - 1);
    let latest: LogEnvelope | null = null;
    for (;;) {
      const page = await this.deps.gad.call<LogEnvelope[]>("readLog", {
        logId: loop.logId,
        head: loop.head,
        afterSeq: cursor,
        limit: RECOVERY_READ_PAGE,
      });
      if (page.length === 0) break;
      for (const envelope of page) {
        if (this.isReplayCascadeEnvelope(envelope, turn.turnId)) latest = envelope;
      }
      cursor = page[page.length - 1]!.seq;
      if (page.length < RECOVERY_READ_PAGE) break;
    }
    return latest;
  }

  private isReplayCascadeEnvelope(envelope: LogEnvelope, turnId: string): boolean {
    switch (envelope.payloadKind) {
      case "message.completed": {
        if (!this.envelopeBelongsToTurn(envelope, turnId)) return false;
        const payload = recordPayload(envelope.payload);
        return payload["role"] === "assistant";
      }
      case "message.failed":
        return this.envelopeBelongsToTurn(envelope, turnId);
      case "invocation.completed":
      case "invocation.failed":
      case "invocation.cancelled":
      case "invocation.abandoned":
      case "approval.resolved":
        if (envelope.causality?.turnId !== turnId) return false;
        return true;
      case "system.event": {
        if (envelope.causality?.turnId !== turnId) return false;
        const payload = recordPayload(envelope.payload);
        const details = recordPayload(payload["details"]);
        const kind = String(details["kind"] ?? payload["kind"] ?? "");
        return (
          kind === "credential.wait_resolved" ||
          kind === "credential.resolved" ||
          kind === "interrupt"
        );
      }
      default:
        return false;
    }
  }

  private envelopeBelongsToTurn(envelope: LogEnvelope, turnId: string): boolean {
    if (envelope.causality?.turnId === turnId) return true;
    const messageId = String(envelope.causality?.messageId ?? "");
    return messageId.startsWith(`m:${turnId}:`);
  }

  private async appendStrandedOpenTurnFailure(loop: LoopInstance): Promise<void> {
    const turn = loop.state.openTurn;
    if (!turn) return;
    const messageId = `recovery:${turn.turnId}:stranded-open-turn`;
    const reason =
      "Agent turn recovery failed: replay found an open turn with no pending model call, " +
      "tool, approval, credential wait, scheduled resume, or terminal assistant cascade.";
    const items: AppendItem[] = [
      {
        envelopeId: ids.messageTerminal(messageId),
        payloadKind: "message.failed",
        payload: {
          protocol: AGENTIC_PROTOCOL_VERSION,
          reason,
          recoverable: false,
          code: "stranded_open_turn",
        },
        causality: { messageId: messageId as never, turnId: turn.turnId },
        publish: true,
      },
      ...this.strandedOpenTurnCleanupItems(loop.state),
      {
        envelopeId: ids.turnClosed(turn.turnId),
        payloadKind: "turn.closed",
        payload: {
          protocol: AGENTIC_PROTOCOL_VERSION,
          reason: "work_failed",
          summary: "Recovery failed: no pending work remained for the open turn.",
        },
        causality: { turnId: turn.turnId },
        publish: true,
      },
    ];

    try {
      const envelopes = await this.append(loop, items);
      for (const envelope of envelopes) loop.state = applyEvent(loop.state, envelope);
      this.foldCache.write(loop.state);
    } catch (err) {
      if (err instanceof Error && isStaleStateAppendError(err)) {
        this.loops.delete(loop.channelId);
        const fresh = await this.loop(loop.channelId);
        if (!this.isOpenTurnStranded(fresh)) return;
        const envelopes = await this.append(fresh, items);
        for (const envelope of envelopes) fresh.state = applyEvent(fresh.state, envelope);
        this.foldCache.write(fresh.state);
        return;
      }
      throw err;
    }
  }

  private strandedOpenTurnCleanupItems(state: AgentState): AppendItem[] {
    const turn = state.openTurn;
    if (!turn) return [];
    const items: AppendItem[] = [];
    for (const invocation of Object.values(state.pendingInvocations)) {
      items.push({
        envelopeId: ids.invocationTerminal(invocation.invocationId),
        payloadKind: "invocation.abandoned",
        payload: {
          protocol: AGENTIC_PROTOCOL_VERSION,
          reason: "Agent turn recovery failed before invocation completed",
          terminalOutcome: "abandoned",
          terminalReasonCode: "stranded_open_turn",
        },
        causality: {
          invocationId: invocation.invocationId as never,
          turnId: invocation.turnId,
        },
        publish: true,
      });
    }
    for (const approval of Object.values(state.pendingApprovals)) {
      items.push({
        envelopeId: ids.approvalResolved(approval.approvalId),
        payloadKind: "approval.resolved",
        payload: {
          protocol: AGENTIC_PROTOCOL_VERSION,
          granted: false,
          resolvedBy: { kind: "system", id: "agent-loop" },
          reason: "stranded_open_turn",
        },
        causality: {
          approvalId: approval.approvalId as never,
          invocationId: approval.invocationId as never,
          turnId: approval.turnId,
        },
        publish: true,
      });
    }
    for (const wait of Object.values(state.pendingCredentialWaits)) {
      items.push({
        envelopeId: ids.systemEvent(wait.credKey, "resolved", wait.startedAtSeq),
        payloadKind: "system.event",
        payload: {
          protocol: AGENTIC_PROTOCOL_VERSION,
          kind: "credential.wait_resolved",
          credKey: wait.credKey,
          details: {
            kind: "credential.wait_resolved",
            credKey: wait.credKey,
            providerId: wait.providerId,
            resolved: false,
            reason: "stranded_open_turn",
          },
        },
        causality: { turnId: wait.turnId },
        publish: true,
      });
    }
    return items;
  }

  /** Isolated so a failing compaction append can never fail the delivery
   *  whose journal work already succeeded (AL-8 inverse wedge). */
  private async maybeCompact(loop: LoopInstance): Promise<void> {
    if (loop.state.openTurn) return;
    const minEntries = this.deps.compaction?.minEntries ?? COMPACTION_MIN_ENTRIES;
    const triggerBytes = this.deps.compaction?.triggerBytes ?? COMPACTION_TRIGGER_BYTES;
    if (loop.state.entries.length < minEntries) return;
    const bytes = textEncoder.encode(JSON.stringify(loop.state.entries)).byteLength;
    if (bytes < triggerBytes) return;
    try {
      await this.runStep(loop, { type: "command", command: { kind: "compact" } }, APPEND_RETRIES);
    } catch (err) {
      console.warn(`[AgentLoopDriver] compaction append failed for ${loop.channelId}:`, err);
    }
  }

  private async runStep(loop: LoopInstance, incoming: Incoming, retries: number): Promise<void> {
    const output = loop.step(loop.state, incoming, this.stepCtx(loop.channelId));
    if (output.append.length === 0 && output.effects.length === 0) return;
    let envelopes: LogEnvelope[];
    try {
      envelopes = await this.append(loop, output.append);
    } catch (err) {
      if (retries > 0 && err instanceof Error && isStaleStateAppendError(err)) {
        // Another writer advanced the log, or our fold was stale and re-derived
        // an already-journaled event with different (environment-dependent)
        // content. Either way the LOG is truth: reload the fold and re-run —
        // the journaled originals dedupe and only genuinely-new events append.
        this.loops.delete(loop.channelId);
        const fresh = await this.loop(loop.channelId);
        return this.runStep(fresh, incoming, retries - 1);
      }
      if (
        err instanceof Error &&
        isStaleStateAppendError(err) &&
        (await this.ingestCommandAlreadyJournaled(loop, incoming))
      ) {
        return;
      }
      throw err;
    }
    this.kill("after-append");
    // fold + cache + insert NEW effect rows (descriptors are a latency path;
    // the reconcile would re-derive them — P2)
    for (const envelope of envelopes) {
      loop.state = applyEvent(loop.state, envelope);
    }
    this.foldCache.write(loop.state);
    this.kill("after-fold-cache");
    for (const effect of output.effects) {
      this.outbox.insert(loop.logId, effect, this.initialDeadline(effect));
    }
    this.kill("after-outbox-insert");
    // event-appended cascade (depth-first, like the scenario harness)
    for (const envelope of envelopes) {
      await this.runStep(loop, { type: "event-appended", envelope }, retries);
    }
  }

  private async ingestCommandAlreadyJournaled(
    loop: LoopInstance,
    incoming: Incoming
  ): Promise<boolean> {
    if (incoming.type !== "command") return false;
    if (incoming.command.kind !== "prompt" && incoming.command.kind !== "steer") return false;
    const envelopeId = ids.recvUserMessage(loop.channelId, incoming.command.source.envelopeId);
    const existing = await this.deps.gad.call<LogEnvelope | null>("getLogEvent", {
      logId: loop.logId,
      head: loop.head,
      envelopeId,
    });
    return existing != null;
  }

  private initialDeadline(_effect: EffectDescriptor): number | null {
    // Every effect dispatches immediately — including credential_wait, whose
    // executor publishes the connect card and registers credential interest
    // (both idempotent). Expiry is judged in dispatchDue against the
    // DESCRIPTOR's expiresAt, never against the outbox redrive deadline.
    return null;
  }

  private async append(loop: LoopInstance, items: AppendItem[]): Promise<LogEnvelope[]> {
    if (items.length === 0) return [];
    // Storage boundary: oversized / boundary-listed payload fields spill to
    // the blobstore before the durable append (the fold keeps refs; executors
    // hydrate when they need bytes).
    const encoded = await Promise.all(
      items.map(async (item) => {
        const selfRef = this.selfRef(loop.channelId);
        const { event } = await encodeAgenticEventStoredValues(
          {
            kind: item.payloadKind,
            actor: selfRef,
            payload: item.payload,
            createdAt: new Date(this.deps.now()).toISOString(),
          } as unknown as AgenticEvent,
          { putText: (value) => this.executorDeps(loop.channelId).blobstore.putText(value) }
        );
        return { ...item, payload: event.payload };
      })
    );
    items = encoded;
    const selfRef = this.selfRef(loop.channelId);
    const result = await this.deps.gad.call<{
      envelopes: LogEnvelope[];
      headSeq: number;
      headHash: string;
      published?: Array<{ originEnvelopeId: string; channelId: string; envelopeId: string }>;
    }>("appendLogEvent", {
      logId: loop.logId,
      head: loop.head,
      logKind: "trajectory",
      owner: { kind: "agent", id: selfRef.id },
      expectedHeadHash: loop.state.lastHash,
      events: items.map((item) => ({
        envelopeId: item.envelopeId,
        actor: selfRef,
        payloadKind: item.payloadKind,
        payload: item.payload,
        ...(item.causality ? { causality: item.causality } : {}),
        ...(item.publish ? { publish: { channels: [{ channelId: loop.channelId }] } } : {}),
      })),
    });
    // only the suffix that is new to this state matters for the fold
    const newEnvelopes = result.envelopes.filter((envelope) => envelope.seq > loop.state.lastSeq);
    await this.broadcastPublications(newEnvelopes, result.published ?? []);
    return newEnvelopes;
  }

  private async broadcastPublications(
    newEnvelopes: LogEnvelope[],
    published: Array<{ originEnvelopeId: string; channelId: string; envelopeId: string }>
  ): Promise<void> {
    if (
      !this.deps.broadcastStoredEnvelopes ||
      newEnvelopes.length === 0 ||
      published.length === 0
    ) {
      return;
    }
    const newOriginIds = new Set(newEnvelopes.map((envelope) => String(envelope.envelopeId)));
    const byChannel = new Map<string, string[]>();
    for (const publication of published) {
      if (!newOriginIds.has(publication.originEnvelopeId)) continue;
      const envelopeIds = byChannel.get(publication.channelId) ?? [];
      envelopeIds.push(publication.envelopeId);
      byChannel.set(publication.channelId, envelopeIds);
    }
    await Promise.all(
      [...byChannel.entries()].map(async ([channelId, envelopeIds]) => {
        try {
          await this.deps.broadcastStoredEnvelopes?.(channelId, envelopeIds);
        } catch (err) {
          console.warn(
            "[agent-loop-driver] failed to broadcast published envelopes:",
            err instanceof Error ? err.message : String(err)
          );
        }
      })
    );
  }

  /** §2.2 — replaces the recovery zoo. */
  async reconcile(loop: LoopInstance): Promise<void> {
    const expected = derivePendingEffects(loop.state);
    const expectedById = new Map(expected.map((effect) => [effect.effectId, effect]));
    const rows = this.outbox.forBranch(loop.logId);
    for (const row of rows) {
      if (!expectedById.has(row.effectId)) this.outbox.delete(row.branchId, row.effectId);
    }
    const present = new Set(rows.map((row) => row.effectId));
    for (const effect of expected) {
      if (!present.has(effect.effectId)) {
        this.outbox.insert(loop.logId, effect, this.initialDeadline(effect));
      }
    }
    this.scheduleEarliest();
  }

  scheduleEarliest(): void {
    const earliest = this.nextWakeAt();
    if (earliest != null) {
      this.deps.scheduleAlarm(Math.max(earliest, this.deps.now() + 50));
    }
  }

  nextWakeAt(): number | null {
    const outboxDue = this.outbox.earliestDueAt();
    const resumeDue = this.earliestScheduledModelResumeAt();
    const candidates = [outboxDue, resumeDue].filter(
      (value): value is number => typeof value === "number"
    );
    return candidates.length ? Math.min(...candidates) : null;
  }

  hasOpenTurn(channelId: string): boolean {
    const loop = this.loops.get(channelId);
    if (loop?.state.openTurn) return true;
    return this.outbox.forBranch(ids.logIdForChannel(channelId)).length > 0;
  }

  async dispatchDue(): Promise<void> {
    const now = this.deps.now();
    const work: Array<Promise<void>> = [];
    for (const row of this.outbox.due(now)) {
      // A credential wait past its own expiresAt is a failure, not a
      // dispatch. (Before expiry, a due row is just the periodic redrive —
      // the executor idempotently re-publishes the card + interest.)
      if (row.kind === "credential_wait") {
        const expiresAt = Date.parse(
          (row.descriptor as import("@workspace/agent-loop").CredentialWaitEffect).expiresAt
        );
        if (Number.isFinite(expiresAt) && expiresAt <= now) {
          work.push(this.failEffect(row, { message: "credential wait expired" }));
          continue;
        }
      }
      work.push(this.dispatchRow(row));
    }
    await Promise.all(work);
  }

  private async dispatchRow(row: OutboxRow): Promise<void> {
    const loop = await this.loopForBranch(row.branchId, row.channelId);
    if (!loop) return;
    this.outbox.lease(row.branchId, row.effectId, this.deps.now());
    const controller = new AbortController();
    this.aborts.set(this.rowKey(row), {
      controller,
      branchId: row.branchId,
      effectId: row.effectId,
      channelId: row.channelId,
    });
    const executor = this.deps.executorOverride?.(row.descriptor) ?? executorFor(row.descriptor);
    // Storage boundary, read side: effects re-derived from a RELOADED fold
    // carry journaled blob refs for spilled fields (tool args, http request).
    // Executors get fully hydrated descriptors — the single hydration point.
    const descriptor = this.dispatchDescriptor(
      row,
      (await hydrateStoredValueRefs(row.descriptor, {
        getText: (digest) => this.deps.executorDeps.blobstore.getText(digest),
      })) as EffectDescriptor
    );
    let outcome: EffectOutcome | { deferred: true };
    try {
      outcome = await executor.execute({
        descriptor,
        state: loop.state,
        signal: controller.signal,
        deps: this.executorDeps(loop.channelId),
        onEphemeral: (emit) => this.emitEphemeral(loop, emit),
      });
    } catch (err) {
      // EXECUTION failed → retry/backoff path. (applyOutcome errors below are
      // driver-level crashes and must propagate so the reconcile heals them.)
      const message = err instanceof Error ? err.message : String(err);
      if (row.kind === "model_call") {
        const request = row.descriptor.kind === "model_call" ? row.descriptor.request : undefined;
        const failure = classifyModelFailure(
          modelFailureInputFromUnknown(err, {
            provider: request?.provider,
            model: request?.model,
            now: new Date(this.deps.now()).toISOString(),
          })
        );
        if (failure.recoverable && failure.retryAfterMs !== undefined) {
          await this.retryEffect(row, {
            reason: failure.reason,
            retryAfterMs: failure.retryAfterMs,
            code: failure.code,
          });
          this.aborts.delete(this.rowKey(row));
          return;
        }
        if (failure.code === "auth_or_credentials" && request?.provider) {
          await this.suspendOnCredential(
            loop,
            row,
            modelCredentialReconnectOutcome({
              providerId: request.provider,
              modelBaseUrl: request.modelBaseUrl,
              reason: failure.reason,
              failureCode: failure.code,
            })
          );
          this.aborts.delete(this.rowKey(row));
          return;
        }
        if (!failure.recoverable) {
          await this.applyOutcome(row, {
            kind: "model",
            blocks: [],
            stopReason: "error",
            errorReason: message,
            recoverable: false,
            failure,
          });
          this.aborts.delete(this.rowKey(row));
          return;
        }
      }
      const updated = this.outbox.recordFailure(row.branchId, row.effectId, this.deps.now());
      if (updated && updated.attempts >= maxAttempts(updated.kind)) {
        await this.failEffect(updated, { message });
      } else {
        this.scheduleEarliest();
      }
      this.aborts.delete(this.rowKey(row));
      return;
    }
    this.aborts.delete(this.rowKey(row));
    if ((outcome as { deferred?: boolean }).deferred) {
      // Result arrives out-of-band. Keep an earlier wake if the result raced
      // this deferred ack; otherwise redrive later as a backstop.
      this.deferRedrive(row, 60_000);
      return;
    }
    await this.applyOutcome(row, outcome as EffectOutcome);
  }

  private deferRedrive(row: OutboxRow, delayMs: number): void {
    const now = this.deps.now();
    this.deps.sql.exec(
      `UPDATE effect_outbox
       SET lease_expires_at = NULL,
           next_attempt_at = CASE
             WHEN next_attempt_at IS NOT NULL AND next_attempt_at <= ? THEN next_attempt_at
             ELSE ?
           END
       WHERE branch_id = ? AND effect_id = ?`,
      now,
      now + delayMs,
      row.branchId,
      row.effectId
    );
    this.scheduleEarliest();
  }

  private nudgeRedrive(row: OutboxRow): void {
    this.deps.sql.exec(
      `UPDATE effect_outbox
       SET lease_expires_at = NULL,
           next_attempt_at = ?
       WHERE branch_id = ? AND effect_id = ?`,
      this.deps.now(),
      row.branchId,
      row.effectId
    );
    this.requestPump();
  }

  /** Outcome protocol: append outcome events FIRST, then delete the row. */
  async applyOutcome(row: OutboxRow, outcome: EffectOutcome): Promise<void> {
    let loop = await this.loopForBranch(row.branchId, row.channelId);
    if (!loop) return;
    if (outcome.kind === "retry") {
      await this.retryEffect(row, outcome);
      return;
    }
    if (outcome.kind === "model-suspended") {
      await this.suspendOnCredential(loop, row, outcome);
      return;
    }
    let envelopes: LogEnvelope[] | null = null;
    for (let attempt = 0; envelopes === null; attempt += 1) {
      const items = this.transformOutcome(
        loop,
        outcomeEvents(row.descriptor, outcome, {
          now: new Date(this.deps.now()).toISOString(),
        })
      );
      try {
        envelopes = await this.append(loop, items);
      } catch (err) {
        const code = err instanceof Error ? classifyGadAppendError(err) : null;
        if (code === "head-conflict" && attempt < HEAD_CONFLICT_RETRIES) {
          // An unrelated append moved the head; OUR outcome events are new
          // and this completed work must not be discarded (re-deriving the
          // effect would re-execute the model call / re-run a mutating
          // tool). Reload the fold and retry the append against the new
          // head — the items are deterministic, so the retry lands.
          this.loops.delete(loop.channelId);
          loop = await this.loop(loop.channelId);
          continue;
        }
        if (code === "head-conflict") {
          throw err;
        }
        if (code !== null) {
          // id-collision / replay-mismatch (or a head that will not settle):
          // the log already holds a terminal for this effect — a raced
          // duplicate execution. The journaled outcome wins: drop the row,
          // reload from the log, reconcile.
          this.outbox.delete(row.branchId, row.effectId);
          this.loops.delete(loop.channelId);
          const fresh = await this.loop(loop.channelId);
          await this.reconcile(fresh);
          this.requestPump();
          return;
        }
        throw err;
      }
    }
    this.kill("after-outcome-append");
    this.outbox.delete(row.branchId, row.effectId);
    this.kill("after-outbox-delete");
    for (const envelope of envelopes) {
      loop.state = applyEvent(loop.state, envelope);
    }
    this.foldCache.write(loop.state);
    if (
      row.descriptor.kind === "model_call" &&
      row.descriptor.request.turnMetadata?.origin === "heartbeat"
    ) {
      await this.deps.onHeartbeatOutcome?.({
        channelId: loop.channelId,
        descriptor: row.descriptor,
        outcome,
      });
    }
    for (const envelope of envelopes) {
      await this.runStep(loop, { type: "event-appended", envelope }, APPEND_RETRIES);
    }
    // settle() re-fetches the live loop (the cascade may have reloaded) and
    // checks compaction now that a turn may have closed.
    await this.settle(loop.channelId);
  }

  private transformOutcome(loop: LoopInstance, items: AppendItem[]): AppendItem[] {
    let transformed = items;
    for (const policy of this.deps.policiesFor(loop.channelId)) {
      if (policy.transformAppend) {
        transformed = policy.transformAppend({ state: loop.state, items: transformed });
      }
    }
    return transformed;
  }

  private async retryEffect(
    row: OutboxRow,
    outcome: { reason: string; retryAfterMs?: number; code?: string }
  ): Promise<void> {
    const updated = this.outbox.recordFailure(
      row.branchId,
      row.effectId,
      this.deps.now(),
      outcome.retryAfterMs
    );
    if (updated && updated.attempts >= maxAttempts(updated.kind)) {
      await this.failEffect(updated, { message: outcome.reason });
      return;
    }
    this.scheduleEarliest();
  }

  private emitEphemeral(loop: LoopInstance, emit: EphemeralEmit): void {
    let transformed: EphemeralEmit | null = emit;
    for (const policy of this.deps.policiesFor(loop.channelId)) {
      if (!transformed) return;
      if (policy.filterEphemeral) {
        const next = policy.filterEphemeral({
          state: loop.state,
          emit: transformed,
        }) as EphemeralEmit | null | undefined;
        if (next === null) return;
        if (next !== undefined) transformed = next;
      }
    }
    if (transformed) this.deps.onEphemeral(transformed);
  }

  /** TurnSuspensionSignal replacement: journal the wait + the waiting marker. */
  private async suspendOnCredential(
    loop: LoopInstance,
    row: OutboxRow,
    outcome: Extract<EffectOutcome, { kind: "model-suspended" }>
  ): Promise<void> {
    const turn = loop.state.openTurn;
    const credKey = ids.credKey(loop.channelId, outcome.providerId);
    const expiresAt = new Date(this.deps.now() + 10 * 60 * 1000).toISOString();
    const connectSpec = await this.connectSpecFor(outcome.providerId);
    const waitReason = outcome.waitReason ?? "model_credential_required";
    const waitSummary =
      waitReason === "model_credential_reconnect_required"
        ? "Waiting for model credential reconnect"
        : "Waiting for model credential approval";
    const messageId = row.descriptor.kind === "model_call" ? row.descriptor.messageId : undefined;
    const items: AppendItem[] = [
      ...(messageId
        ? [
            {
              envelopeId: ids.messageTerminal(messageId),
              payloadKind: "message.failed" as const,
              payload: {
                protocol: "agentic.trajectory.v1",
                reason: waitReason,
                recoverable: true,
                ...(outcome.failureCode ? { code: outcome.failureCode } : {}),
              },
              causality: { messageId: messageId as never },
              publish: true,
            },
          ]
        : []),
      {
        // Occurrence-unique: a later wait for the SAME credKey (key revoked,
        // wait expired and re-entered) must not collide with the first
        // occurrence's envelope id. lastSeq is deterministic from the fold,
        // so a crash-retry of THIS occurrence replays idempotently.
        envelopeId: ids.systemEvent(credKey, "started", loop.state.lastSeq + 1),
        payloadKind: "system.event",
        payload: {
          protocol: "agentic.trajectory.v1",
          kind: "credential.wait_started",
          // Fold-critical fields mirrored at top level (the fold never
          // hydrates; details may spill to the blobstore when oversized).
          credKey,
          providerId: outcome.providerId,
          expiresAt,
          waitReason,
          ...(outcome.diagnosticReason ? { reason: outcome.diagnosticReason } : {}),
          ...(outcome.failureCode ? { failureCode: outcome.failureCode } : {}),
          ...(messageId ? { messageId } : {}),
          ...(outcome.modelBaseUrl ? { modelBaseUrl: outcome.modelBaseUrl } : {}),
          details: {
            kind: "credential.wait_started",
            credKey,
            providerId: outcome.providerId,
            waitReason,
            ...(outcome.diagnosticReason ? { reason: outcome.diagnosticReason } : {}),
            ...(outcome.failureCode ? { failureCode: outcome.failureCode } : {}),
            ...(messageId ? { messageId } : {}),
            ...(outcome.modelBaseUrl ? { modelBaseUrl: outcome.modelBaseUrl } : {}),
            connectSpec,
            expiresAt,
            ...(turn ? { turnId: turn.turnId } : {}),
          },
        },
        causality: {
          ...(turn ? { turnId: turn.turnId } : {}),
          ...(messageId ? { messageId: messageId as never } : {}),
        },
        publish: true,
      },
      ...(turn
        ? [
            {
              envelopeId: ids.turnWaiting(turn.turnId, turn.waitingCount),
              payloadKind: "turn.waiting" as const,
              payload: {
                protocol: "agentic.trajectory.v1",
                reason: waitReason,
                summary: waitSummary,
              },
              causality: { turnId: turn.turnId },
              publish: true,
            },
          ]
        : []),
    ];
    let envelopes: LogEnvelope[];
    try {
      envelopes = await this.append(loop, items);
    } catch (err) {
      if (err instanceof Error && isStaleStateAppendError(err)) {
        // Stale fold (another writer advanced the head, or this suspension
        // raced a duplicate). The log is truth: drop the row, reload, and
        // reconcile — a still-missing credential re-derives the wait with
        // fresh occurrence ids instead of wedging the leased row forever.
        this.outbox.delete(row.branchId, row.effectId);
        this.loops.delete(loop.channelId);
        const fresh = await this.loop(loop.channelId);
        await this.reconcile(fresh);
        this.requestPump();
        return;
      }
      throw err;
    }
    this.outbox.delete(row.branchId, row.effectId);
    for (const envelope of envelopes) {
      loop.state = applyEvent(loop.state, envelope);
    }
    this.foldCache.write(loop.state);
    await this.reconcile(loop);
    this.requestPump();
  }

  /** Snapshot of the provider connect spec (overridable by the vessel). */
  connectSpecProvider: (providerId: string) => Promise<Record<string, unknown>> = async (
    providerId
  ) => ({ providerId });

  private connectSpecFor(providerId: string): Promise<Record<string, unknown>> {
    return this.connectSpecProvider(providerId);
  }

  /** Cross-path delivery target (channel terminals, http callbacks,
   *  credential resolutions). Duplicate delivery is harmless: the terminal
   *  envelope id replays in GAD and the row is already gone. */
  async deliverEffectOutcome(
    effectId: string,
    outcome: EffectOutcome,
    address: OutcomeAddress = {}
  ): Promise<void> {
    const row = this.outcomeRow(effectId, address);
    if (!row) return; // already settled — deterministic ids make this a no-op
    await this.applyOutcome(row, outcome);
  }

  async deliverDeferredResult(
    requestId: string,
    result: unknown,
    isError: boolean,
    address: OutcomeAddress = {}
  ): Promise<void> {
    const row = this.outcomeRow(requestId, address);
    if (!row) return;
    if (row.kind === "model_call") {
      if (isError) {
        await this.failEffect(row, { message: deferredErrorMessage(result) });
        return;
      }
      this.nudgeRedrive(row);
      return;
    }
    if (row.kind === "credential_wait") {
      if (isError) {
        await this.failEffect(row, { message: deferredErrorMessage(result) });
        return;
      }
      await this.applyOutcome(row, { kind: "credential", resolved: true });
      return;
    }
    await this.applyOutcome(row, {
      kind: "tool",
      result,
      isError,
      ...(isError ? { reason: deferredErrorMessage(result) } : {}),
    });
  }

  async failEffect(row: OutboxRow, error: { message: string }): Promise<void> {
    const loop = await this.loopForBranch(row.branchId, row.channelId);
    if (!loop) return;
    await this.handleIncoming(loop.channelId, {
      type: "effect-failed",
      effectId: row.effectId,
      kind: row.kind,
      error,
      attempts: row.attempts,
    });
    this.outbox.delete(row.branchId, row.effectId);
  }

  /** Abort in-flight executors for a channel (interrupt command wiring). */
  abortChannel(channelId: string): void {
    for (const entry of this.aborts.values()) {
      if (entry.channelId === channelId) entry.controller.abort();
    }
  }

  async alarm(): Promise<void> {
    await this.processScheduledModelResumes();
    await this.pump();
  }

  async scheduleResumeAtReset(
    channelId: string,
    input: { messageId?: unknown; resetAt?: unknown }
  ): Promise<{ scheduled: boolean; wakeAt?: string; reason?: string }> {
    const messageId = typeof input.messageId === "string" ? input.messageId : "";
    const resetAt = typeof input.resetAt === "string" ? input.resetAt : "";
    const resetAtMs = Date.parse(resetAt);
    if (!messageId) return { scheduled: false, reason: "messageId is required" };
    if (!Number.isFinite(resetAtMs)) {
      return { scheduled: false, reason: "resetAt must be an ISO timestamp" };
    }
    const loop = await this.loop(channelId);
    if (!loop.state.openTurn) return { scheduled: false, reason: "no open turn to resume" };
    if (!messageId.startsWith(`m:${loop.state.openTurn.turnId}:`)) {
      return { scheduled: false, reason: "message is not part of the open turn" };
    }
    if (loop.state.inFlightModelCall) {
      return { scheduled: false, reason: "a model call is already running" };
    }
    const wakeAtMs = Math.max(resetAtMs, this.deps.now() + 50);
    this.deps.sql.exec(
      `INSERT OR REPLACE INTO scheduled_model_resumes (
         channel_id, message_id, reset_at_ms, created_at
       ) VALUES (?, ?, ?, ?)`,
      channelId,
      messageId,
      wakeAtMs,
      this.deps.now()
    );
    this.scheduleEarliest();
    return { scheduled: true, wakeAt: new Date(wakeAtMs).toISOString() };
  }

  private pumping = false;
  private repump = false;

  /** Ask for a pump. Hot path: run it NOW in a background continuation of
   *  the current execution (no inbound RPC is blocked — callers already
   *  journaled and returned). Durable backstop: arm the alarm so the pump
   *  still happens if this isolate is evicted first — alarm delivery is a
   *  server round-trip, far too slow to be the primary dispatch path. */
  private requestPump(): void {
    if (this.pumping) {
      this.repump = true;
      return;
    }
    this.deps.scheduleAlarm(this.deps.now() + 1);
    // Only when the host provides a background continuation (production DO
    // waitUntil). Without it (tests), the alarm is the sole pump trigger —
    // deterministic for crash-injection harnesses.
    this.deps.runBackground?.(() => this.pump().catch(() => {}));
  }

  /** The single effect executor. Drains immediately-due work (outcomes make
   *  new work due, hence the loop), then arms the alarm for the earliest
   *  future deadline (retry backoff, credential expiry, lease recovery). */
  private async pump(): Promise<void> {
    if (this.pumping) {
      this.repump = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.repump = false;
        for (const loop of this.loops.values()) {
          await this.reconcile(loop);
        }
        await this.dispatchDue();
      } while (this.repump);
    } finally {
      this.pumping = false;
      this.scheduleEarliest();
    }
  }

  private earliestScheduledModelResumeAt(): number | null {
    const row = this.deps.sql
      .exec(`SELECT MIN(reset_at_ms) AS due FROM scheduled_model_resumes`)
      .toArray()[0];
    const value = row?.["due"];
    return typeof value === "number" ? value : null;
  }

  private scheduledModelResumeRowsDue(now: number): ScheduledModelResumeRow[] {
    return (
      this.deps.sql
        .exec(
          `SELECT * FROM scheduled_model_resumes
           WHERE reset_at_ms <= ?
           ORDER BY reset_at_ms, created_at`,
          now
        )
        .toArray() as Record<string, unknown>[]
    ).map(mapScheduledModelResumeRow);
  }

  private deleteScheduledModelResume(row: ScheduledModelResumeRow): void {
    this.deps.sql.exec(
      `DELETE FROM scheduled_model_resumes WHERE channel_id = ? AND message_id = ?`,
      row.channelId,
      row.messageId
    );
  }

  private async processScheduledModelResumes(): Promise<void> {
    const rows = this.scheduledModelResumeRowsDue(this.deps.now());
    for (const row of rows) {
      try {
        await this.handleIncoming(row.channelId, {
          type: "command",
          command: {
            kind: "resumeAfterReset",
            messageId: row.messageId,
            resetAt: new Date(row.resetAtMs).toISOString(),
          },
        });
        this.deleteScheduledModelResume(row);
      } catch (err) {
        console.warn(
          "[agent-loop-driver] scheduled model resume failed:",
          err instanceof Error ? err.message : String(err)
        );
      }
    }
  }

  private async loopForBranch(branchId: string, channelId: string): Promise<LoopInstance | null> {
    try {
      void branchId;
      return await this.loop(channelId);
    } catch {
      return null;
    }
  }
}
