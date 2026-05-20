/**
 * PubSubChannel — Durable Object for pub/sub messaging.
 *
 * Each channel is a single DO instance. All participants (panels, DOs, workers)
 * interact via RPC calls. Broadcasting uses this.rpc.emit() to push events
 * to subscribers.
 *
 * State: messages, participants, pending_calls in local SQLite.
 */

/// <reference path="../workerd.d.ts" />
import { DurableObjectBase, type DurableObjectContext } from "@workspace/runtime/worker";
import type { ChannelEvent } from "@natstack/harness/types";
import { aggregateReplayEvents } from "@workspace/pubsub";
import { PARTICIPANT_SESSION_METADATA_KEY } from "@workspace/pubsub/internal-constants";
import type {
  SendOpts,
  SubscribeResult,
  ChannelConfig,
  PresencePayload,
  StoredAttachment,
} from "./types.js";
import {
  broadcast,
  buildChannelEvent,
  parseRowToChannelEvent,
  channelEventToRpcSignal,
  queueEmit,
  queueDoEnvelope,
  type BroadcastDeps,
  cleanupDeliveryChain,
} from "./broadcast.js";
import { buildReplayEnvelope } from "./replay.js";
import { classifyLogWrite } from "./log-classify.js";
import {
  storeCall,
  consumeCall,
  cancelCall as cancelCallDb,
  cancelCallsForTarget,
} from "./method-calls.js";

/** How long before an RPC participant is considered stale (no heartbeat). */
const PARTICIPANT_STALE_MS = 5 * 60 * 1000; // 5 minutes
/** How often to check for stale participants. */
const PARTICIPANT_CLEANUP_INTERVAL_MS = 60 * 1000; // 1 minute
/** Default root-message replay window. */
const REPLAY_LIMIT = 50;

function parseDOParticipantId(
  participantId: string
): { source: string; className: string; objectKey: string } | null {
  if (!participantId.startsWith("do:")) return null;
  const parts = participantId.slice(3).split(":");
  if (parts.length < 3) return null;
  const [source, className, ...objectKeyParts] = parts;
  const objectKey = objectKeyParts.join(":");
  if (!source || !className || !objectKey) return null;
  return { source, className, objectKey };
}

export class PubSubChannel extends DurableObjectBase {
  static override schemaVersion = 100;

  constructor(ctx: DurableObjectContext, env: unknown) {
    super(ctx, env);
    // Eager init — the DO must be ready before any message arrives.
    this.ensureReady();
    try {
      this.sql.exec(`PRAGMA foreign_keys = ON`);
    } catch {
      /* workerd may ignore pragmas */
    }
  }

