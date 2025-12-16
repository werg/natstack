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
  insert(channel: string, type: string, payload: string, senderId: string, ts: number): number;
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
  /** For roster messages: map of client ID to participant info */
  participants?: Record<string, Participant>;
}

interface ClientMessage {
  action: "publish";
  persist?: boolean;
  type: string;
  payload: unknown;
  ref?: number;
}

interface MessageRow {
  id: number;
  channel: string;
  type: string;
  payload: string;
  sender_id: string;
  ts: number;
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
        ts INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_channel_id ON messages(channel, id);
    `
    );
  }

  insert(channel: string, type: string, payload: string, senderId: string, ts: number): number {
    if (!this.dbHandle) throw new Error("Store not initialized");
    const db = getDatabaseManager();
    const result = db.run(
      this.dbHandle,
      "INSERT INTO messages (channel, type, payload, sender_id, ts) VALUES (?, ?, ?, ?, ?)",
      [channel, type, payload, senderId, ts]
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
      getDatabaseManager().close(this.dbHandle);
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

  insert(channel: string, type: string, payload: string, senderId: string, ts: number): number {
    const id = this.nextId++;
    this.messages.push({ id, channel, type, payload, sender_id: senderId, ts });
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

    // Broadcast updated roster to all clients in the channel
    this.broadcastRoster(channel);

    // Handle incoming messages
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString()) as ClientMessage;
        this.handleClientMessage(client, msg);
      } catch {
        this.send(ws, { kind: "error", error: "invalid message format" });
      }
    });

    // Cleanup on disconnect
    ws.on("close", () => {
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
      this.send(ws, {
        kind: "replay",
        id: row.id,
        type: row.type,
        payload: JSON.parse(row.payload),
        senderId: row.sender_id,
        ts: row.ts,
      });
    }
  }

  private handleClientMessage(client: Client, msg: ClientMessage): void {
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
      // Persist to message store
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

  /**
   * Broadcast the current roster (participants with metadata) to all clients in a channel.
   * This is an idempotent operation - clients receive the full current state.
   * When a client has multiple connections, uses the metadata from the most recent connection.
   */
  private broadcastRoster(channel: string): void {
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

    const data = JSON.stringify(rosterMsg);
    for (const client of clients) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(data);
      }
    }
  }

  getPort(): number | null {
    return this.port;
  }

  async stop(): Promise<void> {
    this.messageStore?.close();

    return new Promise((resolve) => {
      if (this.wss) {
        this.wss.close(() => {
          this.httpServer?.close(() => resolve());
        });
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
