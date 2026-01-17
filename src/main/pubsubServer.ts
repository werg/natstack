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
 * Channel metadata stored in the database.
 */
export interface ChannelInfo {
  contextId: string;
  createdAt: number;
  createdBy: string;
}

/**
 * Message persistence interface.
 */
export interface MessageStore {
  init(): void;
  insert(channel: string, type: string, payload: string, senderId: string, ts: number, senderMetadata?: Record<string, unknown>, attachment?: Buffer): number;
  query(channel: string, sinceId: number): MessageRow[];
  queryByType(channel: string, types: string[], sinceId?: number): MessageRow[];
  createChannel(channel: string, contextId: string, createdBy: string): void;
  getChannel(channel: string): ChannelInfo | null;
  close(): void;
}

/**
 * Server configuration options.
 */
export interface PubSubServerOptions {
  /** Token validator (defaults to global TokenManager) */
  tokenValidator?: TokenValidator;
  /** Message store implementation */
  messageStore: MessageStore;
  /** Port to listen on (defaults to dynamic allocation) */
  port?: number;
}

interface ClientConnection {
  ws: WebSocket;
  clientId: string;
  channel: string;
  metadata: Record<string, unknown>;
}

/** Participant state tracked per channel */
interface ParticipantState {
  id: string;
  metadata: Record<string, unknown>;
  connections: number;
}

interface ChannelState {
  clients: Set<ClientConnection>;
  participants: Map<string, ParticipantState>;
}

interface ServerMessage {
  kind: "replay" | "persisted" | "ephemeral" | "ready" | "error";
  id?: number;
  type?: string;
  payload?: unknown;
  senderId?: string;
  ts?: number;
  ref?: number;
  error?: string;
  /** Binary attachment (separate from JSON payload) */
  attachment?: Buffer;
  /** Sender metadata snapshot (if available) */
  senderMetadata?: Record<string, unknown>;
  /** Context ID for the channel (sent in ready message) */
  contextId?: string;
}

/** Presence event types for join/leave tracking */
type PresenceAction = "join" | "leave" | "update";

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