  protected createTables(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        sender_metadata TEXT,
        attachments TEXT,
        ts INTEGER NOT NULL,
        is_root INTEGER NOT NULL,
        root_message_id TEXT,
        root_kind TEXT,
        CHECK (
          (is_root = 1 AND root_message_id IS NULL
                       AND root_kind IS NOT NULL
                       AND root_kind IN ('chat', 'method', 'presence', 'system')) OR
          (is_root = 0 AND root_message_id IS NOT NULL
                       AND root_kind IS NULL)
        ),
        FOREIGN KEY (root_message_id) REFERENCES messages(message_id)
      )
    `);
    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_root
        ON messages(root_message_id) WHERE root_message_id IS NOT NULL
    `);
    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_root_chat
        ON messages(id DESC) WHERE root_kind = 'chat' AND is_root = 1
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS participants (
        id TEXT PRIMARY KEY,
        metadata TEXT NOT NULL,
        transport TEXT NOT NULL,
        connected_at INTEGER NOT NULL,
        session_id TEXT,
        handle TEXT
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS pending_calls (
        call_id TEXT PRIMARY KEY,
        caller_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        method TEXT NOT NULL,
        args TEXT,
        created_at INTEGER NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS dedup_keys (
        key TEXT PRIMARY KEY,
        result_id INTEGER,
        created_at INTEGER NOT NULL
      )
    `);
  }

  protected override migrate(_fromVersion: number, _toVersion: number): void {
    this.sql.exec(`DROP INDEX IF EXISTS idx_messages_root`);
    this.sql.exec(`DROP INDEX IF EXISTS idx_messages_root_chat`);
    this.sql.exec(`DROP TABLE IF EXISTS messages`);
    this.sql.exec(`DROP TABLE IF EXISTS participants`);
    this.sql.exec(`DROP TABLE IF EXISTS pending_calls`);
    this.sql.exec(`DROP TABLE IF EXISTS dedup_keys`);
    this.createTables();
  }

  // ── Broadcast deps ──────────────────────────────────────────────────────

  private get broadcastDeps(): BroadcastDeps {
    return {
      sql: this.sql,
      rpc: this.rpc,
      objectKey: this.objectKey,
    };
  }

  /** Look up a participant's metadata from the participants table. */
  private getSenderMetadata(participantId: string): Record<string, unknown> | undefined {
    const row = this.sql
      .exec(`SELECT metadata FROM participants WHERE id = ?`, participantId)
      .toArray();
    if (row.length === 0) return undefined;
    try {
      return JSON.parse(row[0]!["metadata"] as string);
    } catch {
      return undefined;
    }
  }

  private appendLogEvent(
    type: string,
    payload: unknown,
    senderId: string,
    senderMetadata?: Record<string, unknown>,
    opts?: {
      messageId?: string;
      attachments?: StoredAttachment[];
    }
  ): ChannelEvent {
    const classification = classifyLogWrite(type, payload);
    let payloadJson: string;
    try {
      payloadJson = JSON.stringify(payload);
    } catch {
      throw new Error("payload not serializable");
    }
    const messageId = opts?.messageId ?? crypto.randomUUID();
    const ts = Date.now();
    this.sql.exec(
      `INSERT INTO messages (
        message_id, type, payload, sender_id, sender_metadata, attachments, ts,
        is_root, root_message_id, root_kind
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      messageId,
      type,
      payloadJson,
      senderId,
      senderMetadata ? JSON.stringify(senderMetadata) : null,
      opts?.attachments ? JSON.stringify(opts.attachments) : null,
      ts,
      classification.isRoot ? 1 : 0,
      classification.rootMessageId ?? null,
      classification.rootKind ?? null
    );
    const id = this.sql.exec(`SELECT last_insert_rowid() as id`).one()["id"] as number;
    return buildChannelEvent(
      id,
      messageId,
      type,
      payloadJson,
      senderId,
      senderMetadata,
      ts,
      opts?.attachments
    );
  }

  private currentReplayContext(): { contextId?: string; channelConfig?: Record<string, unknown> } {
    return {
      contextId: this.getStateValue("contextId") ?? undefined,
      channelConfig: this.getChannelConfig() ?? undefined,
    };
  }

  private ensureMethodRoot(
    callId: string,
    callerId: string,
    targetId?: string,
    methodName?: string,
    args?: unknown
  ): void {
    const existing = this.sql
      .exec(`SELECT id FROM messages WHERE message_id = ?`, callId)
      .toArray();
    if (existing.length > 0) return;
    this.appendLogEvent(
      "method-call",
      {
        callId,
        providerId: targetId ?? "unknown",
        methodName: methodName ?? "unknown",
        args,
      },
      callerId,
      this.getSenderMetadata(callerId),
      { messageId: callId }
    );
  }

  // ── Channel initialization ──────────────────────────────────────────────

  private initChannel(contextId: string, channelConfig?: Record<string, unknown>): void {
    const existing = this.getStateValue("contextId");
    if (existing) {
      if (existing !== contextId) {
        throw new Error(`Context mismatch: channel bound to ${existing}, got ${contextId}`);
      }
      return;
    }
    this.setStateValue("contextId", contextId);
    this.setStateValue("createdAt", String(Date.now()));
    if (channelConfig) this.setStateValue("config", JSON.stringify(channelConfig));
  }

  private getChannelConfig(): ChannelConfig | null {
    const raw = this.getStateValue("config");
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  private assertParticipantCaller(participantId: string, method: string): void {
    const callerId = this.rpcCallerId;
    if (callerId && callerId !== participantId) {
      throw new Error(
        `${method}: participant ${participantId} cannot be used by caller ${callerId}`
      );
    }
  }

  private isPrivilegedRpcCaller(): boolean {
    const callerId = this.rpcCallerId;
    const callerKind = this.rpcCallerKind;
    return (
      callerId === "main" ||
      callerKind === "server" ||
      callerKind === "shell" ||
      callerKind === "harness"
    );
  }

  private assertAdminCaller(method: string): void {
    if (this.isPrivilegedRpcCaller()) return;
    const callerId = this.rpcCallerId ?? "unknown";
    const callerKind = this.rpcCallerKind ?? "unknown";
    throw new Error(`${method}: privileged caller required (got ${callerKind} ${callerId})`);
  }

  // ── Presence events ─────────────────────────────────────────────────────

  private publishPresenceEvent(
    senderId: string,
    action: "join" | "leave" | "update",
    metadata: Record<string, unknown>,
    leaveReason?: "graceful" | "disconnect" | "replaced",
    senderRef?: number
  ): void {
    const payload: PresencePayload = {
      action,
      metadata,
      ...(leaveReason ? { leaveReason } : {}),
    };

    const event = this.appendLogEvent("presence", payload, senderId, metadata);
    broadcast(this.broadcastDeps, event, { kind: "log", phase: "live", ref: senderRef }, senderId);
  }

  private broadcastPresenceSignal(
    senderId: string,
    action: "join" | "leave" | "update",
    metadata: Record<string, unknown>,
    leaveReason?: "graceful" | "disconnect" | "replaced"
  ): void {
    const payload: PresencePayload = {
      action,
      metadata,
      ...(leaveReason ? { leaveReason } : {}),
    };
    const event = buildChannelEvent(
      0,
      crypto.randomUUID(),
      "presence",
      JSON.stringify(payload),
      senderId,
      metadata,
      Date.now()
    );
    broadcast(this.broadcastDeps, event, { kind: "signal" }, senderId);
  }

  // ── RPC-callable methods ──────────────────────────────────────────────

  /**
   * Subscribe a participant to this channel.
   * Called by panels (via RPC through server relay) and DOs (via RPC call).
   *
   * Subscribe inserts the participant first, then builds replay. This means an
   * initial roster snapshot always contains the subscriber itself.
   */
  async subscribe(
    participantId: string,
    metadata: Record<string, unknown>
  ): Promise<SubscribeResult> {
    const doRef = parseDOParticipantId(participantId);
    const transport = doRef ? "do" : "rpc";
    const callerId = this.rpcCallerId;
    if (callerId && callerId !== participantId) {
      throw new Error(`Participant ${participantId} cannot be subscribed by caller ${callerId}`);
    }
    const participantSessionId =
      typeof metadata[PARTICIPANT_SESSION_METADATA_KEY] === "string"
        ? (metadata[PARTICIPANT_SESSION_METADATA_KEY] as string)
        : null;

    // Extract contextId from metadata
    const contextId = metadata["contextId"] as string | undefined;
    const channelConfigRaw = metadata["channelConfig"] as Record<string, unknown> | undefined;

    // Initialize channel if contextId provided
    if (contextId) {
      this.initChannel(contextId, channelConfigRaw);
    }

    // Enforce participant handle uniqueness within the channel.
    // Channel-tools extension uses bare method names keyed by handle, so two
    // participants advertising the same handle would collide. Reject the new
    // subscribe if another live participant already owns this handle.
    const handle = typeof metadata["handle"] === "string" ? (metadata["handle"] as string) : null;
    if (handle) {
      const conflict = this.sql
        .exec(`SELECT id FROM participants WHERE handle = ? AND id != ?`, handle, participantId)
        .toArray();
      if (conflict.length > 0) {
        const otherId = conflict[0]!["id"] as string;
        throw new Error(
          `Participant handle "${handle}" is already in use by another participant ` +
            `(${otherId}) in this channel. Handles must be unique.`
        );
      }
    }

    // Validate advertised method names. The channel-tools extension exposes
    // each method to the LLM by its bare name, so names must satisfy the
    // LLM-tool-name contract: ASCII letters/digits/`_`/`-`, starting with a
    // letter, length 1..64, and not collide with Pi's built-in tool names.
    // Reject the subscribe up-front so a misconfigured participant cannot
    // poison the agent's tool list.
    const advertisedMethods = metadata["methods"];
    if (Array.isArray(advertisedMethods)) {
      const VALID_METHOD_NAME = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
      const RESERVED_METHOD_NAMES = new Set(["read", "edit", "write", "grep", "find", "ls"]);
      for (const m of advertisedMethods) {
        const name =
          m && typeof m === "object" && typeof (m as { name?: unknown }).name === "string"
            ? (m as { name: string }).name
            : null;
        if (name === null) continue; // unknown shape; let downstream handle it
        if (!VALID_METHOD_NAME.test(name) || RESERVED_METHOD_NAMES.has(name)) {
          throw new Error(
            `Invalid method name "${name}" advertised by participant "${participantId}". ` +
              `Method names must match /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/ and ` +
              `not collide with built-in tool names (read, edit, write, grep, find, ls).`
          );
        }
      }
    }

    if (doRef && callerId) {
      await this.rpc.call(
        "main",
        "workers.resolveDurableObject",
        [doRef.source, doRef.className, doRef.objectKey]
      );
    }

    // Re-subscribe with the same participant ID: replace the roster entry, but
    // only redeliver in-flight calls if the underlying client session changed.
    // Clients should keep participantId stable for the logical viewer so
    // cold recovery after a server restart can replay from the last seen id
    // without creating duplicate roster participants.
    const existing = this.sql
      .exec(`SELECT session_id FROM participants WHERE id = ?`, participantId)
      .toArray();
    let sessionReplaced = false;
    if (existing.length > 0) {
      const previousSessionId = existing[0]!["session_id"] as string | null;
      const oldMetadata = this.getSenderMetadata(participantId) ?? {};
      sessionReplaced =
        previousSessionId == null ||
        participantSessionId == null ||
        previousSessionId !== participantSessionId;
      this.publishPresenceEvent(
        participantId,
        "leave",
        oldMetadata,
        sessionReplaced ? "replaced" : "graceful"
      );
      this.sql.exec(`DELETE FROM participants WHERE id = ?`, participantId);
      cleanupDeliveryChain(participantId);
      if (sessionReplaced) {
        const pendingCountRow = this.sql
          .exec(`SELECT COUNT(*) as cnt FROM pending_calls WHERE target_id = ?`, participantId)
          .toArray();
        const pendingCount = (pendingCountRow[0]?.["cnt"] as number) ?? 0;
        console.log(
          `[Channel] Participant session replaced: target=${participantId} previousSession=${previousSessionId ?? "unknown"} newSession=${participantSessionId ?? "unknown"} pendingCalls=${pendingCount}`
        );
      }
    }

    // Extract replay options before cleaning metadata
    const wantsReplay = metadata["replay"] !== false;
    const sinceId = metadata["sinceId"] as number | undefined;
    const replayMessageLimit = metadata["replayMessageLimit"] as number | undefined;

    // Clean metadata for storage (remove transport/DO fields and subscribe-time hints)
    const storedMetadata = { ...metadata };
    delete storedMetadata["contextId"];
    delete storedMetadata["channelConfig"];
    delete storedMetadata["replay"];
    delete storedMetadata["sinceId"];
    delete storedMetadata["replayMessageLimit"];
    delete storedMetadata["transport"];
    delete storedMetadata[PARTICIPANT_SESSION_METADATA_KEY];

    this.sql.exec(
      `INSERT INTO participants (id, metadata, transport, connected_at, session_id, handle)
       VALUES (?, ?, ?, ?, ?, ?)`,
      participantId,
      JSON.stringify(storedMetadata),
      transport === "do" ? "do" : "rpc",
      Date.now(),
      participantSessionId,
      handle
    );

    // Publish join presence before building replay so the initial roster snapshot includes self.
    this.publishPresenceEvent(participantId, "join", storedMetadata);

    const mode = wantsReplay && sinceId && sinceId > 0 ? "after" : "initial";
    const envelope = buildReplayEnvelope(this.sql, {
      mode,
      sinceId: wantsReplay ? sinceId : undefined,
      rootLimit: wantsReplay ? (replayMessageLimit ?? REPLAY_LIMIT) : 0,
      includeRosterSnapshot: wantsReplay && mode === "initial",
      ...this.currentReplayContext(),
    });
    this.queueReplayEnvelope(participantId, envelope, doRef != null);

    if (sessionReplaced) this.redeliverPendingCallsTo(participantId);

    // Schedule stale participant cleanup for RPC participants
    if (transport !== "do") {
      this.scheduleParticipantCleanup();
    }

    return {
      ok: true,
      channelConfig: this.getChannelConfig() ?? undefined,
      envelope,
    };
  }

  private queueReplayEnvelope(
    subscriberId: string,
    envelope: ReturnType<typeof buildReplayEnvelope>,
    deliverToDo: boolean
  ): void {
    const onFatal = (err: { code?: string }) => {
      if (err?.code === "TARGET_NOT_REACHABLE" || err?.code === "RECONNECT_GRACE_EXPIRED") {
        this.sql.exec(`DELETE FROM participants WHERE id = ?`, subscriberId);
        cleanupDeliveryChain(subscriberId);
      }
    };
    for (const event of envelope.logEvents) {
      void queueEmit(
        this.broadcastDeps,
        subscriberId,
        {
          channelId: this.objectKey,
          message: { kind: "log", phase: "replay", event },
        },
        onFatal
      );
      if (deliverToDo) {
        void queueDoEnvelope(this.broadcastDeps, subscriberId, { kind: "log", phase: "replay", event });
      }
    }
    for (const snapshot of envelope.snapshots) {
      const message = {
        kind: "control" as const,
        type: "roster-snapshot" as const,
        participants: snapshot.participants,
        ts: snapshot.ts,
      };
      void queueEmit(this.broadcastDeps, subscriberId, { channelId: this.objectKey, message }, onFatal);
      if (deliverToDo) {
        void queueDoEnvelope(this.broadcastDeps, subscriberId, message);
      }
    }
    const readyMessage = { kind: "control" as const, type: "ready" as const, ready: envelope.ready };
    void queueEmit(
      this.broadcastDeps,
      subscriberId,
      { channelId: this.objectKey, message: readyMessage },
      onFatal
    );
    if (deliverToDo) {
      void queueDoEnvelope(this.broadcastDeps, subscriberId, readyMessage);
    }
  }

  /**
   * Unsubscribe a participant from this channel.
   */
  async unsubscribe(participantId: string): Promise<void> {
    this.assertParticipantCaller(participantId, "unsubscribe");
    await this.unsubscribeParticipant(participantId, "graceful");
  }

  async adminUnsubscribeParticipant(participantId: string): Promise<void> {
    this.assertAdminCaller("adminUnsubscribeParticipant");
    await this.unsubscribeParticipant(participantId, "graceful");
  }

  private async unsubscribeParticipant(
    participantId: string,
    leaveReason: "graceful" | "disconnect" | "replaced"
  ): Promise<void> {
    const metadata = this.getSenderMetadata(participantId) ?? {};

    this.sql.exec(`DELETE FROM participants WHERE id = ?`, participantId);
    cleanupDeliveryChain(participantId);
    await this.failPendingCallsTargeting(participantId, leaveReason);
    this.publishPresenceEvent(participantId, "leave", metadata, leaveReason);
  }

  /**
   * Redeliver pending method-calls to a (re)subscribed participant.
   *
   * The canonical method-call root is durable. If the target's session was
   * interrupted while the call was pending, the provider still needs an
   * operational nudge after it re-subscribes. Re-emit every still-pending call
   * targeting this participant as a signal, queued through the same
   * per-subscriber FIFO as roster/message replay. Delivery is at-least-once
   * over the call's lifetime: a handler may
   * run twice if it executed on the prior session but the result-publish was
   * interrupted. All in-tree methods (feedback_form, feedback_custom,
   * ui_prompt, tool_approval) are idempotent; custom methods with
   * non-idempotent side effects should dedupe on `callId`.
   */
  private redeliverPendingCallsTo(participantId: string): void {
    const rows = this.sql
      .exec(
        `SELECT call_id, caller_id, method, args FROM pending_calls WHERE target_id = ?`,
        participantId
      )
      .toArray();
    if (rows.length === 0) return;

    const onFatal = (err: { code?: string }) => {
      if (err?.code === "TARGET_NOT_REACHABLE" || err?.code === "RECONNECT_GRACE_EXPIRED") {
        this.sql.exec(`DELETE FROM participants WHERE id = ?`, participantId);
        cleanupDeliveryChain(participantId);
      }
    };

    for (const row of rows) {
      const callId = row["call_id"] as string;
      const callerId = row["caller_id"] as string;
      const methodName = row["method"] as string;
      const argsRaw = row["args"] as string | null;
      let args: unknown = undefined;
      if (argsRaw != null) {
        try {
          args = JSON.parse(argsRaw);
        } catch (err) {
          console.warn(`[Channel] redeliver: failed to parse args for callId=${callId}:`, err);
          continue;
        }
      }
      const payload = { callId, providerId: participantId, methodName, args };
      const senderMetadata = this.getSenderMetadata(callerId);
      const ts = Date.now();
      const event: ChannelEvent = {
        id: 0,
        messageId: "",
        type: "method-call",
        payload,
        senderId: callerId,
        senderMetadata,
        ts,
      };
      const msg = channelEventToRpcSignal(event);
      void queueEmit(
        this.broadcastDeps,
        participantId,
        {
          channelId: this.objectKey,
          message: msg,
        },
        onFatal
      );
    }
    console.log(`[Channel] Redelivered ${rows.length} pending call(s) to ${participantId}`);
  }

  /**
   * Cancel any pending tool calls targeting a participant that's leaving the
   * channel. Each affected caller gets a synthetic "target left" error result
   * delivered via the normal result path, so the harness's pendingToolResults
   * map fails with a meaningful error rather than hanging until the harness
   * stall warning fires. Called for graceful unsubscribe and stale-session
   * eviction; session-replace goes through `redeliverPendingCallsTo` instead.
   */
  private async failPendingCallsTargeting(
    targetId: string,
    reason: "graceful" | "disconnect" | "replaced"
  ): Promise<void> {
    const cancelled = cancelCallsForTarget(this.sql, targetId);
    if (cancelled.length === 0) return;
    const errorMessage =
      reason === "graceful"
        ? `Target ${targetId} left the channel before the call completed`
        : reason === "disconnect"
          ? `Target ${targetId} disconnected from the channel before the call completed`
          : `Target ${targetId} was replaced by a new session before the call completed`;
    for (const { callId, callerId } of cancelled) {
      try {
        await this.deliverCallResult(callerId, callId, { error: errorMessage }, true);
      } catch (err) {
        console.warn(`[Channel] failPendingCallsTargeting: deliver failed for ${callId}:`, err);
      }
    }
    console.log(
      `[Channel] Cancelled ${cancelled.length} pending call(s) targeting ${targetId} (${reason})`
    );
  }

  /**
   * Heartbeat from an RPC participant. Updates connected_at to prevent stale eviction.
   * Panels should call this periodically (e.g., every 60s).
   */
  async touch(participantId: string): Promise<void> {
    this.sql.exec(
      `UPDATE participants SET connected_at = ? WHERE id = ?`,
      Date.now(),
      participantId
    );
  }

  /**
   * Send a new message (from any participant).
   */
  async send(
    participantId: string,
    messageId: string,
    content: string,
    opts?: SendOpts
  ): Promise<void> {
    this.assertParticipantCaller(participantId, "send");
    // Phase 0B: Idempotency check
    const idempotencyKey = opts?.idempotencyKey;
    if (idempotencyKey) {
      const existing = this.sql
        .exec(`SELECT result_id FROM dedup_keys WHERE key = ?`, idempotencyKey)
        .toArray();
      if (existing.length > 0) {
        return;
      }
    }

    const contentType = opts?.contentType;
    const replyTo = opts?.replyTo;

    const senderMetadata = this.getSenderMetadata(participantId) ?? opts?.senderMetadata;

    // Build payload (match PubSub server format)
    const payload: Record<string, unknown> = {
      id: messageId,
      content,
    };
    if (contentType) payload["contentType"] = contentType;
    if (replyTo) payload["replyTo"] = replyTo;
    const payloadJson = JSON.stringify(payload);

    const event = this.appendLogEvent("message", payload, participantId, senderMetadata, {
      messageId,
    });

    if (idempotencyKey) {
      this.sql.exec(
        `INSERT OR IGNORE INTO dedup_keys (key, result_id, created_at) VALUES (?, ?, ?)`,
        idempotencyKey,
        event.id,
        Date.now()
      );
      this.scheduleDedupCleanup();
    }
    broadcast(this.broadcastDeps, event, { kind: "log", phase: "live" }, participantId);
  }

  /**
   * Publish a typed message (from any participant).
   * This is the generic publish method used by panel clients for all message types.
   */
  async publish(
    participantId: string,
    type: string,
    payload: unknown,
    opts?: {
      ref?: number;
      senderMetadata?: Record<string, unknown>;
      attachments?: StoredAttachment[];
      idempotencyKey?: string;
    }
  ): Promise<{ id?: number }> {
    this.assertParticipantCaller(participantId, "publish");
    const ref = opts?.ref;
    const attachments = opts?.attachments;
    const idempotencyKey = opts?.idempotencyKey;
    if (idempotencyKey) {
      const existing = this.sql
        .exec(`SELECT result_id FROM dedup_keys WHERE key = ?`, idempotencyKey)
        .toArray();
      if (existing.length > 0) {
        return { id: existing[0]!["result_id"] as number | undefined };
      }
    }

    // Intercept method-result only if there's a matching pending DO-initiated call
    // AND the result is complete (not a streaming partial like console chunks).
    if (type === "method-result" && payload && typeof payload === "object") {
      const p = payload as Record<string, unknown>;
      const callId = p["callId"] as string;
      const isComplete = p["complete"] !== false;
      if (callId && isComplete) {
        const pending = this.sql
          .exec(`SELECT call_id FROM pending_calls WHERE call_id = ?`, callId)
          .toArray();
        if (pending.length > 0) {
          const resultId = await this.handleMethodResult(callId, p["content"], !!p["isError"]);
          if (idempotencyKey && resultId !== undefined) {
            this.sql.exec(
              `INSERT OR IGNORE INTO dedup_keys (key, result_id, created_at) VALUES (?, ?, ?)`,
              idempotencyKey,
              resultId,
              Date.now()
            );
            this.scheduleDedupCleanup();
          }
          return { id: resultId };
        }
        // No pending call — fall through to normal broadcast
      }
    }

    const senderMetadata = this.getSenderMetadata(participantId) ?? opts?.senderMetadata;

    // Extract messageId from payload
    const payloadObj =
      typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : null;
    const messageId = (payloadObj?.["id"] as string) ?? crypto.randomUUID();

    const event = this.appendLogEvent(type, payload, participantId, senderMetadata, {
      messageId: type === "message" || type === "method-call" ? messageId : undefined,
      attachments,
    });

    if (idempotencyKey) {
      this.sql.exec(
        `INSERT OR IGNORE INTO dedup_keys (key, result_id, created_at) VALUES (?, ?, ?)`,
        idempotencyKey,
        event.id,
        Date.now()
      );
      this.scheduleDedupCleanup();
    }

    broadcast(this.broadcastDeps, event, { kind: "log", phase: "live", ref }, participantId);
    return { id: event.id };
  }

  /**
   * Update an existing message (from a participant).
   *
   * `opts.append` forces append semantics on a typed (contentType-set)
   * message. Untyped messages already append by default on the client;
   * the flag is only meaningful for typed streams (e.g. thinking).
   */
  async update(
    participantId: string,
    messageId: string,
    content: string,
    idempotencyKey?: string,
    opts?: { append?: boolean }
  ): Promise<void> {
    this.assertParticipantCaller(participantId, "update");
    // Phase 0B: Idempotency check
    if (idempotencyKey) {
      const existing = this.sql
        .exec(`SELECT result_id FROM dedup_keys WHERE key = ?`, idempotencyKey)
        .toArray();
      if (existing.length > 0) {
        return;
      }
    }

    const senderMetadata = this.getSenderMetadata(participantId);

    const payload: Record<string, unknown> = { id: messageId, content };
    if (opts?.append) payload["append"] = true;
    const event = this.appendLogEvent("update-message", payload, participantId, senderMetadata);

    if (idempotencyKey) {
      this.sql.exec(
        `INSERT OR IGNORE INTO dedup_keys (key, result_id, created_at) VALUES (?, ?, ?)`,
        idempotencyKey,
        event.id,
        Date.now()
      );
      this.scheduleDedupCleanup();
    }

    broadcast(this.broadcastDeps, event, { kind: "log", phase: "live" }, participantId);
  }

  /**
   * Complete (finalize) a message (from a participant).
   */
  async complete(participantId: string, messageId: string, idempotencyKey?: string): Promise<void> {
    this.assertParticipantCaller(participantId, "complete");
    // Phase 0B: Idempotency check
    if (idempotencyKey) {
      const existing = this.sql
        .exec(`SELECT result_id FROM dedup_keys WHERE key = ?`, idempotencyKey)
        .toArray();
      if (existing.length > 0) {
        return;
      }
    }

    const senderMetadata = this.getSenderMetadata(participantId);

    // complete uses type "update-message" with { id, complete: true } — matches PubSub server wire format
    const payload = { id: messageId, complete: true };
    const event = this.appendLogEvent("update-message", payload, participantId, senderMetadata);

    if (idempotencyKey) {
      this.sql.exec(
        `INSERT OR IGNORE INTO dedup_keys (key, result_id, created_at) VALUES (?, ?, ?)`,
        idempotencyKey,
        event.id,
        Date.now()
      );
      this.scheduleDedupCleanup();
    }

    broadcast(this.broadcastDeps, event, { kind: "log", phase: "live" }, participantId);
  }

  /**
   * Mark a message as errored. Persists an `error` channel event with a
   * human-readable error string, which the client merge helper surfaces as
   * `ChatMessage.error` + `complete: true` in the chat UI. Used by the
   * worker's ContentBlockProjector when a channel op fails so users see a
   * visible error instead of a silent empty message.
   */
  async error(
    participantId: string,
    messageId: string,
    errorMessage: string,
    code?: string
  ): Promise<void> {
    this.assertParticipantCaller(participantId, "error");
    const senderMetadata = this.getSenderMetadata(participantId);
    const payload: Record<string, unknown> = { id: messageId, error: errorMessage };
    if (code) payload["code"] = code;
    const event = this.appendLogEvent("error", payload, participantId, senderMetadata);
    broadcast(this.broadcastDeps, event, { kind: "log", phase: "live" }, participantId);
  }

  async getReplayAfter(sinceId: number) {
    return buildReplayEnvelope(this.sql, {
      mode: "after",
      sinceId,
      ...this.currentReplayContext(),
    });
  }

  /**
   * Send a non-durable signal message (from a participant).
   */
  async sendSignal(participantId: string, content: string, contentType?: string): Promise<void> {
    this.assertParticipantCaller(participantId, "sendSignal");
    const ts = Date.now();
    const messageId = `sig_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const senderMetadata = this.getSenderMetadata(participantId);

    const payload: Record<string, unknown> = { id: messageId, content };
    if (contentType) payload["contentType"] = contentType;
    const payloadJson = JSON.stringify(payload);

    const event = buildChannelEvent(
      0,
      messageId,
      "message",
      payloadJson,
      participantId,
      senderMetadata,
      ts
    );
    broadcast(this.broadcastDeps, event, { kind: "signal" }, participantId);
  }

  /**
   * Replace a participant's metadata entirely.
   */
  async updateMetadata(participantId: string, metadata: Record<string, unknown>): Promise<void> {
    this.assertParticipantCaller(participantId, "updateMetadata");
    this.updateParticipantMetadata(participantId, metadata);
  }

  async adminUpdateParticipantMetadata(
    participantId: string,
    metadata: Record<string, unknown>
  ): Promise<void> {
    this.assertAdminCaller("adminUpdateParticipantMetadata");
    this.updateParticipantMetadata(participantId, metadata);
  }

  private updateParticipantMetadata(
    participantId: string,
    metadata: Record<string, unknown>
  ): void {
    this.sql.exec(
      `UPDATE participants SET metadata = ? WHERE id = ?`,
      JSON.stringify(metadata),
      participantId
    );
    this.publishPresenceEvent(participantId, "update", metadata);
  }

  /**
   * Set a participant's typing state. Updates the participants table (so
   * reconnecting clients see current state) and broadcasts a signal without
   * inserting a messages row.
   */
  async setTypingState(participantId: string, typing: boolean): Promise<void> {
    this.assertParticipantCaller(participantId, "setTypingState");
    this.setParticipantTypingState(participantId, typing);
  }

  async adminSetParticipantTypingState(participantId: string, typing: boolean): Promise<void> {
    this.assertAdminCaller("adminSetParticipantTypingState");
    this.setParticipantTypingState(participantId, typing);
  }

  private setParticipantTypingState(participantId: string, typing: boolean): void {
    const rows = this.sql
      .exec(`SELECT metadata FROM participants WHERE id = ?`, participantId)
      .toArray();
    if (rows.length === 0) return;
    const final = { ...JSON.parse(rows[0]!["metadata"] as string), typing };
    this.sql.exec(
      `UPDATE participants SET metadata = ? WHERE id = ?`,
      JSON.stringify(final),
      participantId
    );
    this.broadcastPresenceSignal(participantId, "update", final);
  }

  /**
   * Get all participants with DO identity when available.
   */
  async getParticipants(): Promise<
    Array<{
      participantId: string;
      metadata: Record<string, unknown>;
      transport: string;
      doRef?: { source: string; className: string; objectKey: string };
    }>
  > {
    const rows = this.sql.exec(`SELECT id, metadata, transport FROM participants`).toArray();
    return rows.map((row) => {
      const participantId = row["id"] as string;
      const entry: {
        participantId: string;
        metadata: Record<string, unknown>;
        transport: string;
        doRef?: { source: string; className: string; objectKey: string };
      } = {
        participantId,
        metadata: JSON.parse(row["metadata"] as string),
        transport: row["transport"] as string,
      };
      const doRef = parseDOParticipantId(participantId);
      if (doRef) entry.doRef = doRef;
      return entry;
    });
  }

  /**
   * Get the channel's contextId (set during initChannel).
   */
  async getContextId(): Promise<string | null> {
    return this.getStateValue("contextId");
  }

  /**
   * Update channel config.
   */
  async updateConfig(config: Partial<ChannelConfig>): Promise<ChannelConfig> {
    const newConfig = { ...this.getChannelConfig(), ...config };
    this.setStateValue("config", JSON.stringify(newConfig));
    const event = this.appendLogEvent("config-update", newConfig, "system");
    broadcast(this.broadcastDeps, event, { kind: "log", phase: "live" }, "system");
    return newConfig;
  }

  async getChatReplayBefore(beforeRootId: number, rootLimit?: number) {
    return buildReplayEnvelope(this.sql, {
      mode: "before",
      beforeRootId,
      rootLimit: rootLimit ?? 100,
      ...this.currentReplayContext(),
    });
  }

  async adminInspectSchema() {
    this.assertAdminCaller("adminInspectSchema");
    const tables = ["messages", "participants", "pending_calls", "dedup_keys"].map((table) => ({
      table,
      columns: this.sql.exec(`PRAGMA table_info(${table})`).toArray(),
    }));
    const indexes = ["messages", "participants", "pending_calls", "dedup_keys"].flatMap((table) => {
      const list = this.sql.exec(`PRAGMA index_list(${table})`).toArray();
      return list.map((idx) => ({
        table,
        ...idx,
        columns: this.sql.exec(`PRAGMA index_info(${idx["name"] as string})`).toArray(),
      }));
    });
    const messageColumns = new Set(
      tables.find((entry) => entry.table === "messages")?.columns.map((col) => col["name"]) ?? []
    );
    const expected = [
      "id",
      "message_id",
      "type",
      "payload",
      "sender_id",
      "sender_metadata",
      "attachments",
      "ts",
      "is_root",
      "root_message_id",
      "root_kind",
    ];
    const actualColumns =
      tables.find((entry) => entry.table === "messages")?.columns.map((col) => col["name"]) ?? [];
    const messageSql =
      (this.sql
        .exec(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'messages'`)
        .toArray()[0]?.["sql"] as string | undefined) ?? "";
    const indexNames = new Set(
      indexes
        .filter((idx) => idx.table === "messages")
        .map((idx) => (idx as Record<string, unknown>)["name"])
    );
    return {
      tables,
      indexes,
      invariants: [
        {
          name: "messages-columns",
          ok:
            actualColumns.length === expected.length &&
            expected.every((column) => messageColumns.has(column)) &&
            !["content", `content_${"type"}`, `reply_${"to"}`, `per${"sist"}`].some((column) =>
              messageColumns.has(column)
            ),
        },
        {
          name: "messages-check-constraint",
          ok:
            messageSql.includes("root_kind IN ('chat', 'method', 'presence', 'system')") &&
            messageSql.includes("is_root = 1") &&
            messageSql.includes("is_root = 0"),
        },
        {
          name: "message-id-unique",
          ok: messageSql.includes("message_id TEXT NOT NULL UNIQUE"),
        },
        {
          name: "chat-root-index",
          ok: indexNames.has("idx_messages_root_chat") && indexNames.has("idx_messages_root"),
        },
      ],
    };
  }

  async adminInspectLog(opts: {
    afterId?: number;
    beforeId?: number;
    limit?: number;
    includePresence?: boolean;
  } = {}) {
    this.assertAdminCaller("adminInspectLog");
    const clauses: string[] = [];
    const args: unknown[] = [];
    if (opts.afterId != null) {
      clauses.push("id > ?");
      args.push(opts.afterId);
    }
    if (opts.beforeId != null) {
      clauses.push("id < ?");
      args.push(opts.beforeId);
    }
    if (!opts.includePresence) clauses.push("type != 'presence'");
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
    const rows = this.sql
      .exec(
        `SELECT id, message_id, type, payload, sender_id, sender_metadata, attachments, ts, is_root, root_message_id, root_kind
         FROM messages ${where} ORDER BY id ASC LIMIT ?`,
        ...args,
        limit
      )
      .toArray();
    const firstId = rows[0]?.["id"] as number | undefined;
    const lastId = rows[rows.length - 1]?.["id"] as number | undefined;
    return {
      rows,
      hasMoreBefore:
        firstId != null &&
        this.sql.exec(`SELECT id FROM messages WHERE id < ? LIMIT 1`, firstId).toArray().length > 0,
      hasMoreAfter:
        lastId != null &&
        this.sql.exec(`SELECT id FROM messages WHERE id > ? LIMIT 1`, lastId).toArray().length > 0,
    };
  }

  async adminInspectMessageChain(messageId: string) {
    this.assertAdminCaller("adminInspectMessageChain");
    return {
      rows: this.sql
        .exec(
          `SELECT id, message_id, type, payload, sender_id, sender_metadata, attachments, ts, is_root, root_message_id, root_kind
           FROM messages WHERE message_id = ? OR root_message_id = ? ORDER BY id ASC`,
          messageId,
          messageId
        )
        .toArray(),
    };
  }

  async adminReconstructTranscript(opts: { rootLimit?: number; beforeRootId?: number } = {}) {
    this.assertAdminCaller("adminReconstructTranscript");
    const envelope =
      opts.beforeRootId != null
        ? await this.getChatReplayBefore(opts.beforeRootId, opts.rootLimit)
        : buildReplayEnvelope(this.sql, {
            mode: "initial",
            rootLimit: opts.rootLimit ?? REPLAY_LIMIT,
            ...this.currentReplayContext(),
          });
    const replayEvents: unknown[] = envelope.logEvents.flatMap((event): unknown[] => {
      const payload = event.payload && typeof event.payload === "object"
        ? (event.payload as Record<string, unknown>)
        : {};
      const base = {
        delivery: "log" as const,
        phase: "replay" as const,
        pubsubId: event.id,
        senderId: event.senderId,
        ts: event.ts,
        senderMetadata: event.senderMetadata,
        attachments: event.attachments,
      };
      switch (event.type) {
        case "message":
          return [{
            ...base,
            type: "message" as const,
            id: (payload["id"] as string | undefined) ?? event.messageId,
            content: (payload["content"] as string | undefined) ?? "",
            contentType: payload["contentType"] as string | undefined,
            replyTo: payload["replyTo"] as string | undefined,
            metadata: payload["metadata"] as Record<string, unknown> | undefined,
          }];
        case "update-message":
          return [{
            ...base,
            type: "update-message" as const,
            id: (payload["id"] as string | undefined) ?? event.messageId,
            content: payload["content"] as string | undefined,
            append: payload["append"] as boolean | undefined,
            complete: payload["complete"] as boolean | undefined,
            contentType: payload["contentType"] as string | undefined,
          }];
        case "error":
          return [{
            ...base,
            type: "error" as const,
            id: (payload["id"] as string | undefined) ?? event.messageId,
            error: (payload["error"] as string | undefined) ?? "Unknown error",
            code: payload["code"] as string | undefined,
          }];
        case "method-call":
          return [{
            ...base,
            type: "method-call" as const,
            callId: (payload["callId"] as string | undefined) ?? event.messageId,
            providerId: payload["providerId"] as string | undefined,
            methodName: payload["methodName"] as string | undefined,
            args: payload["args"],
          }];
        case "method-result":
          return [{
            ...base,
            type: "method-result" as const,
            callId: (payload["callId"] as string | undefined) ?? event.messageId,
            content: payload["content"],
            complete: payload["complete"] as boolean | undefined,
            isError: payload["isError"] as boolean | undefined,
            progress: payload["progress"] as number | undefined,
            contentType: payload["contentType"] as string | undefined,
          }];
        default:
          return [];
      }
    });
    return {
      logEvents: envelope.logEvents,
      transcript: aggregateReplayEvents(replayEvents as Parameters<typeof aggregateReplayEvents>[0]),
      ready: envelope.ready,
    };
  }

  async adminValidateLog(opts: { rootLimit?: number } = {}) {
    this.assertAdminCaller("adminValidateLog");
    const issues: Array<{ code: string; message: string; rowId?: number }> = [];
    const schema = await this.adminInspectSchema();
    for (const invariant of schema.invariants) {
      if (!invariant.ok) issues.push({ code: "schema", message: `schema invariant failed: ${invariant.name}` });
    }
    const rows = this.sql
      .exec(
        `SELECT id, message_id, type, payload, sender_id, sender_metadata, is_root, root_message_id, root_kind
         FROM messages ORDER BY id ASC LIMIT ?`,
        Math.min(Math.max(opts.rootLimit ?? 10000, 1), 100000)
      )
      .toArray();
    const roots = new Map<string, Record<string, unknown>>();
    const parsedPayloads = new Map<number, Record<string, unknown>>();
    const chatTerminals = new Map<string, Array<{ rowId: number; kind: "complete" | "error" }>>();
    const methodTerminals = new Map<string, Array<{ rowId: number; kind: "result" | "cancel" | "timeout" | "error" }>>();
    for (const row of rows) {
      const rowId = row["id"] as number;
      try {
        const parsed = JSON.parse(row["payload"] as string);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          parsedPayloads.set(rowId, parsed as Record<string, unknown>);
        }
      } catch {
        issues.push({ code: "payload-json", message: "payload is not valid JSON", rowId });
      }
      const isRoot = row["is_root"] === 1;
      const rootKind = row["root_kind"] as string | null;
      const rootMessageId = row["root_message_id"] as string | null;
      if (isRoot) {
        roots.set(row["message_id"] as string, row);
        if (!["chat", "method", "presence", "system"].includes(rootKind ?? "")) {
          issues.push({ code: "root-kind", message: "unknown root_kind", rowId });
        }
        if (rootMessageId != null) {
          issues.push({ code: "root-target", message: "root row has root_message_id", rowId });
        }
      } else if (!rootMessageId || rootKind != null) {
        issues.push({ code: "dependent-shape", message: "dependent row has invalid root fields", rowId });
      }
    }
    for (const row of rows) {
      if (row["is_root"] === 1) continue;
      const root = roots.get(row["root_message_id"] as string);
      if (!root) {
        issues.push({ code: "orphan-dependent", message: "dependent root is missing", rowId: row["id"] as number });
        continue;
      }
      const type = row["type"] as string;
      const kind = root["root_kind"] as string;
      const rowId = row["id"] as number;
      const rootMessageId = row["root_message_id"] as string;
      const payload = parsedPayloads.get(rowId);
      if (["update-message", "error", "execution-pause"].includes(type) && kind !== "chat") {
        issues.push({ code: "wrong-root-kind", message: `${type} targets ${kind} root`, rowId });
      }
      if (["method-result", "method-cancel", "method-timeout"].includes(type) && kind !== "method") {
        issues.push({ code: "wrong-root-kind", message: `${type} targets ${kind} root`, rowId });
      }
      if (kind === "chat") {
        if (type === "update-message" && payload?.["complete"] === true) {
          const group = chatTerminals.get(rootMessageId) ?? [];
          group.push({ rowId, kind: "complete" });
          chatTerminals.set(rootMessageId, group);
        } else if (type === "error") {
          const group = chatTerminals.get(rootMessageId) ?? [];
          group.push({ rowId, kind: "error" });
          chatTerminals.set(rootMessageId, group);
        }
      }
      if (kind === "method") {
        if (type === "method-result" && payload?.["complete"] === true) {
          const group = methodTerminals.get(rootMessageId) ?? [];
          group.push({ rowId, kind: payload["isError"] === true ? "error" : "result" });
          methodTerminals.set(rootMessageId, group);
        } else if (type === "method-cancel" || type === "method-timeout") {
          const group = methodTerminals.get(rootMessageId) ?? [];
          group.push({ rowId, kind: type === "method-cancel" ? "cancel" : "timeout" });
          methodTerminals.set(rootMessageId, group);
        }
      }
    }
    for (const [rootId, terminals] of chatTerminals) {
      if (terminals.length > 1) {
        const kinds = new Set(terminals.map((terminal) => terminal.kind));
        issues.push({
          code: kinds.size === 1 ? "duplicate-terminal" : "contradictory-terminal",
          message: `chat root ${rootId} has ${terminals.length} terminal rows`,
          rowId: terminals[1]?.rowId,
        });
      }
    }
    for (const [rootId, terminals] of methodTerminals) {
      const terminalClasses = new Set(terminals.map((terminal) => terminal.kind));
      if (terminals.length > 1) {
        issues.push({
          code: terminalClasses.size === 1 ? "duplicate-terminal" : "contradictory-terminal",
          message: `method root ${rootId} has ${terminals.length} terminal rows`,
          rowId: terminals[1]?.rowId,
        });
      }
    }
    for (const row of rows) {
      if (row["is_root"] !== 1 || row["root_kind"] !== "chat") continue;
      const metadataRaw = row["sender_metadata"] as string | null;
      let senderType: string | undefined;
      if (metadataRaw) {
        try {
          const metadata = JSON.parse(metadataRaw) as Record<string, unknown>;
          senderType = metadata["type"] as string | undefined;
        } catch {
          /* ignore */
        }
      }
      if (senderType === "agent" && !chatTerminals.has(row["message_id"] as string)) {
        issues.push({
          code: "missing-terminal",
          message: "assistant chat root has no terminal update or error",
          rowId: row["id"] as number,
        });
      }
    }
    return {
      ok: issues.length === 0,
      issues,
      stats: {
        rowCount: rows.length,
        rootCount: rows.filter((row) => row["is_root"] === 1).length,
        dependentCount: rows.filter((row) => row["is_root"] !== 1).length,
      },
    };
  }

  // ── Method calls ────────────────────────────────────────────────────────

  /**
   * Initiate an async method call between participants.
   */
  async callMethod(
    callerPid: string,
    targetPid: string,
    callId: string,
    method: string,
    args: unknown
  ): Promise<void> {
    this.assertParticipantCaller(callerPid, "callMethod");
    storeCall(this.sql, callId, callerPid, targetPid, method, args);
    this.scheduleNextAlarm();
    const payload = { callId, providerId: targetPid, methodName: method, args };
    const senderMetadata = this.getSenderMetadata(callerPid);
    const callEvent = this.appendLogEvent("method-call", payload, callerPid, senderMetadata, {
      messageId: callId,
    });
    broadcast(this.broadcastDeps, callEvent, { kind: "log", phase: "live" }, callerPid);

    // Deliver to target
    const target = this.sql
      .exec(`SELECT transport FROM participants WHERE id = ?`, targetPid)
      .toArray();

    if (target.length === 0) {
      // Target not found — deliver error to caller
      this.sql.exec(`DELETE FROM pending_calls WHERE call_id = ?`, callId);
      await this.deliverCallResult(
        callerPid,
        callId,
        { error: `Target ${targetPid} not found` },
        true
      );
      return;
    }

    const t = target[0]!;
    if (t["transport"] === "do") {
      // Deliver to DO target via RPC call
      try {
        const result = await this.rpc.call(
          targetPid,
          "onMethodCall",
          [this.objectKey, callId, method, args]
        );
        // Method returned a result — deliver to caller
        const pending = consumeCall(this.sql, callId);
        if (pending) {
          const res = result as { result: unknown; isError?: boolean };
          await this.deliverCallResult(callerPid, callId, res.result, !!res.isError);
        }
      } catch (err) {
        const pending = consumeCall(this.sql, callId);
        if (pending) {
          await this.deliverCallResult(
            callerPid,
            callId,
            err instanceof Error ? err.message : String(err),
            true
          );
        }
      }
    } else {
      // RPC targets receive the durable method-call through the log broadcast above.
    }
  }

  /**
   * Handle a method result from a participant.
   */
  async handleMethodResult(
    callId: string,
    content: unknown,
    isError: boolean
  ): Promise<number | undefined> {
    const pending = consumeCall(this.sql, callId);
    if (!pending) {
      console.warn(
        `[Channel] Ignoring method-result without pending call: ` +
        `channel=${this.objectKey} callId=${callId} isError=${isError}`,
      );
      return undefined;
    }
    const resultId = await this.deliverCallResult(pending.callerId, callId, content, isError);
    this.scheduleNextAlarm();
    return resultId;
  }

  /**
   * Cancel a pending method call.
   */
  async cancelMethodCall(callId: string): Promise<void> {
    // Look up the provider before deleting the call
    const call = this.sql
      .exec(`SELECT target_id FROM pending_calls WHERE call_id = ?`, callId)
      .toArray();
    cancelCallDb(this.sql, callId);
    this.scheduleNextAlarm();
    // Notify the provider so it can abort the executing method
    if (call.length > 0) {
      const providerId = call[0]!["target_id"] as string;
      this.ensureMethodRoot(callId, "system", providerId);
      const event = this.appendLogEvent("method-cancel", { callId }, "system");
      broadcast(this.broadcastDeps, event, { kind: "log", phase: "live" }, "system");
      this.rpc
        .emit(providerId, "channel:message", {
          channelId: this.objectKey,
          message: {
            kind: "signal",
            type: "method-cancel",
            payload: { callId },
            senderId: "system",
            ts: Date.now(),
          },
        })
        .catch((err) => {
          console.warn("[Channel] cancel emit failed:", err);
        });
    }
  }

  /**
   * Mark a pending method call as timed out. The channel does not schedule
   * wall-clock timeouts itself; callers that own a deadline can close the call
   * through this durable terminal event.
   */
  async timeoutMethodCall(callId: string, reason?: string): Promise<void> {
    const call = this.sql
      .exec(`SELECT caller_id, target_id FROM pending_calls WHERE call_id = ?`, callId)
      .toArray();
    if (call.length === 0) return;
    cancelCallDb(this.sql, callId);
    this.scheduleNextAlarm();
    const callerId = call[0]!["caller_id"] as string;
    const targetId = call[0]!["target_id"] as string;
    this.ensureMethodRoot(callId, callerId, targetId);
    const payload: Record<string, unknown> = { callId };
    if (reason) payload["reason"] = reason;
    const event = this.appendLogEvent("method-timeout", payload, "system");
    broadcast(this.broadcastDeps, event, { kind: "log", phase: "live" }, "system");
  }

  private async deliverCallResult(
    callerId: string,
    callId: string,
    result: unknown,
    isError: boolean
  ): Promise<number | undefined> {
    const caller = this.sql
      .exec(`SELECT id FROM participants WHERE id = ?`, callerId)
      .toArray();

    if (caller.length === 0) return undefined;

    // Persist and broadcast the result as the single canonical completion path.
    // DO and RPC participants both observe the same method-result event.
    this.ensureMethodRoot(callId, callerId);
    const payload = { callId, content: result, complete: true, isError: isError ?? false };
    const event = this.appendLogEvent("method-result", payload, callerId);
    broadcast(this.broadcastDeps, event, { kind: "log", phase: "live" }, callerId);
    return event.id;
  }

  /**
   * Unified alarm scheduler — computes the minimum next alarm time across all
   * alarm sources (dedup cleanup, participant cleanup) to avoid one source
   * overwriting another's sooner alarm.
   *
   * Method calls do not have an internal wall-clock timeout — agentic
   * activities can run for arbitrary lengths. Pending calls are cancelled by
   * roster events (see cancelCallsForTarget) when a target participant leaves,
   * or by timeoutMethodCall when an external caller owns a deadline.
   */
  private scheduleNextAlarm(): void {
    const now = Date.now();
    let nextMs = Infinity;

    // Dedup cleanup — absolute deadline stored as timestamp
    const dedupDeadline = this.getStateValue("dedup_cleanup_at");
    if (dedupDeadline) {
      const dedupMs = Math.max(Number(dedupDeadline) - now, 100);
      nextMs = Math.min(nextMs, dedupMs);
    }

    // Participant cleanup — 1 minute if RPC participants exist
    const rpcCount = this.sql
      .exec(`SELECT COUNT(*) as cnt FROM participants WHERE transport = 'rpc'`)
      .toArray();
    if ((rpcCount[0]?.["cnt"] as number) > 0) {
      nextMs = Math.min(nextMs, PARTICIPANT_CLEANUP_INTERVAL_MS);
    }

    if (nextMs < Infinity) {
      this.setAlarm(nextMs);
    }
  }

  private scheduleDedupCleanup(): void {
    if (this.getStateValue("dedup_cleanup_at")) return;
    this.setStateValue("dedup_cleanup_at", String(Date.now() + 5 * 60 * 1000));
    this.scheduleNextAlarm();
  }

  // ── Alarm (stale participant cleanup + dedup key cleanup) ─────────────────

  override async alarm(): Promise<void> {
    await super.alarm();

    // Evict stale RPC participants (not DO participants — those are persistent).
    // Stale eviction itself fails any pending tool calls targeting the evicted
    // participant via cancelCallsForTarget — see evictStaleParticipants below.
    await this.evictStaleParticipants();

    // Phase 0B: Clean up expired dedup keys
    const dedupCutoff = Date.now() - 5 * 60 * 1000;
    this.sql.exec(`DELETE FROM dedup_keys WHERE created_at < ?`, dedupCutoff);
    const remaining = this.sql.exec(`SELECT COUNT(*) as cnt FROM dedup_keys`).toArray();
    if ((remaining[0]?.["cnt"] as number) === 0) {
      this.deleteStateValue("dedup_cleanup_at");
    } else {
      // Reschedule for another 5 minutes
      this.setStateValue("dedup_cleanup_at", String(Date.now() + 5 * 60 * 1000));
    }

    // Unified reschedule — computes minimum next alarm across all sources
    this.scheduleNextAlarm();
  }

  private async evictStaleParticipants(): Promise<void> {
    const cutoff = Date.now() - PARTICIPANT_STALE_MS;
    const stale = this.sql
      .exec(
        `SELECT id, metadata FROM participants WHERE transport = 'rpc' AND connected_at < ?`,
        cutoff
      )
      .toArray();

    for (const row of stale) {
      const pid = row["id"] as string;
      let metadata: Record<string, unknown> = {};
      try {
        metadata = JSON.parse(row["metadata"] as string);
      } catch {
        /* corrupted metadata, use empty default */
      }
      this.sql.exec(`DELETE FROM participants WHERE id = ?`, pid);
      cleanupDeliveryChain(pid);
      await this.failPendingCallsTargeting(pid, "disconnect");
      this.publishPresenceEvent(pid, "leave", metadata, "disconnect");
    }

    if (stale.length > 0) {
      console.log(`[Channel] Evicted ${stale.length} stale RPC participant(s)`);
    }

    // Schedule next cleanup if there are still rpc participants
    this.scheduleParticipantCleanup();
  }

  private scheduleParticipantCleanup(): void {
    this.scheduleNextAlarm();
  }

  // ── Fork support ────────────────────────────────────────────────────────

  /**
   * Called after cloneDO() copies the parent's SQLite.
   * Trims post-fork messages, clears roster and pending calls.
   */
  async postClone(parentChannelId: string, forkPointId: number): Promise<void> {
    // Fix identity: cloneDO copies parent's __objectKey; overwrite with our actual key
    this.sql.exec(
      `INSERT OR REPLACE INTO state (key, value) VALUES ('__objectKey', ?)`,
      this.objectKey
    );
    // RPC identity is automatically updated: the dispatch that calls postClone
    // delivers the clone's fresh instance token via X-Instance-Token header,
    // and fetch() always overwrites identity from headers.
    this.setStateValue("forkedFrom", parentChannelId);
    this.setStateValue("forkPointId", String(forkPointId));
    // Delete messages after fork point
    this.sql.exec(`DELETE FROM messages WHERE id > ?`, forkPointId);
    // Delete inherited presence messages (parent joins/leaves don't replay on fork)
    this.sql.exec(`DELETE FROM messages WHERE type = 'presence'`);
    // Clear roster
    this.sql.exec(`DELETE FROM participants`);
    // Clear pending calls
    this.sql.exec(`DELETE FROM pending_calls`);
    // Clear dedup keys
    this.sql.exec(`DELETE FROM dedup_keys`);
  }

  // ── State introspection ─────────────────────────────────────────────────

  override async getState(): Promise<Record<string, unknown>> {
    const messages = this.sql.exec(`SELECT COUNT(*) as cnt FROM messages`).toArray();
    const participants = this.sql.exec(`SELECT * FROM participants`).toArray();
    const pendingCalls = this.sql.exec(`SELECT * FROM pending_calls`).toArray();
    const state = this.sql.exec(`SELECT * FROM state`).toArray();
    return {
      messageCount: messages[0]?.["cnt"] ?? 0,
      participants,
      pendingCalls,
      state,
    };
  }
}
