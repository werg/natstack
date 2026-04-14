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
import { PARTICIPANT_SESSION_METADATA_KEY } from "@natstack/pubsub/internal-constants";
import type {
  SendOpts,
  SubscribeResult,
  ChannelConfig,
  PresencePayload,
  StoredAttachment,
} from "./types.js";
import {
  broadcast,
  broadcastConfigUpdate,
  sendReady,
  buildChannelEvent,
  parseRowToChannelEvent,
  channelEventToWsJson,
  queueEmit,
  type BroadcastDeps,
  cleanupDeliveryChain,
} from "./broadcast.js";
import { getMessagesBefore } from "./replay.js";
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
/** Maximum replay events returned to DO subscribers. */
const REPLAY_LIMIT = 50;

export class PubSubChannel extends DurableObjectBase {
  static override schemaVersion = 3;

  constructor(ctx: DurableObjectContext, env: unknown) {
    super(ctx, env);
    // Eager init — the DO must be ready before any message arrives.
    this.ensureReady();
  }

  protected createTables(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        persist INTEGER NOT NULL DEFAULT 1,
        content_type TEXT,
        reply_to TEXT,
        sender_metadata TEXT,
        attachments TEXT
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS participants (
        id TEXT PRIMARY KEY,
        metadata TEXT NOT NULL,
        transport TEXT NOT NULL,
        connected_at INTEGER NOT NULL,
        session_id TEXT,
        do_source TEXT,
        do_class TEXT,
        do_key TEXT
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS pending_calls (
        call_id TEXT PRIMARY KEY,
        caller_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        method TEXT NOT NULL,
        args TEXT,
        expires_at INTEGER NOT NULL,
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
    try { this.sql.exec(`ALTER TABLE participants ADD COLUMN session_id TEXT`); } catch { /* already exists */ }
    try { this.sql.exec(`ALTER TABLE participants ADD COLUMN handle TEXT`); } catch { /* already exists */ }
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
    const row = this.sql.exec(
      `SELECT metadata FROM participants WHERE id = ?`, participantId,
    ).toArray();
    if (row.length === 0) return undefined;
    try { return JSON.parse(row[0]!["metadata"] as string); } catch { return undefined; }
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
    try { return JSON.parse(raw); } catch { return null; }
  }

  // ── Presence events ─────────────────────────────────────────────────────

  private publishPresenceEvent(
    senderId: string,
    action: "join" | "leave" | "update",
    metadata: Record<string, unknown>,
    leaveReason?: "graceful" | "disconnect" | "replaced",
    senderRef?: number,
    persist = true,
  ): void {
    const ts = Date.now();
    const payload: PresencePayload = {
      action,
      metadata,
      ...(leaveReason ? { leaveReason } : {}),
    };
    const payloadJson = JSON.stringify(payload);
    const messageId = crypto.randomUUID();

    if (persist) {
      this.sql.exec(
        `INSERT INTO messages (message_id, type, content, sender_id, ts, persist, sender_metadata)
         VALUES (?, 'presence', ?, ?, ?, 1, ?)`,
        messageId, payloadJson, senderId, ts,
        metadata ? JSON.stringify(metadata) : null,
      );
      const id = this.sql.exec(`SELECT last_insert_rowid() as id`).one()["id"] as number;
      const event = buildChannelEvent(id, messageId, "presence", payloadJson, senderId, metadata, ts, true);
      broadcast(this.broadcastDeps, event, { kind: "persisted", ref: senderRef }, senderId);
    } else {
      // Ephemeral: broadcast without persisting to messages table.
      // id: 0 becomes undefined on the wire (channelEventToWsJson: `id: event.id || undefined`),
      // which skips client-side roster dedup (gated on `msg.id !== undefined`).
      const event = buildChannelEvent(0, messageId, "presence", payloadJson, senderId, metadata, ts, false);
      broadcast(this.broadcastDeps, event, { kind: "ephemeral" }, senderId);
    }
  }

  // ── RPC-callable methods ──────────────────────────────────────────────

  /**
   * Subscribe a participant to this channel.
   * Called by panels (via RPC through server relay) and DOs (via RPC call).
   *
   * Two subscriber contracts:
   * - Panel/RPC clients: expect streamed channel:message events for replay, then a ready event.
   * - DO clients: use the returned replay array and process events via onChannelEvent.
   */
  async subscribe(
    participantId: string,
    metadata: Record<string, unknown>,
  ): Promise<SubscribeResult> {
    // Extract DO identity from metadata
    const doSource = metadata["doSource"] as string | undefined;
    const doClass = metadata["doClass"] as string | undefined;
    const doKey = metadata["doKey"] as string | undefined;
    const transport = metadata["transport"] as string ?? "rpc";
    const participantSessionId = typeof metadata[PARTICIPANT_SESSION_METADATA_KEY] === "string"
      ? metadata[PARTICIPANT_SESSION_METADATA_KEY] as string
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
    const handle = typeof metadata["handle"] === "string" ? metadata["handle"] as string : null;
    if (handle) {
      const conflict = this.sql.exec(
        `SELECT id FROM participants WHERE handle = ? AND id != ?`,
        handle, participantId,
      ).toArray();
      if (conflict.length > 0) {
        const otherId = conflict[0]!["id"] as string;
        throw new Error(
          `Participant handle "${handle}" is already in use by another participant ` +
          `(${otherId}) in this channel. Handles must be unique.`,
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
        const name = (m && typeof m === "object" && typeof (m as { name?: unknown }).name === "string")
          ? (m as { name: string }).name
          : null;
        if (name === null) continue; // unknown shape; let downstream handle it
        if (!VALID_METHOD_NAME.test(name) || RESERVED_METHOD_NAMES.has(name)) {
          throw new Error(
            `Invalid method name "${name}" advertised by participant "${participantId}". ` +
            `Method names must match /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/ and ` +
            `not collide with built-in tool names (read, edit, write, grep, find, ls).`,
          );
        }
      }
    }

    // Re-subscribe with the same participant ID: replace the roster entry, but
    // only fail in-flight calls if the underlying client session changed.
    const existing = this.sql.exec(
      `SELECT session_id FROM participants WHERE id = ?`, participantId,
    ).toArray();
    if (existing.length > 0) {
      const previousSessionId = existing[0]!["session_id"] as string | null;
      const oldMetadata = this.getSenderMetadata(participantId) ?? {};
      const replaced =
        previousSessionId == null ||
        participantSessionId == null ||
        previousSessionId !== participantSessionId;
      this.publishPresenceEvent(participantId, "leave", oldMetadata, replaced ? "replaced" : "graceful");
      this.sql.exec(`DELETE FROM participants WHERE id = ?`, participantId);
      cleanupDeliveryChain(participantId);
      if (replaced) {
        const pendingCountRow = this.sql.exec(
          `SELECT COUNT(*) as cnt FROM pending_calls WHERE target_id = ?`,
          participantId,
        ).toArray();
        const pendingCount = (pendingCountRow[0]?.["cnt"] as number) ?? 0;
        console.log(`[Channel] Participant session replaced: target=${participantId} previousSession=${previousSessionId ?? "unknown"} newSession=${participantSessionId ?? "unknown"} pendingCalls=${pendingCount}`);
        await this.failPendingCallsTargeting(participantId, "replaced");
      }
    }

    // Extract replay options before cleaning metadata
    const wantsReplay = !!metadata["replay"];
    const sinceId = metadata["sinceId"] as number | undefined;
    const replayMessageLimit = metadata["replayMessageLimit"] as number | undefined;

    // Clean metadata for storage (remove transport/DO fields and subscribe-time hints)
    const storedMetadata = { ...metadata };
    delete storedMetadata["doSource"];
    delete storedMetadata["doClass"];
    delete storedMetadata["doKey"];
    delete storedMetadata["contextId"];
    delete storedMetadata["channelConfig"];
    delete storedMetadata["replay"];
    delete storedMetadata["sinceId"];
    delete storedMetadata["replayMessageLimit"];
    delete storedMetadata["transport"];
    delete storedMetadata[PARTICIPANT_SESSION_METADATA_KEY];

    this.sql.exec(
      `INSERT INTO participants (id, metadata, transport, connected_at, session_id, do_source, do_class, do_key, handle)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      participantId,
      JSON.stringify(storedMetadata),
      transport === "do" ? "do" : "rpc",
      Date.now(),
      participantSessionId,
      doSource ?? null,
      doClass ?? null,
      doKey ?? null,
      handle,
    );

    // Publish join presence
    this.publishPresenceEvent(participantId, "join", storedMetadata);

    // Build replay for DO callers (returned in result)
    let replay: ChannelEvent[] | undefined;
    let replayTruncated: boolean | undefined;
    if (wantsReplay) {
      const replayRows = this.sql.exec(
        `SELECT id, message_id, type, content, sender_id, ts, sender_metadata, attachments
         FROM messages WHERE type != 'presence' AND persist = 1 ORDER BY id DESC LIMIT ?`,
        REPLAY_LIMIT + 1,
      ).toArray();

      replayTruncated = replayRows.length > REPLAY_LIMIT;
      const rows = replayTruncated ? replayRows.slice(0, REPLAY_LIMIT) : replayRows;
      rows.reverse(); // Back to chronological order

      const events = rows.map(parseRowToChannelEvent);
      if (events.length > 0) replay = events;
    }

    // Stream roster replay + message replay + ready to the subscriber.
    // All three enqueue through the per-subscriber emit chain (not awaited
    // inline — that would deadlock RPC backpressure, since the subscriber is
    // typically parked on this very subscribe call's reply). FIFO order is
    // enforced by `queueEmit`, so `update-message` always lands after its
    // parent `message` and `ready` lands after the whole replay batch.
    this.sendRosterReplay(participantId);
    this.sendMessageReplay(participantId, sinceId, replayMessageLimit);
    sendReady(this.broadcastDeps, participantId, this.sql, this.getStateValue("contextId"), this.getChannelConfig());

    // Schedule stale participant cleanup for RPC participants
    if (transport !== "do") {
      this.scheduleParticipantCleanup();
    }

    return {
      ok: true,
      channelConfig: this.getChannelConfig() ?? undefined,
      replay,
      replayTruncated,
    };
  }

  /**
   * Send roster (presence) replay to a newly subscribed participant via RPC emit.
   * After replaying persisted presence history, emits a snapshot of current
   * participant metadata from the participants table. This ensures transient
   * state (e.g. typing indicators) that was broadcast ephemerally is visible
   * to reconnecting clients.
   */
  private sendRosterReplay(subscriberId: string): void {
    const onFatal = (err: { code?: string }) => {
      if (err?.code === "TARGET_NOT_REACHABLE" || err?.code === "RECONNECT_GRACE_EXPIRED") {
        this.sql.exec(`DELETE FROM participants WHERE id = ?`, subscriberId);
        cleanupDeliveryChain(subscriberId);
      }
    };

    // 1. Replay persisted presence history (join/leave/update events).
    const rows = this.sql.exec(
      `SELECT id, message_id, type, content, sender_id, ts, sender_metadata FROM messages WHERE type = 'presence' ORDER BY id ASC`,
    ).toArray();

    for (const row of rows) {
      const event = parseRowToChannelEvent(row);
      const msg = channelEventToWsJson(event, "replay");
      void queueEmit(this.broadcastDeps, subscriberId, {
        channelId: this.objectKey,
        message: msg,
      }, onFatal);
    }

    // 2. Emit current metadata snapshot from the participants table.
    //    This overrides any stale metadata from replayed events with the
    //    latest state (including ephemeral fields like `typing`).
    const participants = this.sql.exec(
      `SELECT id, metadata FROM participants`,
    ).toArray();
    const ts = Date.now();
    for (const p of participants) {
      const pid = p["id"] as string;
      let metadata: Record<string, unknown>;
      try { metadata = JSON.parse(p["metadata"] as string); } catch { continue; }
      const payload: PresencePayload = { action: "update", metadata };
      const event = buildChannelEvent(
        0, `snapshot_${pid}`, "presence",
        JSON.stringify(payload), pid, metadata, ts, false,
      );
      const msg = channelEventToWsJson(event, "replay");
      void queueEmit(this.broadcastDeps, subscriberId, {
        channelId: this.objectKey,
        message: msg,
      });
    }
  }

  /**
   * Send message replay to a newly subscribed participant via RPC emit.
   * Honors sinceId and replayMessageLimit for reconnect/history.
   */
  private sendMessageReplay(subscriberId: string, sinceId?: number, replayMessageLimit?: number): void {
    let rows: Record<string, unknown>[];

    if (sinceId && sinceId > 0) {
      rows = this.sql.exec(
        `SELECT id, message_id, type, content, sender_id, ts, sender_metadata, attachments
         FROM messages WHERE id > ? AND type != 'presence' ORDER BY id ASC`,
        sinceId,
      ).toArray();
    } else if (replayMessageLimit && replayMessageLimit > 0) {
      // Anchored replay: find the Nth-from-last "message" type row
      const anchorRows = this.sql.exec(
        `SELECT id FROM messages WHERE type = 'message' ORDER BY id DESC LIMIT 1 OFFSET ?`,
        replayMessageLimit - 1,
      ).toArray();

      if (anchorRows.length > 0) {
        const anchorId = anchorRows[0]!["id"] as number;
        rows = this.sql.exec(
          `SELECT id, message_id, type, content, sender_id, ts, sender_metadata, attachments
           FROM messages WHERE id > ? AND type != 'presence' ORDER BY id ASC`,
          anchorId - 1,
        ).toArray();
      } else {
        rows = this.sql.exec(
          `SELECT id, message_id, type, content, sender_id, ts, sender_metadata, attachments
           FROM messages WHERE type != 'presence' ORDER BY id ASC`,
        ).toArray();
      }
    } else {
      return; // No replay requested
    }

    const onFatal = (err: { code?: string }) => {
      if (err?.code === "TARGET_NOT_REACHABLE" || err?.code === "RECONNECT_GRACE_EXPIRED") {
        this.sql.exec(`DELETE FROM participants WHERE id = ?`, subscriberId);
        cleanupDeliveryChain(subscriberId);
      }
    };
    for (const row of rows) {
      const event = parseRowToChannelEvent(row);
      const msg = channelEventToWsJson(event, "replay");
      void queueEmit(this.broadcastDeps, subscriberId, {
        channelId: this.objectKey,
        message: msg,
      }, onFatal);
    }
  }

  /**
   * Unsubscribe a participant from this channel.
   */
  async unsubscribe(participantId: string): Promise<void> {
    const metadata = this.getSenderMetadata(participantId) ?? {};

    this.sql.exec(`DELETE FROM participants WHERE id = ?`, participantId);
    cleanupDeliveryChain(participantId);
    await this.failPendingCallsTargeting(participantId, "graceful");
    this.publishPresenceEvent(participantId, "leave", metadata, "graceful");
  }

  /**
   * Cancel any pending tool calls targeting a participant that's leaving the
   * channel. Each affected caller gets a synthetic "target left" error result
   * delivered via the normal result path, so the harness's pendingToolResults
   * map fails with a meaningful error rather than hanging until the harness
   * stall warning fires.
   */
  private async failPendingCallsTargeting(
    targetId: string,
    reason: "graceful" | "disconnect" | "replaced",
  ): Promise<void> {
    const cancelled = cancelCallsForTarget(this.sql, targetId);
    if (cancelled.length === 0) return;
    const errorMessage = reason === "graceful"
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
    console.log(`[Channel] Cancelled ${cancelled.length} pending call(s) targeting ${targetId} (${reason})`);
  }

  /**
   * Heartbeat from an RPC participant. Updates connected_at to prevent stale eviction.
   * Panels should call this periodically (e.g., every 60s).
   */
  async touch(participantId: string): Promise<void> {
    this.sql.exec(
      `UPDATE participants SET connected_at = ? WHERE id = ?`,
      Date.now(), participantId,
    );
  }

  /**
   * Send a new message (from any participant).
   */
  async send(
    participantId: string,
    messageId: string,
    content: string,
    opts?: SendOpts,
  ): Promise<void> {
    // Phase 0B: Idempotency check
    const idempotencyKey = opts?.idempotencyKey;
    if (idempotencyKey) {
      const existing = this.sql.exec(
        `SELECT result_id FROM dedup_keys WHERE key = ?`, idempotencyKey,
      ).toArray();
      if (existing.length > 0) {
        return;
      }
    }

    const ts = Date.now();
    const persist = opts?.persist !== false;
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

    if (persist) {
      this.sql.exec(
        `INSERT INTO messages (message_id, type, content, sender_id, ts, persist, content_type, reply_to, sender_metadata)
         VALUES (?, 'message', ?, ?, ?, 1, ?, ?, ?)`,
        messageId, payloadJson, participantId, ts,
        contentType ?? null, replyTo ?? null,
        senderMetadata ? JSON.stringify(senderMetadata) : null,
      );
      const id = this.sql.exec(`SELECT last_insert_rowid() as id`).one()["id"] as number;

      if (idempotencyKey) {
        this.sql.exec(
          `INSERT OR IGNORE INTO dedup_keys (key, result_id, created_at) VALUES (?, ?, ?)`,
          idempotencyKey, id, Date.now(),
        );
        this.scheduleDedupCleanup();
      }

      const event = buildChannelEvent(id, messageId, "message", payloadJson, participantId, senderMetadata, ts, true);
      broadcast(this.broadcastDeps, event, { kind: "persisted" }, participantId);
    } else {
      if (idempotencyKey) {
        this.sql.exec(
          `INSERT OR IGNORE INTO dedup_keys (key, result_id, created_at) VALUES (?, ?, ?)`,
          idempotencyKey, null, Date.now(),
        );
        this.scheduleDedupCleanup();
      }

      const event = buildChannelEvent(0, messageId, "message", payloadJson, participantId, senderMetadata, ts, false);
      broadcast(this.broadcastDeps, event, { kind: "ephemeral" }, participantId);
    }
  }

  /**
   * Publish a typed message (from any participant).
   * This is the generic publish method used by panel clients for all message types.
   */
  async publish(
    participantId: string,
    type: string,
    payload: unknown,
    opts?: { persist?: boolean; ref?: number; senderMetadata?: Record<string, unknown>; attachments?: StoredAttachment[]; idempotencyKey?: string },
  ): Promise<{ id?: number }> {
    const ts = Date.now();
    const persist = opts?.persist !== false;
    const ref = opts?.ref;
    const attachments = opts?.attachments;

    // Intercept method-result only if there's a matching pending DO-initiated call
    // AND the result is complete (not a streaming partial like console chunks).
    if (type === "method-result" && payload && typeof payload === "object") {
      const p = payload as Record<string, unknown>;
      const callId = p["callId"] as string;
      const isComplete = p["complete"] !== false;
      if (callId && isComplete) {
        const pending = this.sql.exec(
          `SELECT call_id FROM pending_calls WHERE call_id = ?`, callId,
        ).toArray();
        if (pending.length > 0) {
          await this.handleMethodResult(callId, p["content"], !!p["isError"]);
          return { id: undefined };
        }
        // No pending call — fall through to normal broadcast
      }
    }

    // Phase 0B: Idempotency check
    const idempotencyKey = opts?.idempotencyKey;
    if (idempotencyKey) {
      const existing = this.sql.exec(
        `SELECT result_id FROM dedup_keys WHERE key = ?`, idempotencyKey,
      ).toArray();
      if (existing.length > 0) {
        return { id: existing[0]!["result_id"] as number | undefined };
      }
    }

    let payloadJson: string;
    try { payloadJson = JSON.stringify(payload); }
    catch { throw new Error("payload not serializable"); }

    const senderMetadata = this.getSenderMetadata(participantId) ?? opts?.senderMetadata;

    // Extract messageId from payload
    const payloadObj = typeof payload === "object" && payload !== null
      ? payload as Record<string, unknown>
      : null;
    const messageId = (payloadObj?.["id"] as string) ?? crypto.randomUUID();

    if (persist) {
      this.sql.exec(
        `INSERT INTO messages (message_id, type, content, sender_id, ts, persist, sender_metadata, attachments)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
        messageId, type, payloadJson, participantId, ts,
        senderMetadata ? JSON.stringify(senderMetadata) : null,
        attachments ? JSON.stringify(attachments) : null,
      );
      const id = this.sql.exec(`SELECT last_insert_rowid() as id`).one()["id"] as number;

      if (idempotencyKey) {
        this.sql.exec(
          `INSERT OR IGNORE INTO dedup_keys (key, result_id, created_at) VALUES (?, ?, ?)`,
          idempotencyKey, id, Date.now(),
        );
        this.scheduleDedupCleanup();
      }

      const event = buildChannelEvent(id, messageId, type, payloadJson, participantId, senderMetadata, ts, true, attachments);
      broadcast(this.broadcastDeps, event, { kind: "persisted", ref }, participantId);
      return { id };
    } else {
      if (idempotencyKey) {
        this.sql.exec(
          `INSERT OR IGNORE INTO dedup_keys (key, result_id, created_at) VALUES (?, ?, ?)`,
          idempotencyKey, null, Date.now(),
        );
        this.scheduleDedupCleanup();
      }

      const event = buildChannelEvent(0, messageId, type, payloadJson, participantId, senderMetadata, ts, false, attachments);
      broadcast(this.broadcastDeps, event, { kind: "ephemeral", ref }, participantId);
      return { id: undefined };
    }
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
    opts?: { append?: boolean },
  ): Promise<void> {
    // Phase 0B: Idempotency check
    if (idempotencyKey) {
      const existing = this.sql.exec(
        `SELECT result_id FROM dedup_keys WHERE key = ?`, idempotencyKey,
      ).toArray();
      if (existing.length > 0) {
        return;
      }
    }

    const ts = Date.now();

    const senderMetadata = this.getSenderMetadata(participantId);

    const payload: Record<string, unknown> = { id: messageId, content };
    if (opts?.append) payload["append"] = true;
    const payloadJson = JSON.stringify(payload);

    this.sql.exec(
      `INSERT INTO messages (message_id, type, content, sender_id, ts, persist, sender_metadata)
       VALUES (?, 'update-message', ?, ?, ?, 1, ?)`,
      messageId, payloadJson, participantId, ts,
      senderMetadata ? JSON.stringify(senderMetadata) : null,
    );
    const id = this.sql.exec(`SELECT last_insert_rowid() as id`).one()["id"] as number;

    if (idempotencyKey) {
      this.sql.exec(
        `INSERT OR IGNORE INTO dedup_keys (key, result_id, created_at) VALUES (?, ?, ?)`,
        idempotencyKey, id, Date.now(),
      );
      this.scheduleDedupCleanup();
    }

    const event = buildChannelEvent(id, messageId, "update-message", payloadJson, participantId, senderMetadata, ts, true);
    broadcast(this.broadcastDeps, event, { kind: "persisted" }, participantId);
  }

  /**
   * Complete (finalize) a message (from a participant).
   */
  async complete(
    participantId: string,
    messageId: string,
    idempotencyKey?: string,
  ): Promise<void> {
    // Phase 0B: Idempotency check
    if (idempotencyKey) {
      const existing = this.sql.exec(
        `SELECT result_id FROM dedup_keys WHERE key = ?`, idempotencyKey,
      ).toArray();
      if (existing.length > 0) {
        return;
      }
    }

    const ts = Date.now();

    const senderMetadata = this.getSenderMetadata(participantId);

    // complete uses type "update-message" with { id, complete: true } — matches PubSub server wire format
    const payload = { id: messageId, complete: true };
    const payloadJson = JSON.stringify(payload);

    this.sql.exec(
      `INSERT INTO messages (message_id, type, content, sender_id, ts, persist, sender_metadata)
       VALUES (?, 'update-message', ?, ?, ?, 1, ?)`,
      messageId, payloadJson, participantId, ts,
      senderMetadata ? JSON.stringify(senderMetadata) : null,
    );
    const id = this.sql.exec(`SELECT last_insert_rowid() as id`).one()["id"] as number;

    if (idempotencyKey) {
      this.sql.exec(
        `INSERT OR IGNORE INTO dedup_keys (key, result_id, created_at) VALUES (?, ?, ?)`,
        idempotencyKey, id, Date.now(),
      );
      this.scheduleDedupCleanup();
    }

    const event = buildChannelEvent(id, messageId, "update-message", payloadJson, participantId, senderMetadata, ts, true);
    broadcast(this.broadcastDeps, event, { kind: "persisted" }, participantId);
  }

  /**
   * Phase 2A: Return persisted events in a sequence range (for gap repair).
   * Returns events where fromSeq < id <= toSeq, ordered ascending.
   */
  async getEventRange(fromSeq: number, toSeq: number): Promise<ChannelEvent[]> {
    const rows = this.sql.exec(
      `SELECT id, message_id, type, content, sender_id, ts, sender_metadata, attachments
       FROM messages WHERE id > ? AND id <= ? AND persist = 1 ORDER BY id ASC`,
      fromSeq, toSeq,
    ).toArray();
    return rows.map(parseRowToChannelEvent);
  }

  /**
   * Send an ephemeral message (from a participant).
   */
  async sendEphemeral(
    participantId: string,
    content: string,
    contentType?: string,
  ): Promise<void> {
    const ts = Date.now();
    const messageId = `eph_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const senderMetadata = this.getSenderMetadata(participantId);

    const payload: Record<string, unknown> = { id: messageId, content };
    if (contentType) payload["contentType"] = contentType;
    const payloadJson = JSON.stringify(payload);

    const event = buildChannelEvent(0, messageId, "message", payloadJson, participantId, senderMetadata, ts, false);
    broadcast(this.broadcastDeps, event, { kind: "ephemeral" }, participantId);
  }

  /**
   * Replace a participant's metadata entirely.
   */
  async updateMetadata(
    participantId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    this.sql.exec(
      `UPDATE participants SET metadata = ? WHERE id = ?`,
      JSON.stringify(metadata), participantId,
    );
    this.publishPresenceEvent(participantId, "update", metadata);
  }

  /**
   * Set a participant's typing state. Updates the participants table (so
   * reconnecting clients see current state) but broadcasts ephemerally
   * (no row inserted into the messages table).
   */
  async setTypingState(participantId: string, typing: boolean): Promise<void> {
    const rows = this.sql.exec(
      `SELECT metadata FROM participants WHERE id = ?`,
      participantId,
    ).toArray();
    if (rows.length === 0) return;
    const final = { ...JSON.parse(rows[0]!["metadata"] as string), typing };
    this.sql.exec(
      `UPDATE participants SET metadata = ? WHERE id = ?`,
      JSON.stringify(final), participantId,
    );
    this.publishPresenceEvent(participantId, "update", final, undefined, undefined, false);
  }

  /**
   * Get all participants with DO identity when available.
   */
  async getParticipants(): Promise<Array<{
    participantId: string;
    metadata: Record<string, unknown>;
    transport: string;
    doRef?: { source: string; className: string; objectKey: string };
  }>> {
    const rows = this.sql.exec(
      `SELECT id, metadata, transport, do_source, do_class, do_key FROM participants`,
    ).toArray();
    return rows.map(row => {
      const entry: {
        participantId: string;
        metadata: Record<string, unknown>;
        transport: string;
        doRef?: { source: string; className: string; objectKey: string };
      } = {
        participantId: row["id"] as string,
        metadata: JSON.parse(row["metadata"] as string),
        transport: row["transport"] as string,
      };
      const doSource = row["do_source"] as string | null;
      const doClass = row["do_class"] as string | null;
      const doKey = row["do_key"] as string | null;
      if (doSource && doClass && doKey) {
        entry.doRef = { source: doSource, className: doClass, objectKey: doKey };
      }
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
    broadcastConfigUpdate(this.broadcastDeps, newConfig);
    return newConfig;
  }

  /**
   * Get messages before a given ID (for pagination).
   */
  async getMessagesBefore(beforeId: number, limit?: number): Promise<{
    messages: Array<{ id: number; type: string; payload: unknown; senderId: string; ts: number; senderMetadata?: Record<string, unknown>; attachments?: unknown[] }>;
    hasMore: boolean;
    trailingUpdates: Array<{ id: number; type: string; payload: unknown; senderId: string; ts: number; senderMetadata?: Record<string, unknown> }>;
  }> {
    return getMessagesBefore(this.sql, beforeId, limit ?? 100);
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
    args: unknown,
  ): Promise<void> {
    storeCall(this.sql, callId, callerPid, targetPid, method, args);
    this.scheduleNextAlarm();

    // Deliver to target
    const target = this.sql.exec(
      `SELECT transport, do_source, do_class, do_key FROM participants WHERE id = ?`,
      targetPid,
    ).toArray();

    if (target.length === 0) {
      // Target not found — deliver error to caller
      this.sql.exec(`DELETE FROM pending_calls WHERE call_id = ?`, callId);
      await this.deliverCallResult(callerPid, callId, { error: `Target ${targetPid} not found` }, true);
      return;
    }

    const t = target[0]!;
    if (t["transport"] === "do") {
      // Deliver to DO target via RPC call
      try {
        const result = await this.rpc.call(
          targetPid,
          "onMethodCall",
          this.objectKey,
          callId,
          method,
          args,
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
          await this.deliverCallResult(callerPid, callId, err instanceof Error ? err.message : String(err), true);
        }
      }
    } else {
      // RPC target — emit method-call as ephemeral channel message
      const payload = { callId, providerId: targetPid, methodName: method, args };
      const senderMetadata = this.getSenderMetadata(callerPid);
      const ts = Date.now();
      const event: ChannelEvent = {
        id: 0, messageId: "", type: "method-call",
        payload, senderId: callerPid, senderMetadata, ts, persist: false,
      };
      const msg = channelEventToWsJson(event, "ephemeral");
      // Emit to all participants via RPC (the client filters by providerId === self)
      const participants = this.sql.exec(`SELECT id FROM participants`).toArray();
      const data = { channelId: this.objectKey, message: msg };
      for (const p of participants) {
        const pid = p["id"] as string;
        this.rpc.emit(pid, "channel:message", data).catch(err => {
          const code = (err as { code?: string })?.code;
          if (code === "TARGET_NOT_REACHABLE" || code === "RECONNECT_GRACE_EXPIRED") {
            this.sql.exec(`DELETE FROM participants WHERE id = ?`, pid);
            cleanupDeliveryChain(pid);
          }
        });
      }
    }
  }

  /**
   * Handle a method result from a participant.
   */
  async handleMethodResult(callId: string, content: unknown, isError: boolean): Promise<void> {
    const pending = consumeCall(this.sql, callId);
    if (!pending) return;
    await this.deliverCallResult(pending.callerId, callId, content, isError);
    this.scheduleNextAlarm();
  }

  /**
   * Cancel a pending method call.
   */
  async cancelMethodCall(callId: string): Promise<void> {
    // Look up the provider before deleting the call
    const call = this.sql.exec(
      `SELECT target_id FROM pending_calls WHERE call_id = ?`, callId,
    ).toArray();
    cancelCallDb(this.sql, callId);
    this.scheduleNextAlarm();
    // Notify the provider so it can abort the executing method
    if (call.length > 0) {
      const providerId = call[0]!["target_id"] as string;
      this.rpc.emit(providerId, "channel:message", {
        channelId: this.objectKey,
        message: { kind: "ephemeral", type: "method-cancel", payload: { callId }, senderId: "system", ts: Date.now() },
      }).catch((err) => { console.warn("[Channel] cancel emit failed:", err); });
    }
  }

  private async deliverCallResult(
    callerId: string,
    callId: string,
    result: unknown,
    isError: boolean,
  ): Promise<void> {
    const caller = this.sql.exec(
      `SELECT transport, do_source, do_class, do_key FROM participants WHERE id = ?`,
      callerId,
    ).toArray();

    if (caller.length === 0) return;

    const c = caller[0]!;
    if (c["transport"] === "do") {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await this.rpc.call(
            callerId,
            "onCallResult",
            callId,
            result,
            isError,
          );
          break; // Success
        } catch (err) {
          console.error(`[Channel] Failed to deliver call result to ${callerId} (attempt ${attempt + 1}/3):`, err);
          if (attempt < 2) {
            await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
          }
        }
      }
    }

    // Persist and broadcast result as a normal channel message so provider-side
    // clients can clear pending tool state even when the actual caller is a DO.
    const ts = Date.now();
    const payload = { callId, content: result, complete: true, isError: isError ?? false };
    const payloadJson = JSON.stringify(payload);
    const messageId = crypto.randomUUID();

    this.sql.exec(
      `INSERT INTO messages (message_id, type, content, sender_id, ts, persist, sender_metadata)
       VALUES (?, 'method-result', ?, ?, ?, 1, NULL)`,
      messageId, payloadJson, callerId, ts,
    );
    const id = this.sql.exec(`SELECT last_insert_rowid() as id`).one()["id"] as number;

    const event: ChannelEvent = {
      id, messageId, type: "method-result",
      payload, senderId: callerId, ts, persist: true,
    };
    const msg = channelEventToWsJson(event, "persisted");
    const participants = this.sql.exec(`SELECT id FROM participants`).toArray();
    const data = { channelId: this.objectKey, message: msg };
    for (const p of participants) {
      const pid = p["id"] as string;
      this.rpc.emit(pid, "channel:message", data).catch(err => {
        const code = (err as { code?: string })?.code;
        if (code === "TARGET_NOT_REACHABLE" || code === "RECONNECT_GRACE_EXPIRED") {
          this.sql.exec(`DELETE FROM participants WHERE id = ?`, pid);
          cleanupDeliveryChain(pid);
        }
      });
    }
  }

  /**
   * Unified alarm scheduler — computes the minimum next alarm time across all
   * alarm sources (dedup cleanup, participant cleanup) to avoid one source
   * overwriting another's sooner alarm.
   *
   * Method calls intentionally have no wall-clock timeout — agentic activities
   * can run for arbitrary lengths. Pending calls are cancelled by roster events
   * (see cancelCallsForTarget) when a target participant leaves.
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
    const rpcCount = this.sql.exec(
      `SELECT COUNT(*) as cnt FROM participants WHERE transport = 'rpc'`,
    ).toArray();
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
    const stale = this.sql.exec(
      `SELECT id, metadata FROM participants WHERE transport = 'rpc' AND connected_at < ?`,
      cutoff,
    ).toArray();

    for (const row of stale) {
      const pid = row["id"] as string;
      let metadata: Record<string, unknown> = {};
      try { metadata = JSON.parse(row["metadata"] as string); } catch { /* corrupted metadata, use empty default */ }
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
      this.objectKey,
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
