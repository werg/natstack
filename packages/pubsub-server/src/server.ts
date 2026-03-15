/**
 * WebSocket pub/sub server with SQLite persistence.
 *
 * Provides pub/sub channels for arbitrary JSON messages with optional
 * persistence to SQLite and replay on reconnection.
 */

import { WebSocketServer, WebSocket } from "ws";
import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from "http";
import {
  type TokenValidator,
  type ChannelConfig,
  type ChannelInfo,
  type ChannelAgentRow,
  type MessageStore,
  type MessageRow,
  type ServerAttachment,
  metadataEquals,
  deserializeAttachments,
  serializeMetadata,
} from "./messageStore.js";

// Re-export message store types and classes for convenience
export { SqliteMessageStore, InMemoryMessageStore, TestTokenValidator } from "./messageStore.js";
export type { TokenValidator, ChannelConfig, ChannelInfo, ChannelForkInfo, ForkSegment, ChannelAgentRow, MessageStore, MessageRow, ServerAttachment, DatabaseManagerLike } from "./messageStore.js";

// =============================================================================
// Injectable dependency interfaces
// =============================================================================

/** Logger interface matching createDevLogger() output shape. */
export interface Logger {
  verbose(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/** Function that finds an available port. */
export type PortFinder = () => Promise<number>;

const defaultLogger: Logger = {
  verbose: () => {},
  info: (msg, ...args) => console.log(`[PubSubServer] ${msg}`, ...args),
  warn: (msg, ...args) => console.warn(`[PubSubServer] ${msg}`, ...args),
  error: (msg, ...args) => console.error(`[PubSubServer] ${msg}`, ...args),
};

let log: Logger = defaultLogger;

/**
 * Server configuration options.
 */
export interface PubSubServerOptions {
  /** Token validator */
  tokenValidator: TokenValidator;
  /** Message store implementation */
  messageStore: MessageStore;
  /** Port to listen on (defaults to dynamic allocation) */
  port?: number;
  /** Custom logger (defaults to console-based) */
  logger?: Logger;
  /** Port finder for dynamic allocation (required if port is not set) */
  findPort?: PortFinder;
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
  /** Callback participants (server-side, no WebSocket connection) */
  callbacks: Map<string, CallbackParticipant>;
  /** Counter for generating unique attachment IDs within this channel */
  nextAttachmentId: number;
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
  kind: "replay" | "persisted" | "ephemeral" | "ready" | "error" | "messages-before";
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
  /** Total message count for pagination (sent in ready message) */
  totalCount?: number;
  /** Count of type="message" events only, for accurate chat pagination */
  chatMessageCount?: number;
  /** ID of the first chat message in the channel (for pagination boundary) */
  firstChatMessageId?: number;
  /** Messages returned for get-messages-before (sent in messages-before response) */
  messages?: Array<{
    id: number;
    type: string;
    payload: unknown;
    senderId: string;
    ts: number;
    senderMetadata?: Record<string, unknown>;
  }>;
  /** Whether there are more messages before these (sent in messages-before response) */
  hasMore?: boolean;
  /** Trailing updates for boundary messages (messages-before response) */
  trailingUpdates?: Array<{
    id: number;
    type: string;
    payload: unknown;
    senderId: string;
    ts: number;
    senderMetadata?: Record<string, unknown>;
  }>;
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

// =============================================================================
// Channel event + callback participant API
// =============================================================================

/** Event emitted to channel event listeners after a message is broadcast. */
export interface ChannelBroadcastEvent {
  id: number;
  type: string;
  payload: string;
  senderId: string;
  ts: number;
  senderMetadata?: string;
  persist: boolean;
  attachments?: ServerAttachment[];
}

/** Callback interface for server-side participants receiving channel events. */
export interface ParticipantCallback {
  onEvent(event: ChannelBroadcastEvent): void;
}

/** Options for sending a message via ParticipantHandle. */
export interface SendMessageOptions {
  /** Semantic content type (e.g., "thinking", "action", "typing").
   *  Embedded as payload.contentType — NOT used as the PubSub event type. */
  contentType?: string;
  persist?: boolean;
  senderMetadata?: Record<string, unknown>;
  replyTo?: string;
}

/** Handle returned by registerParticipant for sending messages and managing lifecycle.
 *  Methods match the client-side protocol (sendMessage/updateMessage/completeMessage)
 *  so callers can't accidentally misuse the wire format. */
export interface ParticipantHandle {
  sendMessage(messageId: string, content: string, options?: SendMessageOptions): void;
  updateMessage(messageId: string, content: string): void;
  completeMessage(messageId: string): void;
  sendMethodCall(callId: string, providerId: string, methodName: string, args: unknown): void;
  sendMethodResult(callId: string, content: unknown, isError?: boolean): void;
  updateMetadata(metadata: Record<string, unknown>): void;
  leave(): void;
}

/** A callback-based participant registered on a channel. */
export interface CallbackParticipant {
  id: string;
  metadata: Record<string, unknown>;
  callback: ParticipantCallback;
}

// ─── Async queue (ordered delivery for POST-back participants) ──────────────

function createPostbackQueue() {
  let chain = Promise.resolve();
  return {
    enqueue(fn: () => Promise<void>): void {
      chain = chain.then(fn).catch((err) => {
        log.error("[PubSub] POST-back queue item error:", err);
      });
    },
  };
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

interface GetMessagesBeforeClientMessage {
  action: "get-messages-before";
  beforeId: number;
  limit?: number;
  ref?: number;
}

type ClientMessage =
  | PublishClientMessage
  | UpdateMetadataClientMessage
  | CloseClientMessage
  | UpdateConfigClientMessage
  | GetMessagesBeforeClientMessage;

export class PubSubServer {
  private wss: WebSocketServer | null = null;
  private httpServer: HttpServer | null = null;
  private port: number | null = null;
  private channels = new Map<string, ChannelState>();
  /** Tracks channels where ghost participants have already been cleaned up (once per server session). */
  private ghostsCleanedChannels = new Set<string>();

  private tokenValidator: TokenValidator;
  private messageStore: MessageStore;
  private requestedPort: number | undefined;
  private findPort: PortFinder | undefined;
  private channelEventListeners: Array<(channel: string, event: ChannelBroadcastEvent) => void> = [];
  /** In-flight async method calls — keyed by callId, abortable via cancel-call */
  private pendingCallAborts = new Map<string, AbortController>();
  /** Resolves the current workerd port for POST-back URL construction */
  private getPostbackPort: (() => number | null) | null = null;
  /** Callback to ensure a DO is reachable (service registered, process alive, bootstrapped) */
  private ensureDOFn: ((source: string, className: string, objectKey: string) => Promise<void>) | null = null;

  constructor(options: PubSubServerOptions) {
    this.tokenValidator = options.tokenValidator;
    this.messageStore = options.messageStore;
    this.requestedPort = options.port;
    this.findPort = options.findPort;
    if (options.logger) log = options.logger;
  }

  async start(): Promise<number> {
    if (this.requestedPort === undefined) {
      if (!this.findPort) throw new Error("PubSubServer requires either a port or a findPort function");
      this.port = await this.findPort();
    }

    // Create HTTP server for WebSocket upgrade and HTTP API endpoints
    this.httpServer = createServer((req, res) => this.handleHttpRequest(req, res));
    this.wss = new WebSocketServer({ server: this.httpServer });
    this.messageStore.init();

    this.wss.on("connection", (ws, req) => this.handleConnection(ws, req));

    const listenPort = this.requestedPort ?? this.port!;
    await new Promise<void>((resolve, reject) => {
      this.httpServer!.once("error", reject);
      this.httpServer!.listen(listenPort, "127.0.0.1", () => resolve());
    });

    // Get actual port (important when requestedPort is 0)
    const addr = this.httpServer.address();
    if (addr && typeof addr === "object") {
      this.port = addr.port;
    }

    log.verbose(`[PubSub] Server listening on port ${this.port}`);
    return this.port!;
  }

  /** Set the port resolver for constructing POST-back URLs at delivery time. */
  setPostbackPortResolver(fn: () => number | null): void {
    this.getPostbackPort = fn;
  }

  /** Set the ensureDO callback for ghost cleanup (fire-and-forget DO recovery). */
  setEnsureDO(fn: (source: string, className: string, objectKey: string) => Promise<void>): void {
    this.ensureDOFn = fn;
  }

  /** Resolve the full POST-back URL for a participant ID at delivery time. Returns null if port not yet available. */
  private resolvePostbackUrl(participantId: string): string | null {
    const port = this.getPostbackPort?.();
    if (!port) return null;
    return `http://127.0.0.1:${port}${participantId}/onChannelEvent`;
  }

  /** Check if a participant on a channel is a POST-back participant. */
  private isPostbackParticipant(channelId: string, participantId: string): boolean {
    const state = this.channels.get(channelId);
    const cb = state?.callbacks.get(participantId);
    return cb?.metadata["transport"] === "post";
  }

  /**
   * Register a POST-back callback participant — shared by subscribe and ghost cleanup.
   * When emitPresence is true, a join event is published. When false (ghost recovery),
   * the participant is silently added to callbacks without a join event.
   */
  private registerPostbackCallback(
    channelId: string,
    participantId: string,
    metadata: Record<string, unknown>,
    emitPresence: boolean,
  ): void {
    const queue = createPostbackQueue();

    const onEvent = (event: ChannelBroadcastEvent) => {
      if (event.senderId === participantId) return;
      queue.enqueue(async () => {
        const body = JSON.stringify([channelId, event]);

        // Attempt delivery — resolve URL, POST
        let url = this.resolvePostbackUrl(participantId);
        let delivered = false;
        if (url) {
          try {
            await httpPost(url, body);
            delivered = true;
          } catch { /* fall through to recovery */ }
        }

        if (!delivered) {
          // Port not available or POST failed — ensure the DO is alive, then retry
          try { await this.ensureDOForParticipant(participantId); } catch { /* best-effort */ }
          url = this.resolvePostbackUrl(participantId);
          if (url) {
            try { await httpPost(url, body); }
            catch (retryErr) { log.error(`[PubSub] POST-back retry failed for ${participantId}:`, retryErr); }
          } else {
            log.error(`[PubSub] POST-back failed for ${participantId}: workerd port still unavailable after ensureDO`);
          }
        }
      });
    };

    if (emitPresence) {
      this.registerParticipant(channelId, participantId, metadata, { onEvent });
    } else {
      const state = this.getOrCreateChannelState(channelId);
      state.callbacks.set(participantId, { id: participantId, metadata, callback: { onEvent } });
    }
  }

  /**
   * Parse a participant ID into DO components and call ensureDO.
   * Participant ID format: /_w/{source0}/{source1}/{className}/{objectKey}
   */
  private async ensureDOForParticipant(participantId: string): Promise<void> {
    const parts = participantId.split("/").filter(Boolean);
    if (parts.length < 5 || parts[0] !== "_w" || !this.ensureDOFn) return;
    const source = `${parts[1]}/${parts[2]}`;
    // Participant IDs have percent-encoded className/objectKey — decode for ensureDO
    const className = decodeURIComponent(parts[3]!);
    const objectKey = decodeURIComponent(parts[4]!);
    await this.ensureDOFn(source, className, objectKey);
  }

  private getOrCreateChannelState(channel: string): ChannelState {
    let state = this.channels.get(channel);
    if (!state) {
      // Initialize counter from database to ensure continuity after restarts
      const maxId = this.messageStore.getMaxAttachmentIdNumber(channel);
      state = { clients: new Set(), participants: new Map(), callbacks: new Map(), nextAttachmentId: maxId + 1 };
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
    const replayMessageLimitParam = url.searchParams.get("replayMessageLimit");
    const replayMessageLimit = replayMessageLimitParam ? parseInt(replayMessageLimitParam, 10) : null;
    const contextIdParam = url.searchParams.get("contextId");
    const channelConfigParam = url.searchParams.get("channelConfig");
    const channelConfigFromClient = channelConfigParam ? JSON.parse(channelConfigParam) as ChannelConfig : undefined;

    // Metadata starts empty - clients send metadata via update-metadata after connection
    const metadata: Record<string, unknown> = {};

    // Validate token
    const entry = this.tokenValidator.validateToken(token);
    const clientId = entry?.callerId ?? null;
    if (!clientId) {
      console.warn(`[PubSubServer] Rejected connection - invalid token`);
      ws.close(4001, "unauthorized");
      return;
    }
    log.verbose(`Accepted connection from ${clientId}`);

    if (!channel) {
      ws.close(4002, "channel required");
      return;
    }

    // Check if channel exists in the message store
    const existingChannel = this.messageStore.getChannel(channel);
    let channelContextId: string | undefined;
    let channelConfig: ChannelConfig | undefined;

    if (!existingChannel) {
      // Every channel must have a contextId
      if (!contextIdParam) {
        ws.close(4003, "contextId required");
        return;
      }
      this.messageStore.createChannel(channel, contextIdParam, clientId, channelConfigFromClient);
      // Re-fetch to get actual contextId (in case another client won the race)
      const created = this.messageStore.getChannel(channel);
      channelContextId = created?.contextId;
      channelConfig = created?.config;

      // Verify the channel was created with our contextId (only if we provided one)
      // This handles the rare race condition where two clients try to create
      // the same channel with different contextIds simultaneously
      if (contextIdParam && channelContextId && channelContextId !== contextIdParam) {
        ws.close(4005, "contextId mismatch: channel was created by another client");
        return;
      }
    } else {
      // Subsequent connections - validate contextId consistency
      // If client provides a contextId, it must match the channel's contextId
      // Clients can omit contextId to join without validation
      // Note: URLSearchParams.get() returns null (not undefined) for absent params
      if (contextIdParam != null && contextIdParam !== existingChannel.contextId) {
        ws.close(4005, "contextId mismatch");
        return;
      }
      channelContextId = existingChannel.contextId;
      channelConfig = existingChannel.config;
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

    // Clean up ghost participants from previous server sessions (runs once per channel)
    this.cleanupGhostParticipants(channel);

    // Send roster-op history before any normal replay
    this.replayRosterOps(ws, channel);

    // Replay if requested
    if (sinceId !== null) {
      // Client-provided sinceId wins (reconnect scenario)
      this.replayMessages(ws, channel, sinceId);
    } else if (replayMessageLimit !== null && replayMessageLimit > 0) {
      // Anchored replay: find the Nth-from-last "message" type row
      const anchorId = this.messageStore.getAnchorId(channel, "message", replayMessageLimit - 1);
      if (anchorId !== null) {
        // Replay from just before the anchor (replayMessages uses id > sinceId)
        this.replayMessages(ws, channel, anchorId - 1);
      } else {
        // Fewer than N chat messages exist — full replay
        this.replayMessages(ws, channel, 0);
      }
    }

    // Get total message count for pagination support
    const totalCount = this.messageStore.getMessageCount(channel);
    // Count only user-visible "message" type events (excludes protocol chatter
    // like method-call, presence, tool-role-*, agent-debug, etc.)
    const chatMessageCount = this.messageStore.getMessageCount(channel, "message");
    // Get the first chat message ID for pagination boundary detection
    const firstChatMessageId = this.messageStore.getMinMessageId(channel, "message");

    // Signal ready (end of replay) with contextId, channelConfig, and totalCount
    this.send(ws, { kind: "ready", contextId: channelContextId, channelConfig, totalCount, chatMessageCount, firstChatMessageId });

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

      if (state.clients.size === 0 && state.callbacks.size === 0) {
        this.channels.delete(channel);
      }
    });
  }

  private replayMessages(ws: WebSocket, channel: string, sinceId: number): void {
    // Resolve fork chain and replay across all segments
    const segments = this.messageStore.resolveForkedSegments(channel);

    for (const seg of segments) {
      // sinceId works because IDs are globally monotonic — it naturally filters
      // out messages the client has already seen, even across fork boundaries.
      const rows = this.messageStore.queryRange(seg.channel, sinceId, seg.upToId);

      for (const row of rows) {
        // Skip presence events — they're already fully covered by replayRosterOps()
        // which replays ALL presence from the beginning. Including them here would
        // send duplicates that the client has to dedup via rosterOpIds.
        // Presence is NOT inherited from parent channels.
        if (row.type === "presence") continue;

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

    if (msg.action === "get-messages-before") {
      const { beforeId, limit = 100 } = msg;
      if (typeof beforeId !== "number" || beforeId < 0) {
        this.send(client.ws, { kind: "error", error: "beforeId must be a non-negative number", ref });
        return;
      }

      // Query one extra message to reliably detect if there are more
      const effectiveLimit = Math.min(limit, 500);
      const rows = this.messageStore.queryBefore(client.channel, beforeId, effectiveLimit + 1);

      // Check if there are more messages beyond what we'll return
      const hasMore = rows.length > effectiveLimit;

      // Only return up to the requested limit
      const rowsToReturn = hasMore ? rows.slice(0, effectiveLimit) : rows;

      // Convert to response format (including attachments)
      const messages = rowsToReturn.map((row) => {
        let payload: unknown;
        try {
          payload = JSON.parse(row.payload);
        } catch {
          payload = row.payload;
        }
        let senderMetadata: Record<string, unknown> | undefined;
        if (row.sender_metadata) {
          try {
            senderMetadata = JSON.parse(row.sender_metadata);
          } catch {
            // Ignore parse errors
          }
        }
        // Deserialize attachments from storage
        const attachments = deserializeAttachments(row.attachment);
        return {
          id: row.id,
          type: row.type,
          payload,
          senderId: row.sender_id,
          ts: row.ts,
          senderMetadata,
          attachments,
        };
      });

      // Fetch trailing update-message/error events beyond the page boundary
      // for message UUIDs in the page (ensures boundary messages are complete)
      const messageUuids: string[] = [];
      const highestRowId = rowsToReturn.length > 0 ? rowsToReturn[rowsToReturn.length - 1]!.id : 0;
      for (const msg of messages) {
        if (msg.type === "message" && typeof msg.payload === "object" && msg.payload !== null) {
          const uuid = (msg.payload as { id?: string }).id;
          if (uuid) messageUuids.push(uuid);
        }
      }

      let trailingUpdates: typeof messages = [];
      if (messageUuids.length > 0 && highestRowId > 0) {
        const trailingRows = this.messageStore.queryTrailingUpdates(
          client.channel, messageUuids, highestRowId + 1
        );
        trailingUpdates = trailingRows.map(row => {
          let payload: unknown;
          try { payload = JSON.parse(row.payload); } catch { payload = row.payload; }
          let senderMetadata: Record<string, unknown> | undefined;
          if (row.sender_metadata) {
            try { senderMetadata = JSON.parse(row.sender_metadata); } catch { /* ignore */ }
          }
          const attachments = deserializeAttachments(row.attachment);
          return { id: row.id, type: row.type, payload, senderId: row.sender_id, ts: row.ts, senderMetadata, attachments };
        });
      }

      this.send(client.ws, { kind: "messages-before", messages, trailingUpdates, hasMore, ref });
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
    senderWs: WebSocket | null,
    senderRef?: number
  ): void {
    const state = this.channels.get(channel);
    if (!state) return;

    // Build ChannelBroadcastEvent for listeners and callbacks
    const isPersisted = msg.kind === "persisted";
    const event: ChannelBroadcastEvent = {
      id: msg.id ?? 0,
      type: msg.type ?? "",
      payload: typeof msg.payload === "string" ? msg.payload : JSON.stringify(msg.payload),
      senderId: msg.senderId ?? "",
      ts: msg.ts ?? 0,
      senderMetadata: msg.senderMetadata ? JSON.stringify(msg.senderMetadata) : undefined,
      persist: isPersisted,
      attachments: msg.attachments,
    };

    // Notify channel event listeners
    for (const listener of this.channelEventListeners) {
      try {
        listener(channel, event);
      } catch (err) { console.error(`[PubSub] Channel event listener error:`, err); }
    }

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

    // Notify callback participants (skip sender to avoid echo)
    const senderParticipantId = msg.senderId;
    for (const [cbId, cb] of state.callbacks) {
      if (cbId !== senderParticipantId) {
        try { cb.callback.onEvent(event); } catch (err) { console.error(`[PubSub] Callback participant ${cbId} onEvent error:`, err); }
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

    // Notify callback participants of config update
    for (const [, cb] of state.callbacks) {
      try {
        cb.callback.onEvent({
          id: 0,
          type: "config-update",
          payload: JSON.stringify(config),
          senderId: "",
          ts: Date.now(),
          persist: false,
        });
      } catch (err) { console.error(`[PubSub] Callback participant config-update error:`, err); }
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
    senderWs: WebSocket | null,
    senderRef?: number
  ): void {
    const state = this.channels.get(channel);
    if (!state) return;

    // Build ChannelBroadcastEvent for listeners and callbacks
    const isPersisted = msg.kind === "persisted";
    const event: ChannelBroadcastEvent = {
      id: msg.id ?? 0,
      type: msg.type ?? "",
      payload: typeof msg.payload === "string" ? msg.payload : JSON.stringify(msg.payload),
      senderId: msg.senderId ?? "",
      ts: msg.ts ?? 0,
      senderMetadata: msg.senderMetadata ? JSON.stringify(msg.senderMetadata) : undefined,
      persist: isPersisted,
      attachments: msg.attachments,
    };

    // Notify channel event listeners
    for (const listener of this.channelEventListeners) {
      try {
        listener(channel, event);
      } catch (err) { console.error(`[PubSub] Channel event listener error:`, err); }
    }

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

    // Notify callback participants (skip sender to avoid echo)
    const senderParticipantId = msg.senderId;
    for (const [cbId, cb] of state.callbacks) {
      if (cbId !== senderParticipantId) {
        try { cb.callback.onEvent(event); } catch (err) { console.error(`[PubSub] Callback participant ${cbId} onEvent error:`, err); }
      }
    }
  }

  /**
   * Clean up ghost participants on first connection to a channel after server restart.
   *
   * When the server shuts down (or crashes), leave events for connected participants
   * may not be persisted. This leaves "ghost" entries in the DB that appear as active
   * participants on restart. This method detects ghosts by comparing the DB-reconstructed
   * roster against the server's live in-memory participants, and persists synthetic
   * "leave" events for any participant that is in the DB but not currently connected.
   *
   * Runs once per channel per server session (tracked by ghostsCleanedChannels).
   */
  private cleanupGhostParticipants(channel: string): void {
    if (this.ghostsCleanedChannels.has(channel)) return;
    this.ghostsCleanedChannels.add(channel);

    // Reconstruct roster state from DB presence events
    const rows = this.messageStore.queryByType(channel, ["presence"], 0);
    const rosterFromDb = new Map<string, Record<string, unknown>>();
    for (const row of rows) {
      const payload = JSON.parse(row.payload) as PresencePayload;
      if (payload.action === "join" || payload.action === "update") {
        rosterFromDb.set(row.sender_id, payload.metadata ?? {});
      } else if (payload.action === "leave") {
        rosterFromDb.delete(row.sender_id);
      }
    }

    // Compare against live participants (WS + callback)
    const channelState = this.channels.get(channel);
    const liveParticipants = channelState?.participants ?? new Map();
    const liveCallbacks = channelState?.callbacks ?? new Map();

    for (const [senderId, metadata] of rosterFromDb) {
      if (liveParticipants.has(senderId) || liveCallbacks.has(senderId)) continue;

      if (metadata["transport"] === "post") {
        // POST-back participant from previous session — set up delivery (no join event).
        // ensureDO is NOT called eagerly — the first delivery attempt triggers it on failure.
        this.registerPostbackCallback(channel, senderId, metadata, false);
      } else {
        // WebSocket ghost — synthetic leave
        const ts = Date.now();
        const payload: PresencePayload = { action: "leave", metadata, leaveReason: "disconnect" };
        try {
          this.messageStore.insert(channel, "presence", JSON.stringify(payload), senderId, ts, metadata);
        } catch { /* best-effort */ }
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

  // ===========================================================================
  // HTTP API endpoints
  // ===========================================================================

  /**
   * Read the full request body as a string. Returns "" for GET requests.
   */
  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      req.on("error", reject);
    });
  }

  /**
   * Send a JSON response.
   */
  private jsonResponse(res: ServerResponse, status: number, body: unknown): void {
    const data = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(data);
  }

  /**
   * Validate Bearer token from Authorization header.
   * Returns callerId on success, or sends 401 and returns null.
   */
  private validateHttpAuth(req: IncomingMessage, res: ServerResponse): string | null {
    const authHeader = req.headers["authorization"];
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      this.jsonResponse(res, 401, { error: "missing or invalid Authorization header" });
      return null;
    }
    const token = authHeader.slice(7);
    const entry = this.tokenValidator.validateToken(token);
    if (!entry?.callerId) {
      this.jsonResponse(res, 401, { error: "unauthorized" });
      return null;
    }
    return entry.callerId;
  }

  /**
   * Route incoming HTTP requests to the appropriate handler.
   * Handles /channel/{channelId}/{action} endpoints.
   */
  private async handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url || "", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);

      // Route: /channel/{channelId}/{action}
      if (parts.length === 3 && parts[0] === "channel") {
        const channelId = decodeURIComponent(parts[1]!);
        const action = parts[2]!;

        // Validate auth for all channel endpoints
        const callerId = this.validateHttpAuth(req, res);
        if (!callerId) return;

        if (req.method === "GET" && action === "participants") {
          return this.handleGetParticipants(res, channelId);
        }

        if (req.method === "POST") {
          const bodyStr = await this.readBody(req);
          let body: Record<string, unknown>;
          try {
            body = JSON.parse(bodyStr) as Record<string, unknown>;
          } catch {
            this.jsonResponse(res, 400, { error: "invalid JSON body" });
            return;
          }

          switch (action) {
            case "send":
              return this.handleSend(res, channelId, body);
            case "update":
              return this.handleUpdate(res, channelId, body);
            case "complete":
              return this.handleComplete(res, channelId, body);
            case "send-ephemeral":
              return this.handleSendEphemeral(res, channelId, body);
            case "update-metadata":
              return this.handleUpdateMetadata(res, channelId, body);
            case "subscribe":
              return this.handleSubscribe(res, channelId, body);
            case "unsubscribe":
              return this.handleUnsubscribe(res, channelId, body);
            case "call-method":
              return this.handleCallMethod(res, channelId, body);
            case "cancel-call":
              return this.handleCancelCall(res, channelId, body);
            default:
              this.jsonResponse(res, 404, { error: `unknown action: ${action}` });
              return;
          }
        }

        this.jsonResponse(res, 405, { error: "method not allowed" });
        return;
      }

      this.jsonResponse(res, 404, { error: "not found" });
    } catch (err) {
      log.error("[PubSub] HTTP handler error:", err);
      if (!res.headersSent) {
        this.jsonResponse(res, 500, { error: "internal server error" });
      }
    }
  }

  // ─── Channel operation handlers ───────────────────────────────────────────

  /**
   * POST /channel/{channelId}/send
   * Body: { participantId, messageId, content, contentType?, persist?, senderMetadata?, replyTo? }
   */
  private handleSend(res: ServerResponse, channelId: string, body: Record<string, unknown>): void {
    const { participantId, messageId, content, contentType, persist, senderMetadata, replyTo } = body as {
      participantId: string; messageId: string; content: string;
      contentType?: string; persist?: boolean; senderMetadata?: Record<string, unknown>; replyTo?: string;
    };
    if (!participantId || !messageId || content === undefined) {
      this.jsonResponse(res, 400, { error: "participantId, messageId, and content are required" });
      return;
    }

    // Find the ParticipantHandle — check postback first, then channel callbacks
    const handle = this.findParticipantHandle(channelId, participantId);
    if (!handle) {
      this.jsonResponse(res, 404, { error: `participant ${participantId} not found on channel ${channelId}` });
      return;
    }

    handle.sendMessage(messageId, String(content), {
      contentType: contentType as string | undefined,
      persist: persist as boolean | undefined,
      senderMetadata: senderMetadata as Record<string, unknown> | undefined,
      replyTo: replyTo as string | undefined,
    });
    this.jsonResponse(res, 200, { ok: true });
  }

  /**
   * POST /channel/{channelId}/update
   * Body: { participantId, messageId, content }
   */
  private handleUpdate(res: ServerResponse, channelId: string, body: Record<string, unknown>): void {
    const { participantId, messageId, content } = body as {
      participantId: string; messageId: string; content: string;
    };
    if (!participantId || !messageId || content === undefined) {
      this.jsonResponse(res, 400, { error: "participantId, messageId, and content are required" });
      return;
    }

    const handle = this.findParticipantHandle(channelId, participantId);
    if (!handle) {
      this.jsonResponse(res, 404, { error: `participant ${participantId} not found on channel ${channelId}` });
      return;
    }

    handle.updateMessage(messageId, String(content));
    this.jsonResponse(res, 200, { ok: true });
  }

  /**
   * POST /channel/{channelId}/complete
   * Body: { participantId, messageId }
   */
  private handleComplete(res: ServerResponse, channelId: string, body: Record<string, unknown>): void {
    const { participantId, messageId } = body as { participantId: string; messageId: string };
    if (!participantId || !messageId) {
      this.jsonResponse(res, 400, { error: "participantId and messageId are required" });
      return;
    }

    const handle = this.findParticipantHandle(channelId, participantId);
    if (!handle) {
      this.jsonResponse(res, 404, { error: `participant ${participantId} not found on channel ${channelId}` });
      return;
    }

    handle.completeMessage(messageId);
    this.jsonResponse(res, 200, { ok: true });
  }

  /**
   * POST /channel/{channelId}/send-ephemeral
   * Body: { participantId, content, contentType? }
   */
  private handleSendEphemeral(res: ServerResponse, channelId: string, body: Record<string, unknown>): void {
    const { participantId, content, contentType } = body as {
      participantId: string; content: string; contentType?: string;
    };
    if (!participantId || content === undefined) {
      this.jsonResponse(res, 400, { error: "participantId and content are required" });
      return;
    }

    const handle = this.findParticipantHandle(channelId, participantId);
    if (!handle) {
      this.jsonResponse(res, 404, { error: `participant ${participantId} not found on channel ${channelId}` });
      return;
    }

    // Generate a unique messageId for the ephemeral message, send with persist=false
    const ephemeralId = `eph_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    handle.sendMessage(ephemeralId, String(content), {
      contentType: contentType as string | undefined,
      persist: false,
    });
    this.jsonResponse(res, 200, { ok: true });
  }

  /**
   * POST /channel/{channelId}/update-metadata
   * Body: { participantId, metadata }
   */
  private handleUpdateMetadata(res: ServerResponse, channelId: string, body: Record<string, unknown>): void {
    const { participantId, metadata } = body as {
      participantId: string; metadata: Record<string, unknown>;
    };
    if (!participantId || !metadata || typeof metadata !== "object") {
      this.jsonResponse(res, 400, { error: "participantId and metadata (object) are required" });
      return;
    }

    const handle = this.findParticipantHandle(channelId, participantId);
    if (!handle) {
      this.jsonResponse(res, 404, { error: `participant ${participantId} not found on channel ${channelId}` });
      return;
    }

    handle.updateMetadata(metadata);
    this.jsonResponse(res, 200, { ok: true });
  }

  /**
   * GET /channel/{channelId}/participants
   * Returns [{ participantId, metadata }]
   */
  private handleGetParticipants(res: ServerResponse, channelId: string): void {
    const participants = this.getChannelParticipants(channelId);
    this.jsonResponse(res, 200, participants);
  }

  // ─── Subscription management handlers ─────────────────────────────────────

  /**
   * POST /channel/{channelId}/subscribe
   * Body: { participantId, metadata, callbackUrl }
   *
   * Registers a POST-back participant. Events are delivered via HTTP POST
   * to the callbackUrl with ordered delivery (async queue per participant).
   */
  private handleSubscribe(res: ServerResponse, channelId: string, body: Record<string, unknown>): void {
    const { participantId, metadata } = body as {
      participantId: string; metadata: Record<string, unknown>;
    };
    if (!participantId || !metadata) {
      this.jsonResponse(res, 400, { error: "participantId and metadata are required" });
      return;
    }

    // Idempotent re-subscribe: emit leave for old, then re-register with join
    const state = this.channels.get(channelId);
    if (state?.callbacks.has(participantId)) {
      const old = state.callbacks.get(participantId)!;
      this.publishPresenceEventForParticipant(channelId, participantId, "leave", old.metadata, "graceful");
      state.callbacks.delete(participantId);
    }

    if (metadata["transport"] === "post") {
      this.registerPostbackCallback(channelId, participantId, metadata, true);
    } else {
      this.registerParticipant(channelId, participantId, metadata, { onEvent: () => {} });
    }

    const channelInfo = this.messageStore.getChannel(channelId);
    const channelConfig = channelInfo?.config ?? {};
    this.jsonResponse(res, 200, { ok: true, channelConfig });
  }

  /**
   * POST /channel/{channelId}/unsubscribe
   * Body: { participantId }
   */
  private handleUnsubscribe(res: ServerResponse, channelId: string, body: Record<string, unknown>): void {
    const { participantId } = body as { participantId: string };
    if (!participantId) {
      this.jsonResponse(res, 400, { error: "participantId is required" });
      return;
    }

    const state = this.channels.get(channelId);
    const cb = state?.callbacks.get(participantId);
    if (!cb) {
      this.jsonResponse(res, 404, { error: `participant ${participantId} not found on channel ${channelId}` });
      return;
    }

    this.publishPresenceEventForParticipant(channelId, participantId, "leave", cb.metadata, "graceful");
    state!.callbacks.delete(participantId);
    if (state!.clients.size === 0 && state!.callbacks.size === 0) {
      this.channels.delete(channelId);
    }

    this.jsonResponse(res, 200, { ok: true });
  }

  // ─── Method call handlers ────────────────────────────────────────────────

  /**
   * POST /channel/{channelId}/call-method
   * Body: { callerParticipantId, callerCallbackUrl, targetParticipantId, callId, method, args }
   *
   * Async: returns 200 immediately. Result delivered via POST to callerCallbackUrl + "/onCallResult".
   */
  private handleCallMethod(res: ServerResponse, channelId: string, body: Record<string, unknown>): void {
    const { callerParticipantId, callerCallbackUrl, targetParticipantId, callId, method, args } = body as {
      callerParticipantId: string; callerCallbackUrl?: string;
      targetParticipantId: string; callId: string; method: string; args: unknown;
    };
    if (!callerParticipantId || !targetParticipantId || !callId || !method) {
      this.jsonResponse(res, 400, { error: "callerParticipantId, targetParticipantId, callId, and method are required" });
      return;
    }

    // Derive caller result URL: from explicit callerCallbackUrl, or from participant ID
    const resolvedCallerCallbackUrl = callerCallbackUrl
      ?? (this.isPostbackParticipant(channelId, callerParticipantId)
        ? this.resolvePostbackUrl(callerParticipantId)?.replace("/onChannelEvent", "") ?? null
        : null);
    if (!resolvedCallerCallbackUrl) {
      this.jsonResponse(res, 400, { error: "callerCallbackUrl required for non-POST-back callers" });
      return;
    }

    // Return 200 immediately — result delivered asynchronously
    this.jsonResponse(res, 200, { ok: true, callId });

    // Track for cancellation, fire async — deliver result via POST-back
    const abort = new AbortController();
    this.pendingCallAborts.set(callId, abort);
    void this.executeCallMethod(channelId, callerParticipantId, resolvedCallerCallbackUrl, targetParticipantId, callId, method, args, abort.signal)
      .finally(() => this.pendingCallAborts.delete(callId));
  }

  /**
   * Execute a method call against a target participant and POST the result back to the caller.
   */
  private async executeCallMethod(
    channelId: string,
    callerParticipantId: string,
    callerCallbackUrl: string,
    targetParticipantId: string,
    callId: string,
    method: string,
    args: unknown,
    signal: AbortSignal,
  ): Promise<void> {
    const resultUrl = callerCallbackUrl.replace(/\/$/, "") + "/onCallResult";

    try {
      if (signal.aborted) throw new Error("Call cancelled before execution");

      // Check if target is a POST-back participant (transport: "post" in metadata)
      const state = this.channels.get(channelId);
      const targetCb = state?.callbacks.get(targetParticipantId);
      if (targetCb?.metadata["transport"] === "post") {
        // Target is a POST-back participant — derive URL from participant ID
        const baseUrl = this.resolvePostbackUrl(targetParticipantId);
        if (!baseUrl) throw new Error("workerd port not available for method call target");
        const methodCallUrl = baseUrl.replace("/onChannelEvent", "/onMethodCall");
        const methodCallBody = JSON.stringify([channelId, callId, method, args]);
        const response = await httpPost(methodCallUrl, methodCallBody);
        if (signal.aborted) throw new Error("Call cancelled");
        // The response body is the method result
        const resultBody = await readFetchBody(response);
        let result: unknown;
        try { result = JSON.parse(resultBody); } catch { result = resultBody; }

        // POST result back to caller — derive URL from caller's participant ID if POST-back
        const callerCb = state?.callbacks.get(callerParticipantId);
        const callerUrl = callerCb?.metadata["transport"] === "post"
          ? this.resolvePostbackUrl(callerParticipantId)?.replace("/onChannelEvent", "/onCallResult") ?? null
          : null;
        await httpPost(callerUrl ?? resultUrl, JSON.stringify([callId, result, false]));
        return;
      }

      // Target is a WebSocket participant — broadcast method-call, wait for method-result
      const callerHandle = this.findParticipantHandle(channelId, callerParticipantId);
      if (!callerHandle) {
        await httpPost(resultUrl, JSON.stringify([callId, `caller ${callerParticipantId} not found`, true]));
        return;
      }

      const result = await new Promise<unknown>((resolve, reject) => {
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error(`Method call ${method} timed out after 5m (callId=${callId})`));
        }, 300_000);

        const unsub = this.onChannelEvent((ch, event) => {
          if (ch !== channelId || event.type !== "method-result") return;
          try {
            const payload = typeof event.payload === "string"
              ? JSON.parse(event.payload) as Record<string, unknown>
              : event.payload as Record<string, unknown>;
            if (payload && payload["callId"] === callId) {
              cleanup();
              if (payload["isError"]) {
                reject(new Error(typeof payload["content"] === "string" ? payload["content"] : JSON.stringify(payload["content"])));
              } else {
                resolve(payload["content"]);
              }
            }
          } catch { /* ignore parse errors */ }
        });

        // Abort handler — cancels the pending call
        const onAbort = () => {
          cleanup();
          reject(new Error(`Call cancelled (callId=${callId})`));
        };
        signal.addEventListener("abort", onAbort, { once: true });

        const cleanup = () => {
          clearTimeout(timeout);
          unsub();
          signal.removeEventListener("abort", onAbort);
        };

        // Broadcast method-call via caller's handle
        callerHandle.sendMethodCall(callId, targetParticipantId, method, args);
      });

      // POST result to caller
      await httpPost(resultUrl, JSON.stringify([callId, result, false]));
    } catch (err) {
      // Don't deliver error for cancelled calls — the caller already moved on
      if (signal.aborted) return;

      // Deliver error to caller
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error(`[PubSub] call-method failed (callId=${callId}, method=${method}):`, err);
      try {
        await httpPost(resultUrl, JSON.stringify([callId, errorMsg, true]));
      } catch (postErr) {
        log.error(`[PubSub] Failed to deliver call-method error to caller:`, postErr);
      }
    }
  }

  /**
   * POST /channel/{channelId}/cancel-call
   * Body: { callId }
   *
   * Currently a no-op placeholder — cancellation is not yet implemented
   * for in-flight method calls. Returns 200 to acknowledge the request.
   */
  private handleCancelCall(res: ServerResponse, _channelId: string, body: Record<string, unknown>): void {
    const { callId } = body as { callId: string };
    if (!callId) {
      this.jsonResponse(res, 400, { error: "callId is required" });
      return;
    }
    const abort = this.pendingCallAborts.get(callId);
    if (abort) {
      abort.abort();
      this.pendingCallAborts.delete(callId);
    }
    this.jsonResponse(res, 200, { ok: true, callId, cancelled: !!abort });
  }

  // ─── Handle lookup helpers ────────────────────────────────────────────────

  /**
   * Find the ParticipantHandle for a given participant on a channel.
   * Checks POST-back participants first, then in-process callback participants.
   */
  private findParticipantHandle(channelId: string, participantId: string): ParticipantHandle | null {
    const state = this.channels.get(channelId);
    if (!state) return null;

    // Check if participant is in callbacks or WS participants
    const isCallback = state.callbacks.has(participantId);
    const isWsParticipant = state.participants.has(participantId);
    if (!isCallback && !isWsParticipant) return null;

    // Get metadata from whichever participant type matches
    const metadata = isCallback
      ? state.callbacks.get(participantId)!.metadata
      : state.participants.get(participantId)!.metadata;

    // Create an ad-hoc handle that uses internal broadcast/insert
    return this.createAdHocHandle(channelId, participantId, metadata);
  }

  /**
   * Create an ad-hoc ParticipantHandle for an existing participant.
   * Used when HTTP endpoints need to act on behalf of a participant that was
   * not registered via POST /subscribe.
   */
  private createAdHocHandle(channelId: string, participantId: string, metadata: Record<string, unknown>): ParticipantHandle {
    return {
      sendMessage: (messageId: string, content: string, options?: SendMessageOptions) => {
        const persist = options?.persist !== false;
        const ts = Date.now();
        const payloadObj: Record<string, unknown> = { id: messageId, content };
        if (options?.replyTo) payloadObj["replyTo"] = options.replyTo;
        if (options?.contentType) payloadObj["contentType"] = options.contentType;
        const payloadJson = JSON.stringify(payloadObj);
        const senderMeta = options?.senderMetadata ?? metadata;

        if (persist) {
          const id = this.messageStore.insert(channelId, "message", payloadJson, participantId, ts, senderMeta);
          this.broadcast(channelId, {
            kind: "persisted", id, type: "message", payload: payloadObj, senderId: participantId, ts, senderMetadata: senderMeta,
          }, null);
        } else {
          this.broadcast(channelId, {
            kind: "ephemeral", type: "message", payload: payloadObj, senderId: participantId, ts, senderMetadata: senderMeta,
          }, null);
        }
      },

      updateMessage: (messageId: string, content: string) => {
        const ts = Date.now();
        const payloadObj: Record<string, unknown> = { id: messageId, content };
        const payloadJson = JSON.stringify(payloadObj);
        const id = this.messageStore.insert(channelId, "update-message", payloadJson, participantId, ts, metadata);
        this.broadcast(channelId, {
          kind: "persisted", id, type: "update-message", payload: payloadObj, senderId: participantId, ts, senderMetadata: metadata,
        }, null);
      },

      completeMessage: (messageId: string) => {
        const ts = Date.now();
        const payloadObj: Record<string, unknown> = { id: messageId, complete: true };
        const payloadJson = JSON.stringify(payloadObj);
        const id = this.messageStore.insert(channelId, "update-message", payloadJson, participantId, ts, metadata);
        this.broadcast(channelId, {
          kind: "persisted", id, type: "update-message", payload: payloadObj, senderId: participantId, ts, senderMetadata: metadata,
        }, null);
      },

      sendMethodCall: (callId: string, providerId: string, methodName: string, args: unknown) => {
        const ts = Date.now();
        const payloadObj = { callId, providerId, methodName, args };
        this.broadcast(channelId, {
          kind: "ephemeral", type: "method-call", payload: payloadObj, senderId: participantId, ts, senderMetadata: metadata,
        }, null);
      },

      sendMethodResult: (callId: string, content: unknown, isError?: boolean) => {
        const ts = Date.now();
        const payloadObj = { callId, content, complete: true, isError: isError ?? false };
        const payloadJson = JSON.stringify(payloadObj);
        const id = this.messageStore.insert(channelId, "method-result", payloadJson, participantId, ts, metadata);
        this.broadcast(channelId, {
          kind: "persisted", id, type: "method-result", payload: payloadObj, senderId: participantId, ts, senderMetadata: metadata,
        }, null);
      },

      updateMetadata: (newMetadata: Record<string, unknown>) => {
        // Preserve transport from existing metadata — it's a registration-time field
        const state = this.channels.get(channelId);
        if (state) {
          const cb = state.callbacks.get(participantId);
          if (cb) {
            if (cb.metadata["transport"]) newMetadata["transport"] = cb.metadata["transport"];
            cb.metadata = newMetadata;
          }
          const ws = state.participants.get(participantId);
          if (ws) ws.metadata = newMetadata;
        }
        this.publishPresenceEventForParticipant(channelId, participantId, "update", newMetadata);
      },

      leave: () => {
        // No-op for ad-hoc handles — the real leave happens via unsubscribe
      },
    };
  }

  getPort(): number | null {
    return this.port;
  }

  /**
   * Get metadata for all participants (both WebSocket and callback) on a channel.
   * Returns array of { participantId, metadata } for roster introspection.
   */
  getChannelParticipants(channel: string): Array<{ participantId: string; metadata: Record<string, unknown> }> {
    const state = this.channels.get(channel);
    if (!state) return [];

    const result: Array<{ participantId: string; metadata: Record<string, unknown> }> = [];
    for (const [pid, ps] of state.participants) {
      result.push({ participantId: pid, metadata: ps.metadata });
    }
    for (const [pid, cb] of state.callbacks) {
      result.push({ participantId: pid, metadata: cb.metadata });
    }
    return result;
  }

  /**
   * Register a listener for all channel broadcast events (persisted and ephemeral).
   * Returns an unsubscribe function. Supports multiple subscribers.
   */
  onChannelEvent(callback: (channel: string, event: ChannelBroadcastEvent) => void): () => void {
    this.channelEventListeners.push(callback);
    return () => {
      const idx = this.channelEventListeners.indexOf(callback);
      if (idx >= 0) this.channelEventListeners.splice(idx, 1);
    };
  }

  /**
   * Register a callback-based participant on a channel.
   * The participant appears in the roster like any WebSocket participant.
   * Returns a ParticipantHandle for sending messages and managing lifecycle.
   */
  registerParticipant(
    channel: string,
    participantId: string,
    metadata: Record<string, unknown>,
    callback: ParticipantCallback,
  ): ParticipantHandle {
    const state = this.getOrCreateChannelState(channel);
    const cbEntry: CallbackParticipant = { id: participantId, metadata, callback };
    state.callbacks.set(participantId, cbEntry);

    // Emit join presence event
    this.publishPresenceEventForParticipant(channel, participantId, "join", metadata);

    const handle: ParticipantHandle = {
      sendMessage: (messageId: string, content: string, options?: SendMessageOptions) => {
        const persist = options?.persist !== false;
        const ts = Date.now();
        const payloadObj: Record<string, unknown> = { id: messageId, content };
        if (options?.replyTo) payloadObj["replyTo"] = options.replyTo;
        if (options?.contentType) payloadObj["contentType"] = options.contentType;
        const payloadJson = JSON.stringify(payloadObj);
        const senderMeta = options?.senderMetadata ?? cbEntry.metadata;

        if (persist) {
          const id = this.messageStore.insert(channel, "message", payloadJson, participantId, ts, senderMeta);
          this.broadcast(channel, {
            kind: "persisted", id, type: "message", payload: payloadObj, senderId: participantId, ts, senderMetadata: senderMeta,
          }, null);
        } else {
          this.broadcast(channel, {
            kind: "ephemeral", type: "message", payload: payloadObj, senderId: participantId, ts, senderMetadata: senderMeta,
          }, null);
        }
      },

      updateMessage: (messageId: string, content: string) => {
        const ts = Date.now();
        const payloadObj: Record<string, unknown> = { id: messageId, content };
        const payloadJson = JSON.stringify(payloadObj);
        const id = this.messageStore.insert(channel, "update-message", payloadJson, participantId, ts, cbEntry.metadata);
        this.broadcast(channel, {
          kind: "persisted", id, type: "update-message", payload: payloadObj, senderId: participantId, ts, senderMetadata: cbEntry.metadata,
        }, null);
      },

      completeMessage: (messageId: string) => {
        const ts = Date.now();
        const payloadObj: Record<string, unknown> = { id: messageId, complete: true };
        const payloadJson = JSON.stringify(payloadObj);
        const id = this.messageStore.insert(channel, "update-message", payloadJson, participantId, ts, cbEntry.metadata);
        this.broadcast(channel, {
          kind: "persisted", id, type: "update-message", payload: payloadObj, senderId: participantId, ts, senderMetadata: cbEntry.metadata,
        }, null);
      },

      sendMethodCall: (callId: string, providerId: string, methodName: string, args: unknown) => {
        // Broadcast method-call with MethodCallSchema-compatible payload
        const ts = Date.now();
        const payloadObj = { callId, providerId, methodName, args };
        const payloadJson = JSON.stringify(payloadObj);
        this.broadcast(channel, {
          kind: "ephemeral", type: "method-call", payload: payloadObj, senderId: participantId, ts, senderMetadata: cbEntry.metadata,
        }, null);
      },

      sendMethodResult: (callId: string, content: unknown, isError?: boolean) => {
        const ts = Date.now();
        const payloadObj = { callId, content, complete: true, isError: isError ?? false };
        const payloadJson = JSON.stringify(payloadObj);
        const id = this.messageStore.insert(channel, "method-result", payloadJson, participantId, ts, cbEntry.metadata);
        this.broadcast(channel, {
          kind: "persisted", id, type: "method-result", payload: payloadObj, senderId: participantId, ts, senderMetadata: cbEntry.metadata,
        }, null);
      },

      updateMetadata: (newMetadata: Record<string, unknown>) => {
        // Preserve transport from existing metadata — it's a registration-time field
        if (cbEntry.metadata["transport"]) {
          newMetadata["transport"] = cbEntry.metadata["transport"];
        }
        cbEntry.metadata = newMetadata;
        this.publishPresenceEventForParticipant(channel, participantId, "update", newMetadata);
      },

      leave: () => {
        const st = this.channels.get(channel);
        if (st) {
          st.callbacks.delete(participantId);
          this.publishPresenceEventForParticipant(channel, participantId, "leave", cbEntry.metadata, "graceful");
          // Clean up channel state if empty
          if (st.clients.size === 0 && st.callbacks.size === 0) {
            this.channels.delete(channel);
          }
        }
      },
    };

    return handle;
  }

  /**
   * Persist and broadcast a presence event for a callback participant (no WebSocket).
   */
  private publishPresenceEventForParticipant(
    channel: string,
    participantId: string,
    action: PresenceAction,
    metadata: Record<string, unknown>,
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
        channel,
        "presence",
        JSON.stringify(payload),
        participantId,
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
      senderId: participantId,
      ts,
      senderMetadata: metadata,
    };

    this.broadcast(channel, msg, null);
  }

  /**
   * Get the MessageStore reference.
   */
  getMessageStore(): MessageStore {
    return this.messageStore;
  }

  async stop(): Promise<void> {
    // Persist "leave" events for all participants while the message store is still
    // open. We do this synchronously from the server's own in-memory state rather
    // than relying on async WebSocket close handlers (which race with store closure).
    const ts = Date.now();
    for (const [channel, state] of this.channels) {
      for (const [clientId, participant] of state.participants) {
        const leaveReason: LeaveReason = participant.pendingGracefulClose ? "graceful" : "disconnect";
        const payload: PresencePayload = {
          action: "leave",
          metadata: participant.metadata,
          leaveReason,
        };
        try {
          this.messageStore.insert(
            channel, "presence", JSON.stringify(payload), clientId, ts, participant.metadata
          );
        } catch {
          // Best-effort — don't block shutdown
        }
      }
      state.participants.clear();

      // Also persist leave events for callback participants — skip POST-back participants (they survive restart)
      for (const [cbId, cb] of state.callbacks) {
        if (cb.metadata["transport"] === "post") continue; // survives restart
        const payload: PresencePayload = {
          action: "leave",
          metadata: cb.metadata,
          leaveReason: "disconnect",
        };
        try {
          this.messageStore.insert(
            channel, "presence", JSON.stringify(payload), cbId, ts, cb.metadata
          );
        } catch {
          // Best-effort — don't block shutdown
        }
      }
      state.callbacks.clear();
    }

    // Now terminate connections and close the store
    if (this.wss) {
      for (const client of this.wss.clients) {
        client.terminate();
      }
    }
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

// =============================================================================
// Module-level HTTP helpers for POST-back delivery
// =============================================================================

/**
 * POST JSON to a URL using the built-in fetch API.
 * Returns the Response object for the caller to inspect if needed.
 */
async function httpPost(url: string, body: string): Promise<Response> {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`POST ${url} failed with ${resp.status}: ${text}`);
  }
  return resp;
}

/**
 * Read the full body of a fetch Response as text.
 */
async function readFetchBody(response: Response): Promise<string> {
  return response.text();
}
