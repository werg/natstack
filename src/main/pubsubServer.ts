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
 * Channel configuration persisted with the channel.
 * Set when the channel is created, readable by all participants.
 */
export interface ChannelConfig {
  workingDirectory?: string;
  restrictedMode?: boolean;
  title?: string;
}

/**
 * Channel metadata stored in the database.
 */
export interface ChannelInfo {
  contextId: string;
  createdAt: number;
  createdBy: string;
  config?: ChannelConfig;
}

/**
 * Message persistence interface.
 */
export interface MessageStore {
  init(): void;
  insert(channel: string, type: string, payload: string, senderId: string, ts: number, senderMetadata?: Record<string, unknown>, attachments?: ServerAttachment[]): number;
  query(channel: string, sinceId: number): MessageRow[];
  queryByType(channel: string, types: string[], sinceId?: number): MessageRow[];
  createChannel(channel: string, contextId: string, createdBy: string, config?: ChannelConfig): void;
  getChannel(channel: string): ChannelInfo | null;
  /** Update channel config (merges with existing config) */
  updateChannelConfig(channel: string, config: Partial<ChannelConfig>): ChannelConfig | null;
  /** Get the maximum attachment ID number for a channel (for counter initialization after restart) */
  getMaxAttachmentIdNumber(channel: string): number;
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
  /** Whether this participant sent a graceful close message */
  pendingGracefulClose: boolean;
}

interface ChannelState {
  clients: Set<ClientConnection>;
  participants: Map<string, ParticipantState>;
  /** Counter for generating unique attachment IDs within this channel */
  nextAttachmentId: number;
}

/**
 * A binary attachment with metadata.
 */
interface ServerAttachment {
  /** Unique attachment ID for easy tokenization (e.g., "img_1", "img_2") */
  id: string;
  data: Buffer;
  mimeType: string;
  name?: string;
}

/**
 * Attachment metadata from wire format (sizes for parsing binary blob).
 */
interface AttachmentMeta {
  mimeType: string;
  name?: string;
  size: number;
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
  /** Binary attachments (separate from JSON payload) */
  attachments?: ServerAttachment[];
  /** Sender metadata snapshot (if available) */
  senderMetadata?: Record<string, unknown>;
  /** Context ID for the channel (sent in ready message) */
  contextId?: string;
  /** Channel config (sent in ready message) */
  channelConfig?: ChannelConfig;
}

/** Presence event types for join/leave tracking */
type PresenceAction = "join" | "leave" | "update";

/** Reason for leave - graceful (intentional) vs disconnect (connection lost) */
type LeaveReason = "graceful" | "disconnect";

/** Payload for presence events (type: "presence") */
interface PresencePayload {
  action: PresenceAction;
  metadata: Record<string, unknown>;
  /** Reason for leave (only present when action === "leave") */
  leaveReason?: LeaveReason;
}

interface PublishClientMessage {
  action: "publish";
  persist?: boolean;
  type: string;
  payload: unknown;
  ref?: number;
  /** Attachment metadata for parsing binary data (from wire format) */
  attachmentMeta?: AttachmentMeta[];
}

interface UpdateMetadataClientMessage {
  action: "update-metadata";
  payload: unknown;
  ref?: number;
}

interface CloseClientMessage {
  action: "close";
  ref?: number;
}

interface UpdateConfigClientMessage {
  action: "update-config";
  config: Partial<ChannelConfig>;
  ref?: number;
}

type ClientMessage = PublishClientMessage | UpdateMetadataClientMessage | CloseClientMessage | UpdateConfigClientMessage;

interface MessageRow {
  id: number;
  channel: string;
  type: string;
  payload: string;
  sender_id: string;
  ts: number;
  /** JSON-serialized attachments with base64-encoded data */
  attachment: Buffer | null;
  /** JSON-serialized sender metadata for replay participant reconstruction */
  sender_metadata: string | null;
}

/**
 * Serialized attachment format for storage (data is base64).
 */
