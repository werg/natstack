/**
 * Method-call transport (WS2 §5) — `pending_calls` as a DECLARED CACHE.
 *
 * Authority: a call is pending ⟺ its `invocation.started` has no terminal in
 * the durable log. The SQLite rows exist only for dispatch state and deadline
 * alarms; `derivePendingCalls(fold(log))` reconstructs them at any time
 * (cache amnesia, P3).
 *
 * The settle pipeline appends the durable terminal FIRST (deterministic
 * envelopeId `terminal:{transportCallId}`), deletes the row second, and
 * broadcasts last — the old lost-terminal crash window (row deleted, append
 * never ran) is structurally impossible.
 */

import {
  AGENTIC_EVENT_PAYLOAD_KIND,
  AGENTIC_PROTOCOL_VERSION,
  type AgenticEvent,
  type AppendIdempotency,
  type InvocationOutcome,
  type LogEnvelope,
  type ParticipantRef,
} from "@workspace/agentic-protocol";
import type { ChannelEvent } from "@workspace/harness";
import type { SqlStorage } from "@workspace/runtime/worker";
import type { ChannelCallEventBuilders } from "@workspace/channel-policies";
import { participantIsAgentVessel, type StoredAttachment } from "./types.js";
import type { ChannelLog } from "./log-store.js";

export interface PendingCallRow {
  transportCallId: string;
  invocationId: string;
  turnId?: string;
  callerId: string;
  targetId: string;
  method: string;
  args?: unknown;
  createdAt: number;
  deadlineAt?: number;
}

export type SubmitterCallResolution =
  | { kind: "pending"; pending: PendingCallRow }
  | { kind: "terminal"; eventId: number }
  | { kind: "missing" };

const TERMINAL_KINDS = new Set([
  "invocation.completed",
  "invocation.failed",
  "invocation.cancelled",
  "invocation.abandoned",
]);

/** Pure fold: pending ⟺ channel-transport invocation.started without a
 *  terminal carrying the same transportCallId (WS2 §5.4). */
export function derivePendingCalls(envelopes: LogEnvelope[]): PendingCallRow[] {
  const pending = new Map<string, PendingCallRow>();
  for (const envelope of envelopes) {
    if (envelope.payloadKind !== AGENTIC_EVENT_PAYLOAD_KIND) continue;
    const event = envelope.payload as AgenticEvent | null;
    if (!event || typeof event !== "object") continue;
    const kind = (event as { kind?: string }).kind ?? "";
    const causality = ((event as { causality?: Record<string, unknown> }).causality ??
      {}) as Record<string, unknown>;
    const transportCallId =
      typeof causality["transportCallId"] === "string"
        ? (causality["transportCallId"] as string)
        : null;
    if (!transportCallId) continue;
    if (kind === "invocation.started") {
      const payload = ((event as { payload?: Record<string, unknown> }).payload ??
        {}) as Record<string, unknown>;
      const transport = (payload["transport"] ?? {}) as Record<string, unknown>;
      if (transport["kind"] !== "channel") continue;
      const actor = (event as { actor?: { id?: string; participantId?: string } }).actor ?? {};
      const target = (transport["target"] ?? {}) as { id?: string; participantId?: string };
      const invocationId =
        typeof causality["invocationId"] === "string"
          ? (causality["invocationId"] as string)
          : transportCallId;
      pending.set(transportCallId, {
        transportCallId,
        invocationId,
        ...(typeof (event as { turnId?: string }).turnId === "string"
          ? { turnId: (event as { turnId?: string }).turnId }
          : {}),
        callerId: actor.participantId ?? actor.id ?? "unknown",
        targetId: target.participantId ?? target.id ?? "unknown",
        method: typeof payload["name"] === "string" ? (payload["name"] as string) : "unknown",
        ...(payload["request"] !== undefined ? { args: payload["request"] } : {}),
        createdAt: Date.parse(envelope.appendedAt),
        ...(typeof transport["deadlineAt"] === "number"
          ? { deadlineAt: transport["deadlineAt"] as number }
          : {}),
      });
      continue;
    }
    if (TERMINAL_KINDS.has(kind)) pending.delete(transportCallId);
  }
  return [...pending.values()];
}

