/**
 * WebSocket pub/sub server with SQLite persistence.
 *
 * Provides pub/sub channels for arbitrary JSON messages with optional
 * persistence to SQLite and replay on reconnection.
 */

import { WebSocketServer, WebSocket } from "ws";
import { createServer, type Server as HttpServer, type IncomingMessage } from "http";
import { getTokenManager } from "./tokenManager.js";
import { getDatabaseManager } from "./db/databaseManager.js";
import { findAvailablePortForService } from "./portUtils.js";

const DB_NAME = "pubsub-messages";

// =============================================================================
// Dependency interfaces for testability
// =============================================================================

/**
 * Token validation interface.
 */
export interface TokenValidator {
  validateToken(token: string): string | null;
}

/**
 * Message persistence interface.
 */
export interface MessageStore {
  init(): void;
  insert(channel: string, type: string, payload: string, senderId: string, ts: number, senderMetadata?: Record<string, unknown>, attachment?: Buffer): number;
  query(channel: string, sinceId: number): MessageRow[];
  close(): void;
}

/**
 * Server configuration options.
 */
export interface PubSubServerOptions {
  /** Token validator (defaults to global TokenManager) */
  tokenValidator?: TokenValidator;
  /** Message store (defaults to SQLite via DatabaseManager) */
  messageStore?: MessageStore | null;
  /** Port to listen on (defaults to dynamic allocation) */
  port?: number;
}

interface Client {
  ws: WebSocket;
  clientId: string;
  channel: string;
  metadata: Record<string, unknown>;
}

/** Participant info sent in roster messages */
interface Participant {
  id: string;
  metadata: Record<string, unknown>;
}

interface ServerMessage {
  kind: "replay" | "persisted" | "ephemeral" | "ready" | "error" | "roster";
  id?: number;
  type?: string;
  payload?: unknown;
  senderId?: string;
  ts?: number;
  ref?: number;
  error?: string;
  /** Binary attachment (separate from JSON payload) */
  attachment?: Buffer;
  /** For roster messages: map of client ID to participant info */
  participants?: Record<string, Participant>;
}

/** Presence event types for join/leave tracking */
type PresenceAction = "join" | "leave";

/** Payload for presence events (type: "presence") */
interface PresencePayload {
  action: PresenceAction;
  metadata: Record<string, unknown>;
}

interface PublishClientMessage {
  action: "publish";
  persist?: boolean;
  type: string;
  payload: unknown;
  ref?: number;
}

interface UpdateMetadataClientMessage {
  action: "update-metadata";
  payload: unknown;
  ref?: number;
}

type ClientMessage = PublishClientMessage | UpdateMetadataClientMessage;

interface MessageRow {
  id: number;
  channel: string;
  type: string;
  payload: string;
  sender_id: string;
  ts: number;
  attachment: Buffer | null;
  /** JSON-serialized sender metadata for replay participant reconstruction */
  sender_metadata: string | null;
}

// =============================================================================
// Default implementations
// =============================================================================

/**
 * SQLite-backed message store using DatabaseManager.
 */
class SqliteMessageStore implements MessageStore {
  private dbHandle: string | null = null;

  init(): void {
    const dbManager = getDatabaseManager();
    this.dbHandle = dbManager.open("pubsub-server", DB_NAME);

    dbManager.exec(
      this.dbHandle,
      `
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel TEXT NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        sender_metadata TEXT,
        attachment BLOB
      );
      CREATE INDEX IF NOT EXISTS idx_messages_channel_id ON messages(channel, id);
    `
    );

    // Migration: add sender_metadata column if it doesn't exist (for existing databases)
    try {
      dbManager.exec(this.dbHandle, `ALTER TABLE messages ADD COLUMN sender_metadata TEXT`);
    } catch {
      // Column already exists, ignore
    }
  }

  insert(channel: string, type: string, payload: string, senderId: string, ts: number, senderMetadata?: Record<string, unknown>, attachment?: Buffer): number {
    if (!this.dbHandle) throw new Error("Store not initialized");
    const db = getDatabaseManager();
    const senderMetadataJson = senderMetadata ? JSON.stringify(senderMetadata) : null;
    const result = db.run(
      this.dbHandle,
      "INSERT INTO messages (channel, type, payload, sender_id, ts, sender_metadata, attachment) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [channel, type, payload, senderId, ts, senderMetadataJson, attachment ?? null]
    );
    return Number(result.lastInsertRowid);
  }