interface StoredAttachment {
  id: string;
  data: string; // base64
  mimeType: string;
  name?: string;
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
 * Serialize attachments to JSON Buffer for storage.
 * Each attachment's data is base64-encoded for JSON compatibility.
 */
function serializeAttachments(attachments?: ServerAttachment[]): Buffer | null {
  if (!attachments || attachments.length === 0) return null;
  const stored: StoredAttachment[] = attachments.map((a) => ({
    id: a.id,
    data: a.data.toString("base64"),
    mimeType: a.mimeType,
    name: a.name,
  }));
  return Buffer.from(JSON.stringify(stored), "utf-8");
}

/**
 * Deserialize attachments from JSON Buffer.
 * Attachments without IDs are skipped (corrupted data).
 */
function deserializeAttachments(buf: Buffer | null): ServerAttachment[] | undefined {
  if (!buf) return undefined;
  try {
    const stored: StoredAttachment[] = JSON.parse(buf.toString("utf-8"));
    // Filter out any attachments without IDs (corrupted data)
    return stored
      .filter((a) => a.id)
      .map((a) => ({
        id: a.id,
        data: Buffer.from(a.data, "base64"),
        mimeType: a.mimeType,
        name: a.name,
      }));
  } catch {
    return undefined;
  }
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
  attachments?: ServerAttachment[]
): MessageRow {
  return {
    id,
    channel,
    type,
    payload,
    sender_id: senderId,
    ts,
    sender_metadata: serializeMetadata(senderMetadata),
    attachment: serializeAttachments(attachments),
  };
}

/**
 * Create a ChannelInfo object.
 */
function createChannelInfo(contextId: string, createdAt: number, createdBy: string, config?: ChannelConfig): ChannelInfo {
  return { contextId, createdAt, createdBy, config };
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
  abstract createChannel(channel: string, contextId: string, createdBy: string, config?: ChannelConfig): void;

  abstract getChannel(channel: string): ChannelInfo | null;

  /**
   * Update channel config (merges with existing config).
   * Returns the new merged config, or null if channel doesn't exist.
   */
  abstract updateChannelConfig(channel: string, config: Partial<ChannelConfig>): ChannelConfig | null;

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
    attachments?: ServerAttachment[]
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

  /**
   * Get the maximum attachment ID number for a channel (for counter initialization).
   */
  abstract getMaxAttachmentIdNumber(channel: string): number;
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
        created_by TEXT NOT NULL,
        config TEXT
      );
    `
    );

    // Migration: add sender_metadata column if it doesn't exist (for existing databases)
    try {
      dbManager.exec(this.dbHandle, `ALTER TABLE messages ADD COLUMN sender_metadata TEXT`);
    } catch {
      // Column already exists, ignore
    }

    // Migration: add config column to channels if it doesn't exist
    try {
      dbManager.exec(this.dbHandle, `ALTER TABLE channels ADD COLUMN config TEXT`);
    } catch {
      // Column already exists, ignore
    }
  }

  createChannel(channel: string, contextId: string, createdBy: string, config?: ChannelConfig): void {
    if (!this.dbHandle) throw new Error("Store not initialized");
    const db = getDatabaseManager();
    const now = Date.now();
    const configJson = config ? JSON.stringify(config) : null;
    // Use INSERT OR IGNORE to handle race condition when two clients
    // try to create the same channel simultaneously
    db.run(
      this.dbHandle,
      "INSERT OR IGNORE INTO channels (channel, context_id, created_at, created_by, config) VALUES (?, ?, ?, ?, ?)",
      [channel, contextId, now, createdBy, configJson]
    );
  }

  getChannel(channel: string): ChannelInfo | null {
    if (!this.dbHandle) return null;
    const db = getDatabaseManager();
    const row = db.query<{ context_id: string; created_at: number; created_by: string; config: string | null }>(
      this.dbHandle,
      "SELECT context_id, created_at, created_by, config FROM channels WHERE channel = ?",
      [channel]
    )[0];
    if (!row) return null;
    const config = row.config ? JSON.parse(row.config) as ChannelConfig : undefined;
    return createChannelInfo(row.context_id, row.created_at, row.created_by, config);
  }

  updateChannelConfig(channel: string, config: Partial<ChannelConfig>): ChannelConfig | null {
    if (!this.dbHandle) return null;
    const db = getDatabaseManager();

    // Get existing config
    const row = db.query<{ config: string | null }>(
      this.dbHandle,
      "SELECT config FROM channels WHERE channel = ?",
      [channel]
    )[0];
    if (!row) return null;

    // Merge with existing config
    const existingConfig = row.config ? JSON.parse(row.config) as ChannelConfig : {};
    const newConfig: ChannelConfig = { ...existingConfig, ...config };
    const configJson = JSON.stringify(newConfig);

    // Update in database
    db.run(
      this.dbHandle,
      "UPDATE channels SET config = ? WHERE channel = ?",
      [configJson, channel]
    );

    return newConfig;
  }

  insert(
    channel: string,
    type: string,
    payload: string,
    senderId: string,
    ts: number,
    senderMetadata?: Record<string, unknown>,
    attachments?: ServerAttachment[]
  ): number {
    if (!this.dbHandle) throw new Error("Store not initialized");
    const db = getDatabaseManager();
    const result = db.run(
      this.dbHandle,
      "INSERT INTO messages (channel, type, payload, sender_id, ts, sender_metadata, attachment) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [channel, type, payload, senderId, ts, serializeMetadata(senderMetadata), serializeAttachments(attachments)]
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

  getMaxAttachmentIdNumber(channel: string): number {
    if (!this.dbHandle) return 0;
    const db = getDatabaseManager();

    // Query all messages with attachments for this channel
    const rows = db.query<{ attachment: Buffer }>(
      this.dbHandle,
      "SELECT attachment FROM messages WHERE channel = ? AND attachment IS NOT NULL",
      [channel]
    );

    let maxId = 0;
    for (const row of rows) {
      try {
        const stored: StoredAttachment[] = JSON.parse(row.attachment.toString("utf-8"));
        for (const a of stored) {
          if (a.id) {
            // Parse ID format: "img_N"
            const match = a.id.match(/^img_(\d+)$/);
            if (match && match[1]) {
              maxId = Math.max(maxId, parseInt(match[1], 10));
            }
          }
        }
      } catch {
        // Skip malformed attachments
      }
    }
    return maxId;
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

  createChannel(channel: string, contextId: string, createdBy: string, config?: ChannelConfig): void {
    // Only create if doesn't exist (matches SQLite INSERT OR IGNORE behavior)
    if (!this.channels.has(channel)) {
      this.channels.set(channel, createChannelInfo(contextId, Date.now(), createdBy, config));
    }
  }

  getChannel(channel: string): ChannelInfo | null {
    return this.channels.get(channel) ?? null;
  }

  updateChannelConfig(channel: string, config: Partial<ChannelConfig>): ChannelConfig | null {
    const channelInfo = this.channels.get(channel);
    if (!channelInfo) return null;

    // Merge with existing config
    const newConfig: ChannelConfig = { ...channelInfo.config, ...config };
    channelInfo.config = newConfig;
    return newConfig;
  }

  insert(
    channel: string,
    type: string,
    payload: string,
    senderId: string,
    ts: number,
    senderMetadata?: Record<string, unknown>,
    attachments?: ServerAttachment[]
  ): number {
    const id = this.nextId++;
    this.messages.push(createMessageRow(id, channel, type, payload, senderId, ts, senderMetadata, attachments));
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

  getMaxAttachmentIdNumber(channel: string): number {
    let maxId = 0;
    for (const msg of this.messages) {
      if (msg.channel !== channel || !msg.attachment) continue;
      try {
        const stored: StoredAttachment[] = JSON.parse(msg.attachment.toString("utf-8"));
        for (const a of stored) {
          if (a.id) {
            const match = a.id.match(/^img_(\d+)$/);
            if (match && match[1]) {
              maxId = Math.max(maxId, parseInt(match[1], 10));
            }
          }
        }
      } catch {
        // Skip malformed attachments
      }
    }
    return maxId;
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
      // Initialize counter from database to ensure continuity after restarts
      const maxId = this.messageStore.getMaxAttachmentIdNumber(channel);
      state = { clients: new Set(), participants: new Map(), nextAttachmentId: maxId + 1 };
      this.channels.set(channel, state);
    }
    return state;
  }

  /**
   * Generate the next unique attachment ID for a channel.
   * Format: img_N where N is a sequential number.
   */
  private generateAttachmentId(channel: string): string {
    const state = this.getOrCreateChannelState(channel);
    const id = `img_${state.nextAttachmentId}`;
    state.nextAttachmentId++;
    return id;
  }

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    // Use modern URL API with a dummy base since req.url is just the path + query
    const url = new URL(req.url || "", "http://localhost");
    const token = url.searchParams.get("token") ?? "";
    const channel = url.searchParams.get("channel") ?? "";
    const sinceIdParam = url.searchParams.get("sinceId");
    const sinceId = sinceIdParam ? parseInt(sinceIdParam, 10) : null;
    const contextIdParam = url.searchParams.get("contextId");
    const channelConfigParam = url.searchParams.get("channelConfig");
    const channelConfigFromClient = channelConfigParam ? JSON.parse(channelConfigParam) as ChannelConfig : undefined;

    // Metadata starts empty - clients send metadata via update-metadata after connection
    const metadata: Record<string, unknown> = {};

    // Validate token
    const clientId = this.tokenValidator.validateToken(token);
    if (!clientId) {
      console.warn(`[PubSubServer] Rejected connection - invalid token`);
      ws.close(4001, "unauthorized");
      return;
    }
    console.log(`[PubSubServer] Accepted connection from ${clientId}`);

    if (!channel) {
      ws.close(4002, "channel required");
      return;
    }

    // Check if channel exists in the message store
    const existingChannel = this.messageStore.getChannel(channel);
    let channelContextId: string | undefined;
    let channelConfig: ChannelConfig | undefined;

    if (!existingChannel) {
      // First connection creates the channel
      // contextId is optional - if not provided, channel is "global" (no context)
      if (contextIdParam) {
        this.messageStore.createChannel(channel, contextIdParam, clientId, channelConfigFromClient);
        // Re-fetch to get actual contextId (in case another client won the race)
        const created = this.messageStore.getChannel(channel);
        channelContextId = created?.contextId;
        channelConfig = created?.config;

        // Verify the channel was created with our contextId
        // This handles the rare race condition where two clients try to create
        // the same channel with different contextIds simultaneously
        if (channelContextId && channelContextId !== contextIdParam) {
          ws.close(4005, "contextId mismatch: channel was created by another client");
          return;
        }
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
        channelConfig = existingChannel.config;
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
      // Reset graceful close flag on reconnect
      existingParticipant.pendingGracefulClose = false;
      if (metadataChanged) {
        existingParticipant.metadata = metadata;
      }
    } else {
      channelState.participants.set(clientId, {
        id: clientId,
        metadata,
        connections: 1,
        pendingGracefulClose: false,
      });
    }

    // Send roster-op history before any normal replay
    this.replayRosterOps(ws, channel);

    // Replay if requested
    if (sinceId !== null) {
      this.replayMessages(ws, channel, sinceId);
    }

    // Signal ready (end of replay) with contextId and channelConfig
    this.send(ws, { kind: "ready", contextId: channelContextId, channelConfig });

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
          // Determine leave reason from pendingGracefulClose flag
          const leaveReason: LeaveReason = participant.pendingGracefulClose ? "graceful" : "disconnect";
          state.participants.delete(clientId);
          // Persist leave event after last connection closes
          this.publishPresenceEvent(client, "leave", participant.metadata, undefined, leaveReason);
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
      const attachments = deserializeAttachments(row.attachment);

      if (attachments && attachments.length > 0) {
        // Message with attachments - send as binary frame
        this.sendBinary(ws, {
          kind: "replay",
          id: row.id,
          type: row.type,
          payload,
          senderId: row.sender_id,
          ts: row.ts,
          senderMetadata,
          attachments,
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

    if (msg.action === "close") {
      // Mark this participant as gracefully closing
      const state = this.channels.get(client.channel);
      if (state) {
        const participant = state.participants.get(client.clientId);
        if (participant) {
          participant.pendingGracefulClose = true;
        }
      }
      // Acknowledge the close message
      this.send(client.ws, { kind: "persisted", ref });
      return;
    }

    if (msg.action === "update-config") {
      const { config } = msg;
      if (!config || typeof config !== "object" || Array.isArray(config)) {
        this.send(client.ws, { kind: "error", error: "config must be an object", ref });
        return;
      }

      // Update config in database
      const newConfig = this.messageStore.updateChannelConfig(client.channel, config);
      if (!newConfig) {
        this.send(client.ws, { kind: "error", error: "channel not found", ref });
        return;
      }

      // Broadcast config update to all participants (including sender)
      this.broadcastConfigUpdate(client.channel, newConfig, client.ws, ref);
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

  private handleClientBinaryMessage(client: ClientConnection, msg: ClientMessage, attachmentBlob: Buffer): void {
    if (msg.action !== "publish") {
      this.send(client.ws, { kind: "error", error: "unknown action", ref: msg.ref });
      return;
    }

    const { type, payload, persist = true, ref, attachmentMeta } = msg;
    const ts = Date.now();

    // Parse attachments from binary blob using metadata
    // Binary frames require valid attachment metadata - reject malformed frames
    if (!attachmentMeta || attachmentMeta.length === 0) {
      this.send(client.ws, { kind: "error", error: "binary frame requires attachmentMeta", ref });
      return;
    }

    const attachments: ServerAttachment[] = [];
    let offset = 0;
    for (const meta of attachmentMeta) {
      // Validate size doesn't exceed blob bounds
      if (offset + meta.size > attachmentBlob.length) {
        this.send(client.ws, { kind: "error", error: "attachmentMeta size exceeds blob length", ref });
        return;
      }
      const data = attachmentBlob.subarray(offset, offset + meta.size);
      // Generate a unique ID for this attachment
      const attachmentId = this.generateAttachmentId(client.channel);
      attachments.push({
        id: attachmentId,
        data: Buffer.from(data), // Copy to avoid issues with buffer reuse
        mimeType: meta.mimeType,
        name: meta.name,
      });
      offset += meta.size;
    }

    // Validate payload is serializable
    let payloadJson: string;
    try {
      payloadJson = JSON.stringify(payload);
    } catch {
      this.send(client.ws, { kind: "error", error: "payload not serializable", ref });
      return;
    }

    if (persist) {
      // Persist payload + attachments to message store
      const id = this.messageStore.insert(
        client.channel,
        type,
        payloadJson,
        client.clientId,
        ts,
        client.metadata,
        attachments
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
          attachments,
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
          attachments,
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

  /**
   * Broadcast a config update to all participants in a channel.
   * Config updates are ephemeral (not persisted) since the config is stored separately.
   */
  private broadcastConfigUpdate(
    channel: string,
    config: ChannelConfig,
    senderWs: WebSocket,
    senderRef?: number
  ): void {
    const state = this.channels.get(channel);
    if (!state) return;

    // Config update message format
    const msg = {
      kind: "config-update" as const,
      channelConfig: config,
    };

    const dataForOthers = JSON.stringify(msg);
    const dataForSender = senderRef !== undefined
      ? JSON.stringify({ ...msg, ref: senderRef })
      : dataForOthers;

    for (const client of state.clients) {
      if (client.ws.readyState === WebSocket.OPEN) {
        const data = client.ws === senderWs ? dataForSender : dataForOthers;
        client.ws.send(data);
      }
    }
  }

  private sendBinary(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState !== WebSocket.OPEN) return;

    const attachments = msg.attachments!;
    const attachmentMeta = attachments.map((a) => ({
      id: a.id,
      mimeType: a.mimeType,
      name: a.name,
      size: a.data.length,
    }));
    const totalSize = attachments.reduce((sum, a) => sum + a.data.length, 0);

    const metadata = {
      kind: msg.kind,
      id: msg.id,
      type: msg.type,
      payload: msg.payload,
      senderId: msg.senderId,
      ts: msg.ts,
      ref: msg.ref,
      senderMetadata: msg.senderMetadata,
      attachmentMeta,
    };

    const metadataStr = JSON.stringify(metadata);
    const metadataBytes = Buffer.from(metadataStr, "utf-8");
    const metadataLen = metadataBytes.length;

    // Create buffer: 1 byte marker (0) + 4 bytes metadata length + metadata + all attachments
    const buffer = Buffer.allocUnsafe(1 + 4 + metadataLen + totalSize);
    buffer.writeUInt8(0, 0); // Binary frame marker
    buffer.writeUInt32LE(metadataLen, 1); // Metadata length
    metadataBytes.copy(buffer, 5);

    // Copy all attachments sequentially
    let offset = 5 + metadataLen;
    for (const attachment of attachments) {
      attachment.data.copy(buffer, offset);
      offset += attachment.data.length;
    }

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

    const attachments = msg.attachments!;
    const attachmentMeta = attachments.map((a) => ({
      id: a.id,
      mimeType: a.mimeType,
      name: a.name,
      size: a.data.length,
    }));
    const totalSize = attachments.reduce((sum, a) => sum + a.data.length, 0);

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
        attachmentMeta,
        ...(includeRef && senderRef !== undefined ? { ref: senderRef } : {}),
      };

      const metadataStr = JSON.stringify(metadata);
      const metadataBytes = Buffer.from(metadataStr, "utf-8");
      const metadataLen = metadataBytes.length;

      const buffer = Buffer.allocUnsafe(1 + 4 + metadataLen + totalSize);
      buffer.writeUInt8(0, 0);
      buffer.writeUInt32LE(metadataLen, 1);
      metadataBytes.copy(buffer, 5);

      // Copy all attachments sequentially
      let offset = 5 + metadataLen;
      for (const attachment of attachments) {
        attachment.data.copy(buffer, offset);
        offset += attachment.data.length;
      }

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

      // Presence/roster events don't have attachments, always send as JSON
      this.send(ws, msg);
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
    senderRef?: number,
    leaveReason?: LeaveReason
  ): void {
    const ts = Date.now();
    const payload: PresencePayload = {
      action,
      metadata,
      ...(leaveReason && { leaveReason }),
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