export interface CallTransportDeps {
  sql: SqlStorage;
  objectKey: string;
  log: ChannelLog;
  builders(): ChannelCallEventBuilders;
  /** Append through the DO's policy pipeline (annotate + append + fold). */
  appendDurable(input: {
    type: string;
    payload: unknown;
    senderId: string;
    senderMetadata?: Record<string, unknown>;
    messageId?: string;
    idempotency?: AppendIdempotency;
    attachments?: StoredAttachment[];
  }): Promise<ChannelEvent>;
  broadcastLive(event: ChannelEvent, senderId: string, ref?: number): void;
  emitSignal(participantId: string, event: ChannelEvent): void;
  participantRef(participantId: string): ParticipantRef;
  getSenderMetadata(participantId: string): Record<string, unknown> | undefined;
  participantTransport(participantId: string): "rpc" | "do" | null;
  rpcCall(targetId: string, method: string, args: unknown[]): Promise<unknown>;
  waitUntil(promise: Promise<unknown>): void;
  scheduleNextAlarm(): void;
  getStateValue(key: string): string | null;
  setStateValue(key: string, value: string): void;
}

export class CallTransport {
  constructor(private readonly deps: CallTransportDeps) {}

  // ── pending_calls cache rows ──────────────────────────────────────────────

  private insertRow(row: PendingCallRow): void {
    // A re-call with the same transportCallId (nudge redrive) must NOT reset
    // the expiry clock — keep the ORIGINAL created_at so timeouts fire from
    // first issuance, not from the latest retry.
    const existing = this.peek(row.transportCallId);
    if (existing) row = { ...row, createdAt: existing.createdAt };
    this.deps.sql.exec(
      `INSERT OR REPLACE INTO pending_calls (
         transport_call_id, invocation_id, turn_id, caller_id, target_id,
         method, args, created_at, deadline_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.transportCallId,
      row.invocationId,
      row.turnId ?? null,
      row.callerId,
      row.targetId,
      row.method,
      row.args !== undefined ? JSON.stringify(row.args) : null,
      row.createdAt,
      row.deadlineAt ?? null
    );
  }

  peek(transportCallId: string): PendingCallRow | null {
    const rows = this.deps.sql
      .exec(`SELECT * FROM pending_calls WHERE transport_call_id = ?`, transportCallId)
      .toArray();
    if (rows.length === 0) return null;
    return this.rowFrom(rows[0] as Record<string, unknown>);
  }

  pendingTarget(transportCallId: string): string | null {
    return this.peek(transportCallId)?.targetId ?? null;
  }

  pendingFor(targetId: string): PendingCallRow[] {
    return (
      this.deps.sql
        .exec(`SELECT * FROM pending_calls WHERE target_id = ?`, targetId)
        .toArray() as Record<string, unknown>[]
    ).map((row) => this.rowFrom(row));
  }

  private rowFrom(row: Record<string, unknown>): PendingCallRow {
    let args: unknown;
    const raw = row["args"];
    if (typeof raw === "string") {
      try {
        args = JSON.parse(raw);
      } catch {
        args = undefined;
      }
    }
    return {
      transportCallId: String(row["transport_call_id"]),
      invocationId: String(row["invocation_id"]),
      ...(row["turn_id"] ? { turnId: String(row["turn_id"]) } : {}),
      callerId: String(row["caller_id"]),
      targetId: String(row["target_id"]),
      method: String(row["method"]),
      ...(args !== undefined ? { args } : {}),
      createdAt: Number(row["created_at"] ?? 0),
      ...(row["deadline_at"] != null ? { deadlineAt: Number(row["deadline_at"]) } : {}),
    };
  }

  private deleteRow(transportCallId: string): void {
    this.deps.sql.exec(`DELETE FROM pending_calls WHERE transport_call_id = ?`, transportCallId);
  }

  private pendingFromStartedEvent(event: ChannelEvent, fallback: PendingCallRow): PendingCallRow {
    const agentic = event.payload as AgenticEvent | null;
    if (!agentic || typeof agentic !== "object" || agentic.kind !== "invocation.started") {
      return fallback;
    }
    const causality = (agentic.causality ?? {}) as Record<string, unknown>;
    const payload = (agentic.payload ?? {}) as Record<string, unknown>;
    const transport = (payload["transport"] ?? {}) as Record<string, unknown>;
    const actor = (agentic.actor ?? {}) as { id?: string; participantId?: string };
    const target = (transport["target"] ?? {}) as { id?: string; participantId?: string };
    const createdAt =
      typeof agentic.createdAt === "string" ? Date.parse(agentic.createdAt) : Number.NaN;

    return {
      transportCallId:
        typeof causality["transportCallId"] === "string"
          ? (causality["transportCallId"] as string)
          : fallback.transportCallId,
      invocationId:
        typeof causality["invocationId"] === "string"
          ? (causality["invocationId"] as string)
          : fallback.invocationId,
      ...(typeof agentic.turnId === "string" ? { turnId: agentic.turnId } : {}),
      callerId: actor.participantId ?? actor.id ?? fallback.callerId,
      targetId: target.participantId ?? target.id ?? fallback.targetId,
      method: typeof payload["name"] === "string" ? (payload["name"] as string) : fallback.method,
      ...(payload["request"] !== undefined ? { args: payload["request"] } : {}),
      createdAt: Number.isFinite(createdAt) ? createdAt : fallback.createdAt,
      ...(typeof transport["deadlineAt"] === "number"
        ? { deadlineAt: transport["deadlineAt"] as number }
        : fallback.deadlineAt != null
          ? { deadlineAt: fallback.deadlineAt }
          : {}),
    };
  }

  // ── callMethod — journal before dispatch (P2, WS2 §5.2) ──────────────────

  async callMethod(
    callerPid: string,
    targetPid: string,
    callId: string,
    method: string,
    args: unknown,
    opts?: { invocationId?: string; transportCallId?: string; turnId?: string; timeoutMs?: number }
  ): Promise<void> {
    const transportCallId = opts?.transportCallId ?? callId;
    const invocationId = opts?.invocationId ?? callId;
    const turnId = opts?.turnId;
    const deadlineAt =
      opts?.timeoutMs && opts.timeoutMs > 0 ? Date.now() + opts.timeoutMs : undefined;
    const createdAt = new Date().toISOString();

    // Idempotent re-call: when the caller redrives a call whose terminal is
    // already durable (it missed the outcome broadcast), do NOT resurrect a
    // pending row — that wedges the call forever (the target dedups
    // redeliveries; reconcile skips because the head didn't move). Re-deliver
    // the journaled terminal instead so the caller can settle.
    const existingTerminal = await this.deps.log.getEventByEnvelopeId(
      `terminal:${transportCallId}`
    );
    if (existingTerminal) {
      this.deleteRow(transportCallId);
      console.log(
        `[Channel] callMethod re-drive for settled call ${transportCallId}: ` +
          `re-broadcasting durable terminal (seq ${existingTerminal.id})`
      );
      this.deps.broadcastLive(existingTerminal, existingTerminal.senderId ?? callerPid);
      return;
    }

    // 1. APPEND the durable started intention (deterministic envelopeId =
    //    invocationId). Re-drives of a still-pending call carry volatile
    //    createdAt/request fields; the journaled first start wins by id.
    const payload = this.deps.builders().started({
      channelId: this.deps.objectKey,
      caller: this.deps.participantRef(callerPid),
      target: this.deps.participantRef(targetPid),
      invocationId,
      transportCallId,
      ...(turnId ? { turnId } : {}),
      method,
      args,
      ...(deadlineAt != null ? { deadlineAt } : {}),
      createdAt,
    });
    const callEvent = await this.deps.appendDurable({
      type: AGENTIC_EVENT_PAYLOAD_KIND,
      payload,
      senderId: callerPid,
      senderMetadata: this.deps.getSenderMetadata(callerPid),
      messageId: invocationId,
      idempotency: "idempotent-by-id",
    });
    const fallbackRow: PendingCallRow = {
      transportCallId,
      invocationId,
      ...(turnId ? { turnId } : {}),
      callerId: callerPid,
      targetId: targetPid,
      method,
      ...(args !== undefined ? { args } : {}),
      createdAt: Date.now(),
      ...(deadlineAt != null ? { deadlineAt } : {}),
    };
    const pendingRow = this.pendingFromStartedEvent(callEvent, fallbackRow);

    const terminalAfterStart = await this.deps.log.getEventByEnvelopeId(
      `terminal:${pendingRow.transportCallId}`
    );
    if (terminalAfterStart) {
      this.deleteRow(pendingRow.transportCallId);
      this.deps.broadcastLive(terminalAfterStart, terminalAfterStart.senderId ?? callerPid);
      return;
    }

    // 2. cache row, 3. alarm, 4. broadcast
    this.insertRow(pendingRow);
    this.recordObservedHead(callEvent.id);
    this.deps.scheduleNextAlarm();
    this.deps.broadcastLive(callEvent, callerPid);

    // 5. dispatch
    const transport = this.deps.participantTransport(pendingRow.targetId);
    if (transport === null) {
      await this.settleCall(
        pendingRow.transportCallId,
        { error: `Target ${pendingRow.targetId} not found` },
        true
      );
      return;
    }
    // A "do" target gets the synchronous `onMethodCall` dispatch ONLY if it's an agent vessel — it
    // implements `onMethodCall` AND opted into structured delivery (`receivesChannelEnvelopes`, set by
    // SubscriptionManager). An RPC-style connectionless DO client (the eval's `connectViaRpc` /
    // HeadlessSession) has NO `onMethodCall` handler: its participant id is just the host DO's id, so
    // `transport` is "do" purely by id-shape — but it settles method calls the RPC way, via the
    // broadcast `started` (delivered as a `channel:message` to every participant, broadcast.ts) +
    // `submitMethodResult`. Routing it through `deliverDoMethodCall` dispatches to a missing handler and
    // never settles the call (the redelivery echo). Same discriminator broadcast.ts uses for the
    // structured envelope, so the two dispatch decisions stay aligned.
    const isAgentVesselTarget = participantIsAgentVessel(
      this.deps.getSenderMetadata(pendingRow.targetId)
    );
    if (transport === "do" && isAgentVesselTarget) {
      this.deps.waitUntil(
        this.deliverDoMethodCall({
          targetPid: pendingRow.targetId,
          transportCallId: pendingRow.transportCallId,
          invocationId: pendingRow.invocationId,
          turnId: pendingRow.turnId,
          method: pendingRow.method,
          args: pendingRow.args,
        })
      );
    }
    // RPC participants AND RPC-style DO clients receive the durable invocation start through the log
    // broadcast and reply via submitMethodResult.
  }

  private async deliverDoMethodCall(input: {
    targetPid: string;
    transportCallId: string;
    invocationId: string;
    turnId?: string;
    method: string;
    args: unknown;
  }): Promise<void> {
    try {
      const result = await this.deps.rpcCall(input.targetPid, "onMethodCall", [
        this.deps.objectKey,
        input.transportCallId,
        input.method,
        input.args,
        { invocationId: input.invocationId, turnId: input.turnId },
      ]);
      const res = result as { result: unknown; isError?: boolean };
      await this.settleCall(input.transportCallId, res.result, !!res.isError);
    } catch (err) {
      await this.settleCall(
        input.transportCallId,
        err instanceof Error ? err.message : String(err),
        true
      );
    }
  }

  // ── settleCall — terminal ordering fixed (WS2 §5.3, THE bug fix) ─────────

  async settleCall(
    transportCallId: string,
    result: unknown,
    isError: boolean,
    terminalOutcome?: InvocationOutcome,
    terminalReasonCode?: string,
    opts?: {
      attachments?: StoredAttachment[];
      /** Pre-built terminal event (cancel/timeout paths use the `cancelled`
       *  builder with actor system). */
      eventOverride?: AgenticEvent;
      senderId?: string;
    }
  ): Promise<number | undefined> {
    // 1. READ, do not delete. pending_calls is a declared cache, so a submit
    // racing with replay/resubscribe may arrive after the durable start is
    // visible but before the row exists locally. Reconcile from the log before
    // deciding the result is unknown.
    let pending = this.peek(transportCallId);
    if (!pending) {
      const existingTerminal = await this.deps.log.getEventByEnvelopeId(
        `terminal:${transportCallId}`
      );
      if (existingTerminal) return existingTerminal.id;
      await this.reconcilePendingCalls(true);
      pending = this.peek(transportCallId);
    }
    if (!pending) {
      const existingTerminal = await this.deps.log.getEventByEnvelopeId(
        `terminal:${transportCallId}`
      );
      if (existingTerminal) return existingTerminal.id;
      console.log(
        `[Channel] method result without a live pending call (already terminal or unknown): ` +
          `channel=${this.deps.objectKey} transportCallId=${transportCallId} isError=${isError}`
      );
      return undefined;
    }

    // 2. Root the terminal (synthetic started if the canonical one is absent).
    await this.ensureMethodRoot(pending);

    // 3. APPEND the terminal FIRST, deterministic id. A duplicate settle after
    //    a crash-between-append-and-delete finds the terminal already durable
    //    and skips straight to consuming the row.
    const terminalEnvelopeId = `terminal:${transportCallId}`;
    let event = await this.deps.log.getEventByEnvelopeId(terminalEnvelopeId);
    if (!event) {
      const payload =
        opts?.eventOverride ??
        this.deps.builders().terminal({
          descriptor: {
            channelId: this.deps.objectKey,
            caller: this.deps.participantRef(pending.callerId),
            invocationId: pending.invocationId,
            transportCallId: pending.transportCallId,
            ...(pending.turnId ? { turnId: pending.turnId } : {}),
          },
          result,
          isError,
          ...(terminalOutcome ? { terminalOutcome } : {}),
          ...(terminalReasonCode ? { terminalReasonCode } : {}),
          createdAt: new Date().toISOString(),
        });
      event = await this.deps.appendDurable({
        type: AGENTIC_EVENT_PAYLOAD_KIND,
        payload,
        senderId: opts?.senderId ?? pending.callerId,
        messageId: terminalEnvelopeId,
        idempotency: "idempotent-by-id",
        ...(opts?.attachments ? { attachments: opts.attachments } : {}),
      });
    }

    // 4. consume the cache row AFTER the durable append; 5. alarm; 6. broadcast.
    this.deleteRow(transportCallId);
    this.recordObservedHead(event.id);
    this.deps.scheduleNextAlarm();
    const sender = opts?.senderId ?? pending.callerId;
    const callerPresent =
      opts?.senderId != null || this.deps.participantTransport(pending.callerId) !== null;
    if (callerPresent) {
      this.deps.broadcastLive(event, sender);
    }
    return event.id;
  }

  /** Before any output/terminal append: if no envelope with the invocation id
   *  exists in the log, append a synthetic started so terminals never orphan. */
  private async ensureMethodRoot(pending: PendingCallRow): Promise<void> {
    if (await this.deps.log.hasEnvelope(pending.invocationId)) return;
    const payload = this.deps.builders().started({
      channelId: this.deps.objectKey,
      caller: this.deps.participantRef(pending.callerId),
      target: this.deps.participantRef(pending.targetId ?? "unknown"),
      invocationId: pending.invocationId,
      transportCallId: pending.transportCallId,
      ...(pending.turnId ? { turnId: pending.turnId } : {}),
      method: pending.method ?? "unknown",
      args: pending.args,
      createdAt: new Date().toISOString(),
    });
    await this.deps.appendDurable({
      type: AGENTIC_EVENT_PAYLOAD_KIND,
      payload,
      senderId: pending.callerId,
      senderMetadata: this.deps.getSenderMetadata(pending.callerId),
      messageId: pending.invocationId,
    });
  }

  // ── submit / progress ─────────────────────────────────────────────────────

  async resolveSubmitterForCall(
    participantId: string,
    transportCallId: string,
    operation: "submitMethodResult" | "submitMethodProgress"
  ): Promise<SubmitterCallResolution> {
    let pending = this.peek(transportCallId);
    if (!pending) {
      const existingTerminal = await this.deps.log.getEventByEnvelopeId(
        `terminal:${transportCallId}`
      );
      if (existingTerminal) return { kind: "terminal", eventId: existingTerminal.id };

      await this.reconcilePendingCalls(true);
      pending = this.peek(transportCallId);
    }

    if (!pending) {
      const existingTerminal = await this.deps.log.getEventByEnvelopeId(
        `terminal:${transportCallId}`
      );
      if (existingTerminal) return { kind: "terminal", eventId: existingTerminal.id };
      return { kind: "missing" };
    }

    if (pending.targetId !== participantId) {
      throw new Error(
        `${operation} rejected: participant ${participantId} is not target ${pending.targetId} ` +
          `for method call ${transportCallId}`
      );
    }
    return { kind: "pending", pending };
  }

  async submitMethodProgress(
    transportCallId: string,
    content: unknown,
    opts?: { attachments?: StoredAttachment[] }
  ): Promise<void> {
    const pending = this.peek(transportCallId);
    if (!pending) return;
    await this.ensureMethodRoot(pending);
    const payload = this.deps.builders().output({
      descriptor: {
        channelId: this.deps.objectKey,
        caller: this.deps.participantRef(pending.callerId),
        invocationId: pending.invocationId,
        transportCallId: pending.transportCallId,
        ...(pending.turnId ? { turnId: pending.turnId } : {}),
      },
      output: content,
      createdAt: new Date().toISOString(),
    });
    const event = await this.deps.appendDurable({
      type: AGENTIC_EVENT_PAYLOAD_KIND,
      payload,
      senderId: pending.callerId,
      ...(opts?.attachments ? { attachments: opts.attachments } : {}),
    });
    this.recordObservedHead(event.id);
    this.deps.broadcastLive(event, pending.callerId);
  }

  // ── cancel / timeout / abandon ────────────────────────────────────────────

  async cancelMethodCall(callId: string, reason = "cancelled"): Promise<PendingCallRow | null> {
    let pending = this.peek(callId);
    if (!pending) {
      // Cache-cold: the row may live in the durable log but not yet in the
      // SQLite cache (post-eviction / reload). Reconcile then peek again before
      // concluding the call is gone — otherwise a legitimate cancel/timeout
      // silently no-ops and the call hangs (mirrors settleCall / resolveSubmitter).
      const existingTerminal = await this.deps.log.getEventByEnvelopeId(`terminal:${callId}`);
      if (existingTerminal) {
        this.deps.scheduleNextAlarm();
        return null;
      }
      await this.reconcilePendingCalls(true);
      pending = this.peek(callId);
    }
    if (!pending) {
      this.deps.scheduleNextAlarm();
      return null;
    }
    const event = this.deps.builders().cancelled({
      descriptor: {
        channelId: this.deps.objectKey,
        caller: this.deps.participantRef(pending.callerId),
        invocationId: pending.invocationId,
        transportCallId: pending.transportCallId,
        ...(pending.turnId ? { turnId: pending.turnId } : {}),
      },
      actor: this.deps.participantRef("system"),
      reason,
      createdAt: new Date().toISOString(),
    });
    await this.settleCall(callId, reason, true, "cancelled", "cancelled", {
      eventOverride: event,
      senderId: "system",
    });
    return pending;
  }

  /** Abandoned terminals for every pending call targeting a leaver —
   *  peek-then-settle per call, never bulk-delete-then-append. */
  async failPendingCallsTargeting(
    targetId: string,
    reason: "graceful" | "disconnect" | "replaced"
  ): Promise<number> {
    const rows = this.pendingFor(targetId);
    if (rows.length === 0) return 0;
    const errorMessage =
      reason === "graceful"
        ? `Target ${targetId} left the channel before the call completed`
        : reason === "disconnect"
          ? `Target ${targetId} disconnected from the channel before the call completed`
          : `Target ${targetId} was replaced by a new session before the call completed`;
    for (const row of rows) {
      try {
        await this.settleCall(row.transportCallId, { error: errorMessage }, true, "abandoned", reason);
      } catch (err) {
        console.warn(
          `[Channel] failPendingCallsTargeting: settle failed for ${row.transportCallId}:`,
          err
        );
      }
    }
    console.log(
      `[Channel] Cancelled ${rows.length} pending call(s) targeting ${targetId} (${reason})`
    );
    return rows.length;
  }

  /** Re-emit still-pending calls targeting a (re)subscribed participant as
   *  signals (at-least-once delivery over the call lifetime). */
  redeliverPendingCallsTo(participantId: string): void {
    const rows = this.pendingFor(participantId);
    if (rows.length === 0) return;
    for (const row of rows) {
      const payload = this.deps.builders().started({
        channelId: this.deps.objectKey,
        caller: this.deps.participantRef(row.callerId),
        target: this.deps.participantRef(participantId),
        invocationId: row.invocationId,
        transportCallId: row.transportCallId,
        ...(row.turnId ? { turnId: row.turnId } : {}),
        method: row.method,
        args: row.args,
        ...(row.deadlineAt != null ? { deadlineAt: row.deadlineAt } : {}),
        createdAt: new Date().toISOString(),
      });
      const event: ChannelEvent = {
        id: 0,
        messageId: row.invocationId,
        type: AGENTIC_EVENT_PAYLOAD_KIND,
        payload,
        senderId: row.callerId,
        senderMetadata: this.deps.getSenderMetadata(row.callerId),
        ts: Date.now(),
      };
      this.deps.emitSignal(participantId, event);
    }
    console.log(`[Channel] Redelivered ${rows.length} pending call(s) to ${participantId}`);
  }

  async timeoutExpiredPendingCalls(
    onTimeout: (pending: PendingCallRow, reason: string) => Promise<void>
  ): Promise<void> {
    const now = Date.now();
    const rows = this.deps.sql
      .exec(
        `SELECT transport_call_id FROM pending_calls WHERE deadline_at IS NOT NULL AND deadline_at <= ?`,
        now
      )
      .toArray();
    for (const row of rows) {
      const transportCallId = row["transport_call_id"] as string;
      const pending = await this.cancelMethodCall(transportCallId, "Channel method deadline expired");
      if (pending) await onTimeout(pending, "method call deadline expired");
    }
  }

  nextCallDeadlineAt(): number | null {
    const deadline = this.deps.sql
      .exec(`SELECT MIN(deadline_at) AS deadline FROM pending_calls WHERE deadline_at IS NOT NULL`)
      .toArray()[0]?.["deadline"];
    return typeof deadline === "number" ? deadline : null;
  }

  // ── reconcile — the convergence sweep (WS2 §5.4) ─────────────────────────

  private recordObservedHead(seq: number): void {
    const current = Number(this.deps.getStateValue("calls_reconciled_through") ?? 0);
    if (seq > current) this.deps.setStateValue("calls_reconciled_through", String(seq));
  }

  async reconcilePendingCalls(force = false): Promise<{ inserted: number; deleted: number }> {
    const headSeq = await this.deps.log.headSeq();
    if (!force) {
      const through = Number(this.deps.getStateValue("calls_reconciled_through") ?? -1);
      if (through === headSeq) return { inserted: 0, deleted: 0 };
    }
    const envelopes: LogEnvelope[] = [];
    let afterSeq = 0;
    for (;;) {
      const page = await this.deps.log.read({
        afterSeq,
        limit: 500,
        payloadKind: AGENTIC_EVENT_PAYLOAD_KIND,
      });
      if (page.length === 0) break;
      envelopes.push(...page);
      afterSeq = page[page.length - 1]!.seq;
      if (page.length < 500) break;
    }
    const derived = derivePendingCalls(envelopes);
    const derivedByKey = new Map(derived.map((row) => [row.transportCallId, row]));
    const existing = (
      this.deps.sql.exec(`SELECT * FROM pending_calls`).toArray() as Record<string, unknown>[]
    ).map((row) => this.rowFrom(row));
    let inserted = 0;
    let deleted = 0;
    for (const row of existing) {
      if (!derivedByKey.has(row.transportCallId)) {
        this.deleteRow(row.transportCallId);
        deleted += 1;
      } else {
        derivedByKey.delete(row.transportCallId);
      }
    }
    for (const row of derivedByKey.values()) {
      this.insertRow(row);
      inserted += 1;
    }
    this.deps.setStateValue("calls_reconciled_through", String(headSeq));
    if (inserted || deleted) this.deps.scheduleNextAlarm();
    return { inserted, deleted };
  }
}