function metadataEquals(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

// =============================================================================
// Shared utilities for message stores
// =============================================================================

/**
 * Serialize sender metadata to JSON string for storage.
 */
function serializeMetadata(metadata?: Record<string, unknown>): string | null {
  return metadata ? JSON.stringify(metadata) : null;
}

/**
 * Create a MessageRow object from components.
 */
function createMessageRow(
  id: number,
  channel: string,
  type: string,
  payload: string,
  senderId: string,
  ts: number,
  senderMetadata?: Record<string, unknown>,
  attachment?: Buffer
): MessageRow {
  return {
    id,
    channel,
    type,
    payload,
    sender_id: senderId,
    ts,
    sender_metadata: serializeMetadata(senderMetadata),
    attachment: attachment ?? null,
  };
}

/**
 * Create a ChannelInfo object.
 */
function createChannelInfo(contextId: string, createdAt: number, createdBy: string): ChannelInfo {
  return { contextId, createdAt, createdBy };
}

// =============================================================================
// Abstract base class for message stores
// =============================================================================

/**
 * Abstract base class providing common validation and utilities for message stores.
 */
abstract class BaseMessageStore implements MessageStore {
  abstract init(): void;
  abstract close(): void;

  /**
   * Create a channel entry. Implementations should handle race conditions
   * (e.g., two clients creating the same channel simultaneously).
   */
  abstract createChannel(channel: string, contextId: string, createdBy: string): void;

  abstract getChannel(channel: string): ChannelInfo | null;

  /**
   * Insert a message. Returns the assigned message ID.
   */
  abstract insert(
    channel: string,
    type: string,
    payload: string,
    senderId: string,
    ts: number,
    senderMetadata?: Record<string, unknown>,
    attachment?: Buffer
  ): number;

  abstract query(channel: string, sinceId: number): MessageRow[];

  /**
   * Query messages by type. Returns empty array if types is empty.
   */
  queryByType(channel: string, types: string[], sinceId = 0): MessageRow[] {
    if (types.length === 0) return [];
    return this.doQueryByType(channel, types, sinceId);
  }

  /**
   * Implementation-specific query by type. Called after empty types check.
   */
  protected abstract doQueryByType(channel: string, types: string[], sinceId: number): MessageRow[];
}

// =============================================================================
// Concrete implementations
// =============================================================================

/**
 * SQLite-backed message store using DatabaseManager.
 */
class SqliteMessageStore extends BaseMessageStore {
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

      CREATE TABLE IF NOT EXISTS channels (
        channel TEXT PRIMARY KEY,
        context_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        created_by TEXT NOT NULL
      );
    `
    );

    // Migration: add sender_metadata column if it doesn't exist (for existing databases)
    try {
      dbManager.exec(this.dbHandle, `ALTER TABLE messages ADD COLUMN sender_metadata TEXT`);
    } catch {
      // Column already exists, ignore
    }
  }

  createChannel(channel: string, contextId: string, createdBy: string): void {
    if (!this.dbHandle) throw new Error("Store not initialized");
    const db = getDatabaseManager();
    const now = Date.now();
    // Use INSERT OR IGNORE to handle race condition when two clients
    // try to create the same channel simultaneously
    db.run(
      this.dbHandle,
      "INSERT OR IGNORE INTO channels (channel, context_id, created_at, created_by) VALUES (?, ?, ?, ?)",
      [channel, contextId, now, createdBy]
    );
  }

  getChannel(channel: string): ChannelInfo | null {
    if (!this.dbHandle) return null;
    const db = getDatabaseManager();
    const row = db.query<{ context_id: string; created_at: number; created_by: string }>(
      this.dbHandle,
      "SELECT context_id, created_at, created_by FROM channels WHERE channel = ?",
      [channel]
    )[0];
    if (!row) return null;
    return createChannelInfo(row.context_id, row.created_at, row.created_by);
  }

  insert(
    channel: string,
    type: string,
    payload: string,
    senderId: string,
    ts: number,
    senderMetadata?: Record<string, unknown>,
    attachment?: Buffer
  ): number {
    if (!this.dbHandle) throw new Error("Store not initialized");
    const db = getDatabaseManager();
    const result = db.run(
      this.dbHandle,
      "INSERT INTO messages (channel, type, payload, sender_id, ts, sender_metadata, attachment) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [channel, type, payload, senderId, ts, serializeMetadata(senderMetadata), attachment ?? null]
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

  protected doQueryByType(channel: string, types: string[], sinceId: number): MessageRow[] {
    if (!this.dbHandle) return [];
    const db = getDatabaseManager();
    const placeholders = types.map(() => "?").join(", ");
    return db.query<MessageRow>(
      this.dbHandle,
      `SELECT * FROM messages WHERE channel = ? AND id > ? AND type IN (${placeholders}) ORDER BY id ASC`,
      [channel, sinceId, ...types]
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
export class InMemoryMessageStore extends BaseMessageStore {
  private messages: MessageRow[] = [];
  private channels = new Map<string, ChannelInfo>();
  private nextId = 1;

  init(): void {
    // No-op for in-memory store
  }

  createChannel(channel: string, contextId: string, createdBy: string): void {
    // Only create if doesn't exist (matches SQLite INSERT OR IGNORE behavior)
    if (!this.channels.has(channel)) {
      this.channels.set(channel, createChannelInfo(contextId, Date.now(), createdBy));
    }
  }

  getChannel(channel: string): ChannelInfo | null {
    return this.channels.get(channel) ?? null;
  }

  insert(
    channel: string,
    type: string,
    payload: string,
    senderId: string,
    ts: number,
    senderMetadata?: Record<string, unknown>,
    attachment?: Buffer
  ): number {
    const id = this.nextId++;
    this.messages.push(createMessageRow(id, channel, type, payload, senderId, ts, senderMetadata, attachment));
    return id;
  }

  query(channel: string, sinceId: number): MessageRow[] {
    return this.messages.filter((m) => m.channel === channel && m.id > sinceId);
  }

  protected doQueryByType(channel: string, types: string[], sinceId: number): MessageRow[] {
    const typeSet = new Set(types);
    return this.messages.filter(
      (m) => m.channel === channel && m.id > sinceId && typeSet.has(m.type)
    );
  }

  close(): void {
    this.reset();
  }

  /** For testing: get all messages */
  getAll(): MessageRow[] {
    return [...this.messages];
  }

  /** For testing: clear all messages between tests */
  clear(): void {
    this.reset();
  }

  /** Internal reset - shared by close() and clear() */
  private reset(): void {
    this.messages = [];
    this.channels.clear();
    this.nextId = 1;
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
  private channels = new Map<string, ChannelState>();

  private tokenValidator: TokenValidator;
  private messageStore: MessageStore;
  private requestedPort: number | undefined;

  constructor(options: PubSubServerOptions) {
    this.tokenValidator = options.tokenValidator ?? getTokenManager();
    this.messageStore = options.messageStore;
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
    this.messageStore.init();

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

  private getOrCreateChannelState(channel: string): ChannelState {
    let state = this.channels.get(channel);
    if (!state) {
      state = { clients: new Set(), participants: new Map() };
      this.channels.set(channel, state);
    }
    return state;
  }

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    // Use modern URL API with a dummy base since req.url is just the path + query
    const url = new URL(req.url || "", "http://localhost");
    const token = url.searchParams.get("token") ?? "";
    const channel = url.searchParams.get("channel") ?? "";
    const sinceIdParam = url.searchParams.get("sinceId");
    const sinceId = sinceIdParam ? parseInt(sinceIdParam, 10) : null;
    const contextIdParam = url.searchParams.get("contextId");

    // Metadata starts empty - clients send metadata via update-metadata after connection
    const metadata: Record<string, unknown> = {};

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

    // Check if channel exists in the message store
    const existingChannel = this.messageStore.getChannel(channel);
    let channelContextId: string | undefined;

    if (!existingChannel) {
      // First connection creates the channel
      // contextId is optional - if not provided, channel is "global" (no context)
      if (contextIdParam) {
        this.messageStore.createChannel(channel, contextIdParam, clientId);
        // Re-fetch to get actual contextId (in case another client won the race)
        const created = this.messageStore.getChannel(channel);
        channelContextId = created?.contextId;
      }
      // If no contextId, channel exists only in memory (no persistence entry)
    } else {
      // Subsequent connections - validate contextId consistency
      if (existingChannel.contextId) {
        // Channel has a context - client must either not provide contextId or match
        if (contextIdParam && contextIdParam !== existingChannel.contextId) {
          ws.close(4005, "contextId mismatch");
          return;
        }
        channelContextId = existingChannel.contextId;
      } else {
        // Channel is global (no context) - client cannot provide contextId
        if (contextIdParam) {
          ws.close(4006, "channel has no contextId");
          return;
        }
      }
    }

    const client: ClientConnection = { ws, clientId, channel, metadata };

    const channelState = this.getOrCreateChannelState(channel);
    channelState.clients.add(client);

    const existingParticipant = channelState.participants.get(clientId);
    const metadataChanged = !!existingParticipant && !metadataEquals(existingParticipant.metadata, metadata);

    if (existingParticipant) {
      existingParticipant.connections += 1;
      if (metadataChanged) {
        existingParticipant.metadata = metadata;
      }
    } else {
      channelState.participants.set(clientId, {
        id: clientId,
        metadata,
        connections: 1,
      });
    }

    // Send roster-op history before any normal replay
    this.replayRosterOps(ws, channel);

    // Replay if requested
    if (sinceId !== null) {
      this.replayMessages(ws, channel, sinceId);
    }

    // Signal ready (end of replay) with contextId
    this.send(ws, { kind: "ready", contextId: channelContextId });

    // Persist and broadcast join or update presence event
    if (!existingParticipant) {
      this.publishPresenceEvent(client, "join", metadata);
    } else if (metadataChanged) {
      this.publishPresenceEvent(client, "update", metadata);
    }

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
      const state = this.channels.get(channel);
      if (!state) return;

      state.clients.delete(client);

      const participant = state.participants.get(clientId);
      if (participant) {
        participant.connections -= 1;
        if (participant.connections <= 0) {
          state.participants.delete(clientId);
          // Persist leave event after last connection closes
          this.publishPresenceEvent(client, "leave", participant.metadata);
        }
      }

      if (state.clients.size === 0) {
        this.channels.delete(channel);
      }
    });
  }

  private replayMessages(ws: WebSocket, channel: string, sinceId: number): void {
    const rows = this.messageStore.query(channel, sinceId);

    for (const row of rows) {
      const payload = JSON.parse(row.payload);
      const senderMetadata = row.sender_metadata ? JSON.parse(row.sender_metadata) : undefined;

      if (row.attachment) {
        // Message with attachment - send as binary frame
        this.sendBinary(ws, {
          kind: "replay",
          id: row.id,
          type: row.type,
          payload,
          senderId: row.sender_id,
          ts: row.ts,
          senderMetadata,
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
          senderMetadata,
        });
      }
    }
  }

  private handleClientMessage(client: ClientConnection, msg: ClientMessage): void {
    const { ref } = msg;

    if (msg.action === "update-metadata") {
      if (!msg.payload || typeof msg.payload !== "object" || Array.isArray(msg.payload)) {
        this.send(client.ws, { kind: "error", error: "metadata must be an object", ref });
        return;
      }
      client.metadata = msg.payload as Record<string, unknown>;
      const state = this.channels.get(client.channel);
      if (state) {
        const participant = state.participants.get(client.clientId);
        if (participant) {
          participant.metadata = client.metadata;
        }
      }
      this.publishPresenceEvent(client, "update", client.metadata, ref);
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

    if (persist) {
      // Persist to message store (presence events handle participant reconstruction)
      const id = this.messageStore.insert(
        client.channel,
        type,
        payloadJson,
        client.clientId,
        ts,
        client.metadata
      );

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
          senderMetadata: client.metadata,
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
          senderMetadata: client.metadata,
        },
        client.ws,
        ref
      );
    }
  }

  private handleClientBinaryMessage(client: ClientConnection, msg: ClientMessage, attachment: Buffer): void {
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

    if (persist) {
      // Persist payload + attachment to message store (presence events handle participant reconstruction)
      const id = this.messageStore.insert(
        client.channel,
        type,
        payloadJson,
        client.clientId,
        ts,
        client.metadata,
        attachment
      );

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
          senderMetadata: client.metadata,
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
          senderMetadata: client.metadata,
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
    const state = this.channels.get(channel);
    if (!state) return;

    // Message without ref for non-senders
    const dataForOthers = JSON.stringify(msg);
    // Message with ref for sender (if they provided one)
    const dataForSender =
      senderRef !== undefined ? JSON.stringify({ ...msg, ref: senderRef }) : dataForOthers;

    for (const client of state.clients) {
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
      senderMetadata: msg.senderMetadata,
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
    const state = this.channels.get(channel);
    if (!state) return;

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
        senderMetadata: msg.senderMetadata,
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

    for (const client of state.clients) {
      if (client.ws.readyState === WebSocket.OPEN) {
        const buffer = client.ws === senderWs ? bufferForSender : bufferForOthers;
        client.ws.send(buffer);
      }
    }
  }

  private replayRosterOps(ws: WebSocket, channel: string): void {
    const rows = this.messageStore.queryByType(channel, ["presence"], 0);

    for (const row of rows) {
      const payload = JSON.parse(row.payload);
      const senderMetadata = row.sender_metadata ? JSON.parse(row.sender_metadata) : undefined;

      const msg: ServerMessage = {
        kind: "replay",
        id: row.id,
        type: row.type,
        payload,
        senderId: row.sender_id,
        ts: row.ts,
        senderMetadata,
      };

      if (row.attachment) {
        this.sendBinary(ws, { ...msg, attachment: row.attachment });
      } else {
        this.send(ws, msg);
      }
    }
  }

  /**
   * Persist and broadcast a presence event (join/leave/update).
   * These events are stored in the message log and replayed to reconstruct roster history.
   */
  private publishPresenceEvent(
    client: ClientConnection,
    action: PresenceAction,
    metadata: Record<string, unknown>,
    senderRef?: number
  ): void {
    const ts = Date.now();
    const payload: PresencePayload = {
      action,
      metadata,
    };

    let messageId: number;
    try {
      messageId = this.messageStore.insert(
        client.channel,
        "presence",
        JSON.stringify(payload),
        client.clientId,
        ts,
        metadata
      );
    } catch {
      return;
    }

    const msg: ServerMessage = {
      kind: "persisted",
      id: messageId,
      type: "presence",
      payload,
      senderId: client.clientId,
      ts,
      senderMetadata: metadata,
    };

    this.broadcast(client.channel, msg, client.ws, senderRef);
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
    this.messageStore.close();

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
    pubsubServer = new PubSubServer({ messageStore: new SqliteMessageStore() });
  }
  return pubsubServer;
}