  query(channel: string, sinceId: number): MessageRow[] {
    if (!this.dbHandle) return [];
    const db = getDatabaseManager();
    return db.query<MessageRow>(
      this.dbHandle,
      "SELECT * FROM messages WHERE channel = ? AND id > ? ORDER BY id ASC",
      [channel, sinceId]
    );
  }

  close(): void {
    if (this.dbHandle) {
      const dbManager = getDatabaseManager();

      // Force WAL checkpoint before closing to ensure all data is written to main db
      try {
        dbManager.exec(this.dbHandle, "PRAGMA synchronous = FULL");
        dbManager.query(this.dbHandle, "PRAGMA wal_checkpoint(TRUNCATE)");
      } catch {
        console.warn('WAL checkpoint failed');
        // WAL checkpoint failed, but we still need to close
      }

      dbManager.close(this.dbHandle);
      this.dbHandle = null;
    }
  }
}

/**
 * In-memory message store for testing.
 */
export class InMemoryMessageStore implements MessageStore {
  private messages: MessageRow[] = [];
  private nextId = 1;

  init(): void {
    // No-op for in-memory store
  }

  insert(channel: string, type: string, payload: string, senderId: string, ts: number, senderMetadata?: Record<string, unknown>, attachment?: Buffer): number {
    const id = this.nextId++;
    const senderMetadataJson = senderMetadata ? JSON.stringify(senderMetadata) : null;
    this.messages.push({ id, channel, type, payload, sender_id: senderId, ts, sender_metadata: senderMetadataJson, attachment: attachment ?? null });
    return id;
  }

  query(channel: string, sinceId: number): MessageRow[] {
    return this.messages.filter((m) => m.channel === channel && m.id > sinceId);
  }

  close(): void {
    this.messages = [];
    this.nextId = 1;
  }

  /** For testing: get all messages */
  getAll(): MessageRow[] {
    return [...this.messages];
  }
}

/**
 * Simple token validator for testing.
 */
export class TestTokenValidator implements TokenValidator {
  private tokens = new Map<string, string>();

  addToken(token: string, clientId: string): void {
    this.tokens.set(token, clientId);
  }

  validateToken(token: string): string | null {
    return this.tokens.get(token) ?? null;
  }
}

// =============================================================================
// PubSubServer
// =============================================================================

export class PubSubServer {
  private wss: WebSocketServer | null = null;
  private httpServer: HttpServer | null = null;
  private port: number | null = null;
  private channels = new Map<string, Set<Client>>();

  private tokenValidator: TokenValidator;
  private messageStore: MessageStore | null;
  private requestedPort: number | undefined;

  constructor(options: PubSubServerOptions = {}) {
    this.tokenValidator = options.tokenValidator ?? getTokenManager();
    this.messageStore = options.messageStore === undefined ? new SqliteMessageStore() : options.messageStore;
    this.requestedPort = options.port;
  }

  async start(): Promise<number> {
    // Create HTTP server for WebSocket upgrade
    this.httpServer = createServer();

    if (this.requestedPort === undefined) {
      // Find available port using the standard method
      const { server, port: foundPort } = await findAvailablePortForService("pubsub");
      this.port = foundPort;
      // Close the temporary server that was holding the port
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }

    this.wss = new WebSocketServer({ server: this.httpServer });
    this.messageStore?.init();

    this.wss.on("connection", (ws, req) => this.handleConnection(ws, req));

    return new Promise((resolve) => {
      // Use 0 to let OS assign a port, or the requested port
      const listenPort = this.requestedPort ?? this.port!;
      this.httpServer!.listen(listenPort, "127.0.0.1", () => {
        // Get the actual port assigned (important when requestedPort is 0)
        const addr = this.httpServer!.address();
        if (addr && typeof addr === "object") {
          this.port = addr.port;
        }
        console.log(`[PubSub] Server listening on port ${this.port}`);
        resolve(this.port!);
      });
    });
  }

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    // Use modern URL API with a dummy base since req.url is just the path + query
    const url = new URL(req.url || "", "http://localhost");
    const token = url.searchParams.get("token") ?? "";
    const channel = url.searchParams.get("channel") ?? "";
    const sinceIdParam = url.searchParams.get("sinceId");
    const sinceId = sinceIdParam ? parseInt(sinceIdParam, 10) : null;
    const metadataParam = url.searchParams.get("metadata");

