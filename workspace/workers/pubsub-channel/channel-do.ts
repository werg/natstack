/**
 * PubSubChannel — Durable Object that replaces the Node.js PubSub server.
 *
 * Each channel is a single DO instance. Panels connect via WebSocket,
 * agent DOs interact via HTTP POST through the workerd router.
 *
 * State: messages, participants, pending_calls in local SQLite.
 * WebSocket: Hibernatable API with tagged connections.
 */

/// <reference path="../workerd.d.ts" />
import { DurableObjectBase, type DurableObjectContext, validateToken } from "@workspace/runtime/worker";
import type { ChannelEvent } from "@natstack/harness/types";
import type {
  SendOpts,
  SubscribeResult,
  ChannelConfig,
  PresencePayload,
  ClientMessage,
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
import { replayRosterOps, replayMessages, replayAnchored, getMessagesBefore } from "./replay.js";
import { sendJson, parseBinaryFrame, parseAttachments } from "./ws-protocol.js";
import { storeCall, consumeCall, cancelCall as cancelCallDb, getNextExpiry, expireCalls } from "./method-calls.js";

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
      ctx: this.ctx,
      sql: this.sql,
      postToDO: this.postToDO.bind(this),
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

  // ── WebSocket upgrade ───────────────────────────────────────────────────

  protected override handleWebSocketUpgrade(request: Request): Response {
    const url = new URL(request.url);
    const token = url.searchParams.get("token");
    const contextId = url.searchParams.get("contextId");
    const channelConfigParam = url.searchParams.get("channelConfig");
    const sinceId = parseInt(url.searchParams.get("sinceId") ?? "0");
    const replayLimit = parseInt(url.searchParams.get("replayMessageLimit") ?? "0");

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    this.ctx.blockConcurrencyWhile(async () => {
      try {
        if (!token) {
          server.close(4001, "Missing token");
          return;
        }

        const serverUrl = this.env["SERVER_URL"] as string;
        const authToken = this.env["RPC_AUTH_TOKEN"] as string;
        const auth = await validateToken(serverUrl, authToken, token);
        if (!auth.valid) {
          server.close(4001, "Invalid token");
          return;
        }

        if (!contextId) {
          server.close(4002, "Missing contextId");
          return;
        }

        let parsedConfig: Record<string, unknown> | undefined;
        if (channelConfigParam) {
          try { parsedConfig = JSON.parse(channelConfigParam); }
          catch { server.close(4003, "Malformed channelConfig"); return; }
        }

        try { this.initChannel(contextId, parsedConfig); }
        catch (err) {
          server.close(4004, err instanceof Error ? err.message : "Channel init failed");
          return;
        }

        const participantId = auth.callerId!;
        this.ctx.acceptWebSocket(server, [participantId]);
        server.serializeAttachment({ participantId, sinceId, replayLimit, contextId });

        // Register/update WS participant (only emit join on first connection)
        const metadata: Record<string, unknown> = { callerKind: auth.callerKind };
        const existingWs = this.ctx.getWebSockets(participantId);
        const isFirstConnection = existingWs.length <= 1; // 1 = the one we just accepted

        this.sql.exec(
          `INSERT OR REPLACE INTO participants (id, metadata, transport, connected_at)
           VALUES (?, ?, 'ws', ?)`,
          participantId, JSON.stringify(metadata), Date.now(),
        );

        // Replay roster ops first
        replayRosterOps(server, this.sql);

        // Replay messages
        if (sinceId > 0) {
          replayMessages(server, this.sql, sinceId);
        } else if (replayLimit > 0) {
          replayAnchored(server, this.sql, replayLimit);
        }

        // Publish join presence event only on first connection
        if (isFirstConnection) {
          this.publishPresenceEvent(participantId, "join", metadata);
        }

        // Send ready
        sendReady(server, this.sql, this.getStateValue("contextId"), this.getChannelConfig());
      } catch (err) {
        console.error("[Channel] WS upgrade error:", err);
        server.close(4000, "Internal error");
      }
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  // ── Hibernation hooks ───────────────────────────────────────────────────

  override async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer): Promise<void> {
    super.webSocketMessage(ws, msg);
    const attachment = ws.deserializeAttachment() as { participantId: string } | null;
    if (!attachment) return;

    const { participantId } = attachment;

    // Parse message — narrow catch to JSON parse only
    let clientMsg: ClientMessage;
    try {
      if (msg instanceof ArrayBuffer) {
        const parsed = parseBinaryFrame(msg);
        if (parsed) {
          this.handleClientBinaryMessage(participantId, ws, parsed.msg, parsed.attachmentBlob);
          return;
        }
      }
      clientMsg = JSON.parse(typeof msg === "string" ? msg : new TextDecoder().decode(msg)) as ClientMessage;
    } catch {
      sendJson(ws, { kind: "error", error: "invalid message format" });
      return;
    }

    // Handle message — errors here are real bugs, surface them
    try {
      this.handleClientMessage(participantId, ws, clientMsg);
    } catch (err) {
      const ref = "ref" in clientMsg ? clientMsg.ref : undefined;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[Channel] handleClientMessage error:`, err);
      sendJson(ws, { kind: "error", error: message, ref });
    }
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    super.webSocketClose(ws, code, reason, wasClean);
    const attachment = ws.deserializeAttachment() as { participantId: string } | null;
    if (!attachment) return;

    const { participantId } = attachment;

    // Only emit leave when the last connection for this participant closes
    const remaining = this.ctx.getWebSockets(participantId);
    if (remaining.length > 0) return; // Other connections still open

    const leaveReason = code === 1000 ? "graceful" : "disconnect";

    const metaRow = this.sql.exec(
      `SELECT metadata FROM participants WHERE id = ?`, participantId,
    ).toArray();
    const metadata = metaRow.length > 0
      ? JSON.parse(metaRow[0]!["metadata"] as string)
      : {};

    this.sql.exec(`DELETE FROM participants WHERE id = ? AND transport = 'ws'`, participantId);
    this.publishPresenceEvent(participantId, "leave", metadata, leaveReason);
  }

  override async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    super.webSocketError(ws, error);
    console.error("[Channel] WebSocket error:", error);
  }

  // ── Client message handling ─────────────────────────────────────────────

  private handleClientMessage(senderId: string, ws: WebSocket, msg: ClientMessage): void {
    const ref = "ref" in msg ? msg.ref : undefined;

    if (msg.action === "update-metadata") {
      if (!msg.payload || typeof msg.payload !== "object" || Array.isArray(msg.payload)) {
        sendJson(ws, { kind: "error", error: "metadata must be an object", ref });
        return;
      }
      const metadata = msg.payload as Record<string, unknown>;
      this.sql.exec(
        `UPDATE participants SET metadata = ? WHERE id = ?`,
        JSON.stringify(metadata), senderId,
      );
      this.publishPresenceEvent(senderId, "update", metadata, undefined, ws, ref);
      return;
    }

    if (msg.action === "close") {
      // Acknowledge — actual cleanup happens in webSocketClose
      sendJson(ws, { kind: "persisted", ref });
      return;
    }

    if (msg.action === "update-config") {
      const newConfig = { ...this.getChannelConfig(), ...msg.config };
      this.setStateValue("config", JSON.stringify(newConfig));
      broadcastConfigUpdate(this.broadcastDeps, newConfig, ws, ref);
      return;
    }

    if (msg.action === "get-messages-before") {
      const { beforeId, limit = 100 } = msg;
      if (typeof beforeId !== "number" || beforeId < 0) {
        sendJson(ws, { kind: "error", error: "beforeId must be a non-negative number", ref });
        return;
      }
      const result = getMessagesBefore(this.sql, beforeId, limit);
      sendJson(ws, { kind: "messages-before", ...result, ref });
      return;
    }

    if (msg.action === "publish") {
      const { type, payload, persist = true } = msg;
      const ts = Date.now();

      // Intercept method-result only if there's a matching pending DO-initiated call.
      // WS-to-WS method results must fall through to normal broadcast.
      if (type === "method-result" && payload && typeof payload === "object") {
        const p = payload as Record<string, unknown>;
        const callId = p["callId"] as string;
        if (callId) {
          const pending = this.sql.exec(
            `SELECT call_id FROM pending_calls WHERE call_id = ?`, callId,
          ).toArray();
          if (pending.length > 0) {
            this.handleMethodResult(callId, p["content"], !!p["isError"]);
            sendJson(ws, { kind: "persisted", ref });
            return;
          }
          // No pending call — fall through to normal broadcast (WS-to-WS flow)
        }
      }

      let payloadJson: string;
      try { payloadJson = JSON.stringify(payload); }
      catch {
        sendJson(ws, { kind: "error", error: "payload not serializable", ref });
        return;
      }

      // Get sender metadata from participants table
      const metaRow = this.sql.exec(
        `SELECT metadata FROM participants WHERE id = ?`, senderId,
      ).toArray();
      const senderMetadata = metaRow.length > 0
        ? JSON.parse(metaRow[0]!["metadata"] as string)
        : undefined;

      // Extract messageId from payload (client convention: payload.id is the message UUID)
      const payloadObj = typeof payload === "object" && payload !== null
        ? payload as Record<string, unknown>
        : null;
      const messageId = (payloadObj?.["id"] as string) ?? crypto.randomUUID();

      if (persist) {
        this.sql.exec(
          `INSERT INTO messages (message_id, type, content, sender_id, ts, persist, sender_metadata)
           VALUES (?, ?, ?, ?, ?, 1, ?)`,
          messageId, type, payloadJson, senderId, ts,
          senderMetadata ? JSON.stringify(senderMetadata) : null,
        );
        const id = this.sql.exec(`SELECT last_insert_rowid() as id`).one()["id"] as number;

        const serverMsg: ServerMessage = {
          kind: "persisted", id, type, payload, senderId, ts, senderMetadata,
        };
        const event = buildChannelEvent(id, messageId, type, payloadJson, senderId, senderMetadata, ts, true);
        broadcast(this.broadcastDeps, serverMsg, event, senderId, ws, ref);
      } else {
        const serverMsg: ServerMessage = {
          kind: "ephemeral", type, payload, senderId, ts, senderMetadata,
        };
        const event = buildChannelEvent(0, messageId, type, payloadJson, senderId, senderMetadata, ts, false);
        broadcast(this.broadcastDeps, serverMsg, event, senderId, ws, ref);
      }
      return;
    }

    sendJson(ws, { kind: "error", error: "unknown action", ref });
  }

  private handleClientBinaryMessage(
    senderId: string,
    ws: WebSocket,
    msg: ClientMessage,
    attachmentBlob: Uint8Array,
  ): void {
    if (msg.action !== "publish") {
      sendJson(ws, { kind: "error", error: "unknown action" });
      return;
    }

    const { type, payload, persist = true, attachmentMeta } = msg;
    const ref = "ref" in msg ? msg.ref : undefined;
    const ts = Date.now();

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
          sendJson(ws, { kind: "persisted", ref });
          return;
        }
      }
    }

    if (!attachmentMeta || attachmentMeta.length === 0) {
      sendJson(ws, { kind: "error", error: "binary frame requires attachmentMeta", ref });
      return;
    }

    const attachments = parseAttachments(
      attachmentBlob, attachmentMeta, () => this.generateAttachmentId(),
    );

    let payloadJson: string;
    try { payloadJson = JSON.stringify(payload); }
    catch {
      sendJson(ws, { kind: "error", error: "payload not serializable", ref });
      return;
    }

    const metaRow = this.sql.exec(
      `SELECT metadata FROM participants WHERE id = ?`, senderId,
    ).toArray();
    const senderMetadata = metaRow.length > 0
      ? JSON.parse(metaRow[0]!["metadata"] as string)
      : undefined;

    const payloadObj = typeof payload === "object" && payload !== null
      ? payload as Record<string, unknown>
      : null;
    const messageId = (payloadObj?.["id"] as string) ?? crypto.randomUUID();

    if (persist) {
      this.sql.exec(
        `INSERT INTO messages (message_id, type, content, sender_id, ts, persist, sender_metadata, attachments)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
        messageId, type, payloadJson, senderId, ts,
        senderMetadata ? JSON.stringify(senderMetadata) : null,
        JSON.stringify(attachments),
      );
      const id = this.sql.exec(`SELECT last_insert_rowid() as id`).one()["id"] as number;

      const serverMsg: ServerMessage = {
        kind: "persisted", id, type, payload, senderId, ts, senderMetadata,
        attachments,
      };
      const event = buildChannelEvent(id, messageId, type, payloadJson, senderId, senderMetadata, ts, true, attachments);
      broadcast(this.broadcastDeps, serverMsg, event, senderId, ws, ref, attachments);
    } else {
      const serverMsg: ServerMessage = {
        kind: "ephemeral", type, payload, senderId, ts, senderMetadata,
        attachments,
      };
      const event = buildChannelEvent(0, messageId, type, payloadJson, senderId, senderMetadata, ts, false, attachments);
      broadcast(this.broadcastDeps, serverMsg, event, senderId, ws, ref, attachments);
    }
  }

  // ── Presence events ─────────────────────────────────────────────────────

  private publishPresenceEvent(
    senderId: string,
    action: "join" | "leave" | "update",
    metadata: Record<string, unknown>,
    leaveReason?: "graceful" | "disconnect",
    senderWs?: WebSocket | null,
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
    broadcast(this.broadcastDeps, serverMsg, event, senderId, senderWs ?? null, senderRef);
  }

  // ── DO-callable methods (via HTTP POST through router) ──────────────────

  /**
   * Subscribe a DO participant to this channel.
   */
  async subscribe(
    participantId: string,
    metadata: Record<string, unknown>,
  ): Promise<SubscribeResult> {
    // Extract DO identity from metadata
    const doSource = metadata["doSource"] as string | undefined;
    const doClass = metadata["doClass"] as string | undefined;
    const doKey = metadata["doKey"] as string | undefined;
    const transport = metadata["transport"] as string ?? "do";

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

    // Clean metadata for storage (remove transport/DO fields)
    const storedMetadata = { ...metadata };
    delete storedMetadata["doSource"];
    delete storedMetadata["doClass"];
    delete storedMetadata["doKey"];
    delete storedMetadata["contextId"];
    delete storedMetadata["channelConfig"];

    this.sql.exec(
      `INSERT INTO participants (id, metadata, transport, connected_at, do_source, do_class, do_key)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      participantId,
      JSON.stringify(storedMetadata),
      transport === "do" ? "do" : "ws",
      Date.now(),
      doSource ?? null,
      doClass ?? null,
      doKey ?? null,
    );

    // Publish join presence
    this.publishPresenceEvent(participantId, "join", storedMetadata);

    return {
      ok: true,
      channelConfig: this.getChannelConfig() ?? undefined,
    };
  }

  /**
   * Unsubscribe a DO participant from this channel.
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
   * Send a new message (from a DO participant).
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
      broadcast(this.broadcastDeps, serverMsg, event, participantId, null);
    } else {
      const serverMsg: ServerMessage = {
        kind: "ephemeral", type: "message", payload, senderId: participantId, ts, senderMetadata,
      };
      const event = buildChannelEvent(0, messageId, "message", payloadJson, participantId, senderMetadata, ts, false);
      broadcast(this.broadcastDeps, serverMsg, event, participantId, null);
    }
  }

  /**
   * Update an existing message (from a DO participant).
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
    broadcast(this.broadcastDeps, serverMsg, event, participantId, null);
  }

  /**
   * Complete (finalize) a message (from a DO participant).
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
    broadcast(this.broadcastDeps, serverMsg, event, participantId, null);
  }

  /**
   * Send an ephemeral message (from a DO participant).
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
    broadcast(this.broadcastDeps, serverMsg, event, participantId, null);
  }

  /**
   * Update a DO participant's metadata.
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
   * Get all participants.
   */
  async getParticipants(): Promise<Array<{ participantId: string; metadata: Record<string, unknown> }>> {
    const rows = this.sql.exec(
      `SELECT id, metadata FROM participants`,
    ).toArray();
    return rows.map(row => ({
      participantId: row["id"] as string,
      metadata: JSON.parse(row["metadata"] as string),
    }));
  }

  /**
   * Update channel config.
   */
  async updateConfig(config: Partial<ChannelConfig>): Promise<ChannelConfig> {
    const newConfig = { ...this.getChannelConfig(), ...config };
    this.setStateValue("config", JSON.stringify(newConfig));
    broadcastConfigUpdate(this.broadcastDeps, newConfig, null);
    return newConfig;
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
      // Deliver to DO target via HTTP POST through router
      try {
        const result = await this.postToDO(
          t["do_source"] as string,
          t["do_class"] as string,
          t["do_key"] as string,
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
      // WebSocket target — broadcast method-call as ephemeral channel message
      // Format must match what the PubSub client expects: { callId, providerId, methodName, args }
      const payload = { callId, providerId: targetPid, methodName: method, args };
      const callerMeta = this.sql.exec(`SELECT metadata FROM participants WHERE id = ?`, callerPid).toArray();
      const senderMetadata = callerMeta.length > 0 ? JSON.parse(callerMeta[0]!["metadata"] as string) : undefined;
      const serverMsg: ServerMessage = {
        kind: "ephemeral", type: "method-call", payload, senderId: callerPid, ts: Date.now(), senderMetadata,
      };
      // Broadcast to all WS clients (the PubSub client filters by providerId === self)
      const allWs = this.ctx.getWebSockets();
      const data = JSON.stringify(serverMsg);
      for (const ws of allWs) ws.send(data);
    }
  }

  /**
   * Handle a method result from a WebSocket participant.
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
        await this.postToDO(
          c["do_source"] as string,
          c["do_class"] as string,
          c["do_key"] as string,
          "onCallResult",
          callId,
          result,
          isError,
        );
      } catch (err) {
        console.error(`[Channel] Failed to deliver call result to ${callerId}:`, err);
      }
    } else {
      // Persist and broadcast result as a normal channel message (matches old PubSub server)
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

      // Broadcast to all WS clients (caller picks it up by callId)
      const allWs = this.ctx.getWebSockets();
      const data = JSON.stringify({
        kind: "persisted", id, type: "method-result", payload, senderId: callerId, ts,
      });
      for (const ws of allWs) ws.send(data);
    }
  }

  private rescheduleCallTimeout(): void {
    const next = getNextExpiry(this.sql);
    if (next !== null) {
      const delayMs = Math.max(next - Date.now(), 100);
      this.setAlarm(delayMs);
    }
  }

  // postToDO inherited from DurableObjectBase

  // ── Alarm (method call timeout) ─────────────────────────────────────────

  override async alarm(): Promise<void> {
    await super.alarm();

    const expired = expireCalls(this.sql);
    for (const { callId, callerId } of expired) {
      await this.deliverCallResult(callerId, callId, { error: "Method call timed out" }, true);
    }
    this.rescheduleCallTimeout();
  }

  // ── Fork support ────────────────────────────────────────────────────────

  /**
   * Called after cloneDO() copies the parent's SQLite.
   * Trims post-fork messages, clears roster and pending calls.
   */
  async postClone(parentChannelId: string, forkPointId: number): Promise<void> {
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
