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
import type {
  SendOpts,
  SubscribeResult,
  ChannelConfig,
  PresencePayload,
  ServerMessage,
  StoredAttachment,
} from "./types.js";
import {
  broadcast,
  broadcastConfigUpdate,
  sendReady,
  buildChannelEvent,
  type BroadcastDeps,
} from "./broadcast.js";
import { getMessagesBefore } from "./replay.js";
import { storeCall, consumeCall, cancelCall as cancelCallDb, getNextExpiry, expireCalls } from "./method-calls.js";

/** How long before an RPC participant is considered stale (no heartbeat). */
const PARTICIPANT_STALE_MS = 5 * 60 * 1000; // 5 minutes
/** How often to check for stale participants. */
const PARTICIPANT_CLEANUP_INTERVAL_MS = 60 * 1000; // 1 minute

export class PubSubChannel extends DurableObjectBase {
  static override schemaVersion = 1;

  /** Counter for generating unique attachment IDs. */
  private nextAttachmentId = 1;

  constructor(ctx: DurableObjectContext, env: unknown) {
    super(ctx, env);
    // Eager init — the DO must be ready before any message arrives.
    this.ensureReady();
    // Restore attachment counter
    this.restoreAttachmentCounter();
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
  }

  private restoreAttachmentCounter(): void {
    // Find max existing attachment ID number to continue from
    const rows = this.sql.exec(
      `SELECT attachments FROM messages WHERE attachments IS NOT NULL`,
    ).toArray();
    let maxId = 0;
    for (const row of rows) {
      try {
        const atts = JSON.parse(row["attachments"] as string) as StoredAttachment[];
        for (const att of atts) {
          const match = att.id.match(/^img_(\d+)$/);
          if (match) maxId = Math.max(maxId, parseInt(match[1]!, 10));
        }
      } catch { /* ignore */ }
    }
    this.nextAttachmentId = maxId + 1;
  }

  private generateAttachmentId(): string {
    return `img_${this.nextAttachmentId++}`;
  }

  // ── Broadcast deps ──────────────────────────────────────────────────────