    // Parse metadata (defaults to empty object)
    let metadata: Record<string, unknown> = {};
    if (metadataParam) {
      try {
        metadata = JSON.parse(metadataParam);
      } catch {
        ws.close(4003, "invalid metadata");
        return;
      }
    }

    // Validate token
    const clientId = this.tokenValidator.validateToken(token);
    if (!clientId) {
      ws.close(4001, "unauthorized");
      return;
    }

    if (!channel) {
      ws.close(4002, "channel required");
      return;
    }

    const client: Client = { ws, clientId, channel, metadata };

    // Add to channel
    if (!this.channels.has(channel)) {
      this.channels.set(channel, new Set());
    }
    this.channels.get(channel)!.add(client);

    // Replay if requested
    if (sinceId !== null && this.messageStore) {
      this.replayMessages(ws, channel, sinceId);
    }

    // Signal ready
    this.send(ws, { kind: "ready" });

    // Persist and broadcast join presence event
    this.persistPresenceEvent(client, "join");

    // Broadcast updated roster to all clients in the channel
    this.broadcastRoster(channel);

    // Handle incoming messages (both text and binary)
    ws.on("message", (data) => {
      try {
        if (data instanceof Buffer && data.length > 5) {
          // Try to parse as binary message (first byte is 0 marker)
          const view = new DataView(data.buffer, data.byteOffset, data.length);
          const binaryMarker = view.getUint8(0);
          const metadataLen = view.getUint32(1, true);

          // Only treat as binary if marker is 0 and format is valid
          if (binaryMarker === 0 && data.length >= 5 + metadataLen) {
            const metadataBytes = data.subarray(5, 5 + metadataLen);
            const metadataStr = metadataBytes.toString("utf-8");
            const metadata = JSON.parse(metadataStr) as ClientMessage;
            const payloadBuffer = data.subarray(5 + metadataLen);

            this.handleClientBinaryMessage(client, metadata, payloadBuffer);
            return;
          }
        }

        // Fall back to JSON message parsing
        const msg = JSON.parse(data.toString()) as ClientMessage;
        this.handleClientMessage(client, msg);
      } catch {
        this.send(ws, { kind: "error", error: "invalid message format" });
      }
    });

    // Cleanup on disconnect
    ws.on("close", () => {
      // Persist leave event before removing from channel
      this.persistPresenceEvent(client, "leave");

      this.channels.get(channel)?.delete(client);
      if (this.channels.get(channel)?.size === 0) {
        this.channels.delete(channel);
      } else {
        // Broadcast updated roster after removing the client
        this.broadcastRoster(channel);
      }
    });
  }

  private replayMessages(ws: WebSocket, channel: string, sinceId: number): void {
    if (!this.messageStore) return;

    const rows = this.messageStore.query(channel, sinceId);

    for (const row of rows) {
      const payload = JSON.parse(row.payload);

      if (row.attachment) {
        // Message with attachment - send as binary frame
        this.sendBinary(ws, {
          kind: "replay",
          id: row.id,
          type: row.type,
          payload,
          senderId: row.sender_id,
          ts: row.ts,
          attachment: row.attachment,
        });
      } else {
        // Text message - send as JSON
        this.send(ws, {
          kind: "replay",
          id: row.id,
          type: row.type,
          payload,
          senderId: row.sender_id,
          ts: row.ts,
        });
      }
    }
  }

  private handleClientMessage(client: Client, msg: ClientMessage): void {
    const { ref } = msg;

    if (msg.action === "update-metadata") {
      if (!msg.payload || typeof msg.payload !== "object" || Array.isArray(msg.payload)) {
        this.send(client.ws, { kind: "error", error: "metadata must be an object", ref });
        return;
      }
      client.metadata = msg.payload as Record<string, unknown>;
      this.broadcastRoster(client.channel, client.ws, ref);
      return;
    }

    if (msg.action !== "publish") {
      this.send(client.ws, { kind: "error", error: "unknown action", ref });
      return;
    }

    const { type, payload, persist = true } = msg;
    const ts = Date.now();

    // Validate payload is serializable
    let payloadJson: string;
    try {
      payloadJson = JSON.stringify(payload);
    } catch {
      this.send(client.ws, { kind: "error", error: "payload not serializable", ref });
      return;
    }

    if (persist && this.messageStore) {
      // Persist to message store (presence events handle participant reconstruction)
      const id = this.messageStore.insert(client.channel, type, payloadJson, client.clientId, ts);

      // Broadcast to all (including sender)
      this.broadcast(
        client.channel,
        {
          kind: "persisted",
          id,
          type,
          payload,
          senderId: client.clientId,
          ts,
        },
        client.ws,
        ref
      );
    } else {
      // Ephemeral - broadcast to all (including sender)
      this.broadcast(
        client.channel,
        {
          kind: "ephemeral",
          type,
          payload,
          senderId: client.clientId,
          ts,
        },
        client.ws,
        ref
      );
    }
  }

  private handleClientBinaryMessage(client: Client, msg: ClientMessage, attachment: Buffer): void {
    if (msg.action !== "publish") {
      this.send(client.ws, { kind: "error", error: "unknown action", ref: msg.ref });
      return;
    }

    const { type, payload, persist = true, ref } = msg;
    const ts = Date.now();

    // Validate payload is serializable
    let payloadJson: string;
    try {
      payloadJson = JSON.stringify(payload);
    } catch {
      this.send(client.ws, { kind: "error", error: "payload not serializable", ref });
      return;
    }

    if (persist && this.messageStore) {
      // Persist payload + attachment to message store (presence events handle participant reconstruction)
      const id = this.messageStore.insert(client.channel, type, payloadJson, client.clientId, ts, undefined, attachment);

      // Broadcast to all (including sender)
      this.broadcastBinary(
        client.channel,
        {
          kind: "persisted",
          id,
          type,
          payload,
          senderId: client.clientId,
          ts,
          attachment,
        },
        client.ws,
        ref
      );
    } else {
      // Ephemeral - broadcast to all (including sender)
      this.broadcastBinary(
        client.channel,
        {
          kind: "ephemeral",
          type,
          payload,
          senderId: client.clientId,
          ts,
          attachment,
        },
        client.ws,
        ref
      );
    }
  }

  private broadcast(
    channel: string,
    msg: ServerMessage,
    senderWs: WebSocket,
    senderRef?: number
  ): void {
    const clients = this.channels.get(channel);
    if (!clients) return;

    // Message without ref for non-senders
    const dataForOthers = JSON.stringify(msg);
    // Message with ref for sender (if they provided one)
    const dataForSender =
      senderRef !== undefined ? JSON.stringify({ ...msg, ref: senderRef }) : dataForOthers;

    for (const client of clients) {
      if (client.ws.readyState === WebSocket.OPEN) {
        const data = client.ws === senderWs ? dataForSender : dataForOthers;
        client.ws.send(data);
      }
    }
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  private sendBinary(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState !== WebSocket.OPEN) return;

    const attachment = msg.attachment!;
    const metadata = {
      kind: msg.kind,
      id: msg.id,
      type: msg.type,
      payload: msg.payload,
      senderId: msg.senderId,
      ts: msg.ts,
      ref: msg.ref,
    };

    const metadataStr = JSON.stringify(metadata);
    const metadataBytes = Buffer.from(metadataStr, "utf-8");
    const metadataLen = metadataBytes.length;

    // Create buffer: 1 byte marker (0) + 4 bytes metadata length + metadata + attachment
    const buffer = Buffer.allocUnsafe(1 + 4 + metadataLen + attachment.length);
    buffer.writeUInt8(0, 0); // Binary frame marker
    buffer.writeUInt32LE(metadataLen, 1); // Metadata length
    metadataBytes.copy(buffer, 5);
    attachment.copy(buffer, 5 + metadataLen);

    ws.send(buffer);
  }

  private broadcastBinary(
    channel: string,
    msg: ServerMessage,
    senderWs: WebSocket,
    senderRef?: number
  ): void {
    const clients = this.channels.get(channel);
    if (!clients) return;

    const attachment = msg.attachment!;

    // Build binary buffers for both sender and others
    const createBinaryBuffer = (includeRef: boolean): Buffer => {
      const metadata = {
        kind: msg.kind,
        id: msg.id,
        type: msg.type,
        payload: msg.payload,
        senderId: msg.senderId,
        ts: msg.ts,
        ...(includeRef && senderRef !== undefined ? { ref: senderRef } : {}),
      };

      const metadataStr = JSON.stringify(metadata);
      const metadataBytes = Buffer.from(metadataStr, "utf-8");
      const metadataLen = metadataBytes.length;

      const buffer = Buffer.allocUnsafe(1 + 4 + metadataLen + attachment.length);
      buffer.writeUInt8(0, 0);
      buffer.writeUInt32LE(metadataLen, 1);
      metadataBytes.copy(buffer, 5);
      attachment.copy(buffer, 5 + metadataLen);

      return buffer;
    };

    const bufferForSender = createBinaryBuffer(true);
    const bufferForOthers = createBinaryBuffer(false);

    for (const client of clients) {
      if (client.ws.readyState === WebSocket.OPEN) {
        const buffer = client.ws === senderWs ? bufferForSender : bufferForOthers;
        client.ws.send(buffer);
      }
    }
  }

  /**
   * Persist and broadcast a presence event (join/leave).
   * These events are stored in the message log and replayed to reconstruct participant history.
   */
  private persistPresenceEvent(client: Client, action: PresenceAction): void {
    if (!this.messageStore) return;

    const ts = Date.now();
    const payload: PresencePayload = {
      action,
      metadata: client.metadata,
    };

    // Persist the presence event (no sender_metadata needed - metadata is in the payload)
    // Wrap in try-catch to handle shutdown race condition where store may be closed
    let messageId: number;
    try {
      messageId = this.messageStore.insert(
        client.channel,
        "presence",
        JSON.stringify(payload),
        client.clientId,
        ts
      );
    } catch {
      // Store may have been closed during shutdown - this is expected
      return;
    }

    // Broadcast to all clients in the channel
    const clients = this.channels.get(client.channel);
    if (!clients) return;

    const msg: ServerMessage = {
      kind: "persisted",
      id: messageId,
      type: "presence",
      payload,
      senderId: client.clientId,
      ts,
    };

    const data = JSON.stringify(msg);
    for (const c of clients) {
      if (c.ws.readyState === WebSocket.OPEN) {
        c.ws.send(data);
      }
    }
  }

  /**
   * Broadcast the current roster (participants with metadata) to all clients in a channel.
   * This is an idempotent operation - clients receive the full current state.
   * When a client has multiple connections, uses the metadata from the most recent connection.
   */
  private broadcastRoster(channel: string, senderWs?: WebSocket, senderRef?: number): void {
    const clients = this.channels.get(channel);
    if (!clients || clients.size === 0) return;

    // Build participants map (a single clientId may have multiple connections,
    // we use the last one's metadata - which is fine since it's the same client)
    const participants: Record<string, Participant> = {};
    for (const client of clients) {
      participants[client.clientId] = {
        id: client.clientId,
        metadata: client.metadata,
      };
    }

    const rosterMsg: ServerMessage = {
      kind: "roster",
      participants,
      ts: Date.now(),
    };

    const dataForOthers = JSON.stringify(rosterMsg);
    // If senderRef is present, include it only for the sender (correlation/ack).
    const dataForSender =
      senderRef !== undefined ? JSON.stringify({ ...rosterMsg, ref: senderRef }) : dataForOthers;

    for (const client of clients) {
      if (client.ws.readyState !== WebSocket.OPEN) continue;
      const data = senderWs && client.ws === senderWs ? dataForSender : dataForOthers;
      client.ws.send(data);
    }
  }

  getPort(): number | null {
    return this.port;
  }

  async stop(): Promise<void> {
    // Terminate WebSocket clients BEFORE closing the message store
    // This allows presence "leave" events to be persisted during graceful shutdown
    if (this.wss) {
      for (const client of this.wss.clients) {
        client.terminate();
      }
    }

    // Now close the message store after clients have disconnected
    this.messageStore?.close();

    return new Promise((resolve) => {
      if (this.wss) {
        this.wss.close(() => {
          if (this.httpServer) {
            this.httpServer.close(() => resolve());
          } else {
            resolve();
          }
        });
      } else if (this.httpServer) {
        this.httpServer.close(() => resolve());
      } else {
        resolve();
      }
    });
  }
}

let pubsubServer: PubSubServer | null = null;

export function getPubSubServer(): PubSubServer {
  if (!pubsubServer) {
    pubsubServer = new PubSubServer();
  }
  return pubsubServer;
}