  private get broadcastDeps(): BroadcastDeps {
    return {
      sql: this.sql,
      rpc: this.rpc,
      objectKey: this.objectKey,
    };
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

  private getMessageCount(): number {
    const row = this.sql.exec(`SELECT COUNT(*) as cnt FROM messages`).toArray();
    return (row[0]?.["cnt"] as number) ?? 0;
  }

  // ── Presence events ─────────────────────────────────────────────────────

  private publishPresenceEvent(
    senderId: string,
    action: "join" | "leave" | "update",
    metadata: Record<string, unknown>,
    leaveReason?: "graceful" | "disconnect",
    senderRef?: number,
  ): void {
    const ts = Date.now();
    const payload: PresencePayload = {
      action,
      metadata,
      ...(leaveReason ? { leaveReason } : {}),
    };
    const payloadJson = JSON.stringify(payload);
    const messageId = crypto.randomUUID();

    this.sql.exec(
      `INSERT INTO messages (message_id, type, content, sender_id, ts, persist, sender_metadata)
       VALUES (?, 'presence', ?, ?, ?, 1, ?)`,
      messageId, payloadJson, senderId, ts,
      metadata ? JSON.stringify(metadata) : null,
    );
    const id = this.sql.exec(`SELECT last_insert_rowid() as id`).one()["id"] as number;

    const serverMsg: ServerMessage = {
      kind: "persisted", id, type: "presence", payload, senderId, ts, senderMetadata: metadata,
    };
    const event = buildChannelEvent(id, messageId, "presence", payloadJson, senderId, metadata, ts, true);
    broadcast(this.broadcastDeps, serverMsg, event, senderId, senderRef);
  }

  // ── RPC-callable methods ──────────────────────────────────────────────

  /**
   * Subscribe a participant to this channel.
   * Called by panels (via RPC through server relay) and DOs (via RPC call).
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

    // Extract contextId from metadata
    const contextId = metadata["contextId"] as string | undefined;
    const channelConfigRaw = metadata["channelConfig"] as Record<string, unknown> | undefined;

    // Initialize channel if contextId provided
    if (contextId) {
      this.initChannel(contextId, channelConfigRaw);
    }

    // Idempotent: remove old entry, publish leave, then re-register
    const existing = this.sql.exec(
      `SELECT id FROM participants WHERE id = ?`, participantId,
    ).toArray();
    if (existing.length > 0) {
      const oldMeta = this.sql.exec(
        `SELECT metadata FROM participants WHERE id = ?`, participantId,
      ).toArray();
      const oldMetadata = oldMeta.length > 0
        ? JSON.parse(oldMeta[0]!["metadata"] as string)
        : {};
      this.publishPresenceEvent(participantId, "leave", oldMetadata, "graceful");
      this.sql.exec(`DELETE FROM participants WHERE id = ?`, participantId);
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

    this.sql.exec(
      `INSERT INTO participants (id, metadata, transport, connected_at, do_source, do_class, do_key)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      participantId,
      JSON.stringify(storedMetadata),
      transport === "do" ? "do" : "rpc",
      Date.now(),
      doSource ?? null,
      doClass ?? null,
      doKey ?? null,
    );

    // Publish join presence
    this.publishPresenceEvent(participantId, "join", storedMetadata);

    // Build replay for the subscriber
    let replay: ChannelEvent[] | undefined;
    if (wantsReplay) {
      const replayRows = this.sql.exec(
        `SELECT id, message_id, type, content, sender_id, ts, sender_metadata, attachments
         FROM messages WHERE type != 'presence' AND persist = 1 ORDER BY id ASC`,
      ).toArray();

      const events: ChannelEvent[] = replayRows.map((row) =>
        buildChannelEvent(
          row["id"] as number,
          row["message_id"] as string,
          row["type"] as string,
          row["content"] as string,
          row["sender_id"] as string,
          row["sender_metadata"] ? JSON.parse(row["sender_metadata"] as string) : undefined,
          row["ts"] as number,
          true,
          row["attachments"] ? JSON.parse(row["attachments"] as string) : undefined,
        ),
      );
      if (events.length > 0) replay = events;
    }

    // Send roster replay + message replay + ready via RPC events
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
    };
  }

  /**
   * Send roster (presence) replay to a newly subscribed participant.
   */
  private sendRosterReplay(subscriberId: string): void {
    const rows = this.sql.exec(
      `SELECT id, type, content, sender_id, ts, sender_metadata FROM messages WHERE type = 'presence' ORDER BY id ASC`,
    ).toArray();

    for (const row of rows) {
      let payload: unknown;
      try { payload = JSON.parse(row["content"] as string); } catch { payload = row["content"]; }
      let senderMetadata: Record<string, unknown> | undefined;
      if (row["sender_metadata"]) {
        try { senderMetadata = JSON.parse(row["sender_metadata"] as string); } catch { /* ignore */ }
      }

      this.rpc.emit(subscriberId, "channel:message", {
        channelId: this.objectKey,
        message: {
          kind: "replay",
          id: row["id"] as number,
          type: row["type"] as string,
          payload,
          senderId: row["sender_id"] as string,
          ts: row["ts"] as number,
          senderMetadata,
        },
      }).catch(err => console.warn(`[Channel] emit failed:`, err));
    }
  }

  /**
   * Send message replay to a newly subscribed participant.
   */
  private sendMessageReplay(subscriberId: string, sinceId?: number, replayMessageLimit?: number): void {
    let rows: Record<string, unknown>[];

    if (sinceId && sinceId > 0) {
      rows = this.sql.exec(
        `SELECT id, type, content, sender_id, ts, sender_metadata, attachments
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
          `SELECT id, type, content, sender_id, ts, sender_metadata, attachments
           FROM messages WHERE id > ? AND type != 'presence' ORDER BY id ASC`,
          anchorId - 1,
        ).toArray();
      } else {
        // Fewer than N messages — full replay
        rows = this.sql.exec(
          `SELECT id, type, content, sender_id, ts, sender_metadata, attachments
           FROM messages WHERE type != 'presence' ORDER BY id ASC`,
        ).toArray();
      }
    } else {
      return; // No replay requested
    }

    for (const row of rows) {
      let payload: unknown;
      try { payload = JSON.parse(row["content"] as string); } catch { payload = row["content"]; }
      let senderMetadata: Record<string, unknown> | undefined;
      if (row["sender_metadata"]) {
        try { senderMetadata = JSON.parse(row["sender_metadata"] as string); } catch { /* ignore */ }
      }
      let attachments: StoredAttachment[] | undefined;
      if (row["attachments"]) {
        try { attachments = JSON.parse(row["attachments"] as string); } catch { /* ignore */ }
      }

      this.rpc.emit(subscriberId, "channel:message", {
        channelId: this.objectKey,
        message: {
          kind: "replay" as const,
          id: row["id"] as number,
          type: row["type"] as string,
          payload,
          senderId: row["sender_id"] as string,
          ts: row["ts"] as number,
          senderMetadata,
          attachments,
        },
      }).catch(err => console.warn(`[Channel] emit failed:`, err));
    }
  }

  /**
   * Unsubscribe a participant from this channel.
   */
  async unsubscribe(participantId: string): Promise<void> {
    const metaRow = this.sql.exec(
      `SELECT metadata FROM participants WHERE id = ?`, participantId,
    ).toArray();
    const metadata = metaRow.length > 0
      ? JSON.parse(metaRow[0]!["metadata"] as string)
      : {};

    this.sql.exec(`DELETE FROM participants WHERE id = ?`, participantId);
    this.publishPresenceEvent(participantId, "leave", metadata, "graceful");
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
    const ts = Date.now();
    const persist = opts?.persist !== false;
    const contentType = opts?.contentType;
    const replyTo = opts?.replyTo;

    // Get sender metadata
    const metaRow = this.sql.exec(
      `SELECT metadata FROM participants WHERE id = ?`, participantId,
    ).toArray();
    const senderMetadata = metaRow.length > 0
      ? JSON.parse(metaRow[0]!["metadata"] as string)
      : opts?.senderMetadata;

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

      const serverMsg: ServerMessage = {
        kind: "persisted", id, type: "message", payload, senderId: participantId, ts, senderMetadata,
      };
      const event = buildChannelEvent(id, messageId, "message", payloadJson, participantId, senderMetadata, ts, true);
      broadcast(this.broadcastDeps, serverMsg, event, participantId);
    } else {
      const serverMsg: ServerMessage = {
        kind: "ephemeral", type: "message", payload, senderId: participantId, ts, senderMetadata,
      };
      const event = buildChannelEvent(0, messageId, "message", payloadJson, participantId, senderMetadata, ts, false);
      broadcast(this.broadcastDeps, serverMsg, event, participantId);
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
    opts?: { persist?: boolean; ref?: number; senderMetadata?: Record<string, unknown>; attachments?: StoredAttachment[] },
  ): Promise<{ id?: number }> {
    const ts = Date.now();
    const persist = opts?.persist !== false;
    const ref = opts?.ref;
    const attachments = opts?.attachments;

    // Intercept method-result only if there's a matching pending DO-initiated call
    if (type === "method-result" && payload && typeof payload === "object") {
      const p = payload as Record<string, unknown>;
      const callId = p["callId"] as string;
      if (callId) {
        const pending = this.sql.exec(
          `SELECT call_id FROM pending_calls WHERE call_id = ?`, callId,
        ).toArray();
        if (pending.length > 0) {
          this.handleMethodResult(callId, p["content"], !!p["isError"]);
          return { id: undefined };
        }
        // No pending call — fall through to normal broadcast
      }
    }

    let payloadJson: string;
    try { payloadJson = JSON.stringify(payload); }
    catch { throw new Error("payload not serializable"); }

    // Get sender metadata
    const metaRow = this.sql.exec(
      `SELECT metadata FROM participants WHERE id = ?`, participantId,
    ).toArray();
    const senderMetadata = metaRow.length > 0
      ? JSON.parse(metaRow[0]!["metadata"] as string)
      : opts?.senderMetadata;

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

      const serverMsg: ServerMessage = {
        kind: "persisted", id, type, payload, senderId: participantId, ts, senderMetadata,
        ...(attachments ? { attachments } : {}),
      };
      const event = buildChannelEvent(id, messageId, type, payloadJson, participantId, senderMetadata, ts, true, attachments);
      broadcast(this.broadcastDeps, serverMsg, event, participantId, ref);
      return { id };
    } else {
      const serverMsg: ServerMessage = {
        kind: "ephemeral", type, payload, senderId: participantId, ts, senderMetadata,
        ...(attachments ? { attachments } : {}),
      };
      const event = buildChannelEvent(0, messageId, type, payloadJson, participantId, senderMetadata, ts, false, attachments);
      broadcast(this.broadcastDeps, serverMsg, event, participantId, ref);
      return { id: undefined };
    }
  }

  /**
   * Update an existing message (from a participant).
   */
  async update(
    participantId: string,
    messageId: string,
    content: string,
  ): Promise<void> {
    const ts = Date.now();

    const metaRow = this.sql.exec(
      `SELECT metadata FROM participants WHERE id = ?`, participantId,
    ).toArray();
    const senderMetadata = metaRow.length > 0
      ? JSON.parse(metaRow[0]!["metadata"] as string)
      : undefined;

    const payload = { id: messageId, content };
    const payloadJson = JSON.stringify(payload);

    this.sql.exec(
      `INSERT INTO messages (message_id, type, content, sender_id, ts, persist, sender_metadata)
       VALUES (?, 'update-message', ?, ?, ?, 1, ?)`,
      messageId, payloadJson, participantId, ts,
      senderMetadata ? JSON.stringify(senderMetadata) : null,
    );
    const id = this.sql.exec(`SELECT last_insert_rowid() as id`).one()["id"] as number;

    const serverMsg: ServerMessage = {
      kind: "persisted", id, type: "update-message", payload, senderId: participantId, ts, senderMetadata,
    };
    const event = buildChannelEvent(id, messageId, "update-message", payloadJson, participantId, senderMetadata, ts, true);
    broadcast(this.broadcastDeps, serverMsg, event, participantId);
  }

  /**
   * Complete (finalize) a message (from a participant).
   */
  async complete(
    participantId: string,
    messageId: string,
  ): Promise<void> {
    const ts = Date.now();

    const metaRow = this.sql.exec(
      `SELECT metadata FROM participants WHERE id = ?`, participantId,
    ).toArray();
    const senderMetadata = metaRow.length > 0
      ? JSON.parse(metaRow[0]!["metadata"] as string)
      : undefined;

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

    const serverMsg: ServerMessage = {
      kind: "persisted", id, type: "update-message", payload, senderId: participantId, ts, senderMetadata,
    };
    const event = buildChannelEvent(id, messageId, "update-message", payloadJson, participantId, senderMetadata, ts, true);
    broadcast(this.broadcastDeps, serverMsg, event, participantId);
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

    const metaRow = this.sql.exec(
      `SELECT metadata FROM participants WHERE id = ?`, participantId,
    ).toArray();
    const senderMetadata = metaRow.length > 0
      ? JSON.parse(metaRow[0]!["metadata"] as string)
      : undefined;

    const payload: Record<string, unknown> = { id: messageId, content };
    if (contentType) payload["contentType"] = contentType;
    const payloadJson = JSON.stringify(payload);

    const serverMsg: ServerMessage = {
      kind: "ephemeral", type: "message", payload, senderId: participantId, ts, senderMetadata,
    };
    const event = buildChannelEvent(0, messageId, "message", payloadJson, participantId, senderMetadata, ts, false);
    broadcast(this.broadcastDeps, serverMsg, event, participantId);
  }

  /**
   * Update a participant's metadata.
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
    messages: ServerMessage["messages"];
    hasMore: boolean;
    trailingUpdates: ServerMessage["trailingUpdates"];
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
    const expiresAt = storeCall(this.sql, callId, callerPid, targetPid, method, args);
    this.rescheduleCallTimeout();

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
      // Format must match what the PubSub client expects: { callId, providerId, methodName, args }
      const payload = { callId, providerId: targetPid, methodName: method, args };
      const callerMeta = this.sql.exec(`SELECT metadata FROM participants WHERE id = ?`, callerPid).toArray();
      const senderMetadata = callerMeta.length > 0 ? JSON.parse(callerMeta[0]!["metadata"] as string) : undefined;
      const serverMsg: ServerMessage = {
        kind: "ephemeral", type: "method-call", payload, senderId: callerPid, ts: Date.now(), senderMetadata,
      };
      // Emit to all participants via RPC (the client filters by providerId === self)
      const participants = this.sql.exec(`SELECT id FROM participants`).toArray();
      const data = { channelId: this.objectKey, message: serverMsg };
      for (const p of participants) {
        this.rpc.emit(p["id"] as string, "channel:message", data).catch(err => console.warn(`[Channel] emit failed:`, err));
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
    this.rescheduleCallTimeout();
  }

  /**
   * Cancel a pending method call.
   */
  async cancelMethodCall(callId: string): Promise<void> {
    cancelCallDb(this.sql, callId);
    this.rescheduleCallTimeout();
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
      try {
        await this.rpc.call(
          callerId,
          "onCallResult",
          callId,
          result,
          isError,
        );
      } catch (err) {
        console.error(`[Channel] Failed to deliver call result to ${callerId}:`, err);
      }
    } else {
      // Broadcast result as a channel event via RPC
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

      // Emit to all participants via RPC
      const participants = this.sql.exec(`SELECT id FROM participants`).toArray();
      const data = {
        channelId: this.objectKey,
        message: {
          kind: "persisted", id, type: "method-result", payload, senderId: callerId, ts,
        },
      };
      for (const p of participants) {
        this.rpc.emit(p["id"] as string, "channel:message", data).catch(err => console.warn(`[Channel] emit failed:`, err));
      }
    }
  }

  private rescheduleCallTimeout(): void {
    const next = getNextExpiry(this.sql);
    if (next !== null) {
      const delayMs = Math.max(next - Date.now(), 100);
      this.setAlarm(delayMs);
    }
  }

  // ── Alarm (method call timeout + stale participant cleanup) ──────────────

  override async alarm(): Promise<void> {
    await super.alarm();

    // Expire pending method calls
    const expired = expireCalls(this.sql);
    for (const { callId, callerId } of expired) {
      await this.deliverCallResult(callerId, callId, { error: "Method call timed out" }, true);
    }
    this.rescheduleCallTimeout();

    // Evict stale RPC participants (not DO participants — those are persistent)
    this.evictStaleParticipants();
  }

  private evictStaleParticipants(): void {
    const cutoff = Date.now() - PARTICIPANT_STALE_MS;
    const stale = this.sql.exec(
      `SELECT id, metadata FROM participants WHERE transport = 'rpc' AND connected_at < ?`,
      cutoff,
    ).toArray();

    for (const row of stale) {
      const pid = row["id"] as string;
      const metadata = JSON.parse(row["metadata"] as string);
      this.sql.exec(`DELETE FROM participants WHERE id = ?`, pid);
      this.publishPresenceEvent(pid, "leave", metadata, "disconnect");
    }

    if (stale.length > 0) {
      console.log(`[Channel] Evicted ${stale.length} stale RPC participant(s)`);
    }

    // Schedule next cleanup if there are still rpc participants
    this.scheduleParticipantCleanup();
  }

  private scheduleParticipantCleanup(): void {
    const rpcCount = this.sql.exec(
      `SELECT COUNT(*) as cnt FROM participants WHERE transport = 'rpc'`,
    ).toArray();
    if ((rpcCount[0]?.["cnt"] as number) > 0) {
      this.setAlarm(PARTICIPANT_CLEANUP_INTERVAL_MS);
    }
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
