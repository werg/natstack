/**
 * WebSocket pub/sub server with SQLite persistence.
 *
 * Provides pub/sub channels for arbitrary JSON messages with optional
 * persistence to SQLite and replay on reconnection.
 */

import { WebSocketServer, WebSocket } from "ws";
import { createServer, type Server as HttpServer, type IncomingMessage } from "http";
import type { AgentManifest } from "@natstack/types";
import type { AgentBuildError } from "@natstack/types";
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
export type { TokenValidator, ChannelConfig, ChannelInfo, ChannelAgentRow, MessageStore, MessageRow, ServerAttachment, DatabaseManagerLike } from "./messageStore.js";

// =============================================================================
// Injectable dependency interfaces
// =============================================================================

/**
 * Minimal AgentHost interface — the subset that PubSubServer needs.
 */
export interface AgentHostLike {
  listAvailableAgents(): AgentManifest[];
  spawn(agentId: string, options: {
    channel: string;
    handle?: string;
    contextFolderPath?: string;
    config?: Record<string, unknown>;
  }): Promise<{ id: string; agentId: string; handle: string; startedAt: number }>;
  kill(instanceId: string): Promise<boolean>;
  getChannelAgents(channel: string): Array<{ id: string; agentId: string; handle: string; startedAt: number }>;
  markChannelActivity(channel: string): void;
  wakeChannelAgents(channel: string): Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): void;
}

/**
 * Error thrown when agent spawn fails due to build/type errors.
 */
export class AgentSpawnError extends Error {
  constructor(
    message: string,
    public readonly buildLog?: string,
    public readonly typeErrors?: Array<{ file: string; line: number; column: number; message: string }>,
    public readonly dirtyRepo?: { modified: string[]; untracked: string[]; staged: string[] }
  ) {
    super(message);
    this.name = "AgentSpawnError";
  }
}

/**
 * Minimal ContextFolderManager interface — the subset that PubSubServer needs.
 */
export interface ContextFolderManagerLike {
  ensureContextFolder(contextId: string): Promise<string>;
}

/** Logger interface matching createDevLogger() output shape. */
export interface Logger {
  verbose(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/** Stored spawn config shape for auto-wake registration. */
export interface StoredSpawnConfig {
  channel: string;
  handle: string;
  config: Record<string, unknown>;
  contextId: string;
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

/**
 * Agent instance summary for client responses.
 * Maps AgentInstanceInfo.id → instanceId for API clarity.
 */
interface AgentInstanceSummary {
  instanceId: string;
  agentId: string;
  handle: string;
  startedAt: number;
}

interface ServerMessage {
  kind: "replay" | "persisted" | "ephemeral" | "ready" | "error" | "messages-before"
    | "list-agents-response" | "invite-agent-response" | "channel-agents-response" | "remove-agent-response";
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
  /** Agent manifests (list-agents-response) */
  agents?: AgentManifest[] | AgentInstanceSummary[];
  /** Whether operation succeeded (invite/remove-agent responses) */
  success?: boolean;
  /** Instance ID of spawned agent (invite-agent-response) */
  instanceId?: string;
  /** Structured build error with full diagnostics (invite-agent-response on failure) */
  buildError?: AgentBuildError;
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

interface GetMessagesBeforeClientMessage {
  action: "get-messages-before";
  beforeId: number;
  limit?: number;
  ref?: number;
}

interface ListAgentsClientMessage {
  action: "list-agents";
  ref: number; // Required for agent ops
}

interface InviteAgentClientMessage {
  action: "invite-agent";
  ref: number; // Required
  agentId: string;
  handle?: string;
  config?: Record<string, unknown>;
}

interface ChannelAgentsClientMessage {
  action: "channel-agents";
  ref: number; // Required
}

interface RemoveAgentClientMessage {
  action: "remove-agent";
  ref: number; // Required
  instanceId: string;
}

type ClientMessage =
  | PublishClientMessage
  | UpdateMetadataClientMessage
  | CloseClientMessage
  | UpdateConfigClientMessage
  | GetMessagesBeforeClientMessage
  | ListAgentsClientMessage
  | InviteAgentClientMessage
  | ChannelAgentsClientMessage
  | RemoveAgentClientMessage;

export class PubSubServer {
  private wss: WebSocketServer | null = null;
  private httpServer: HttpServer | null = null;
  private port: number | null = null;
  private channels = new Map<string, ChannelState>();
  private wakeDebounceTimers = new Map<string, NodeJS.Timeout>();
  /** Tracks channels where ghost participants have already been cleaned up (once per server session). */
  private ghostsCleanedChannels = new Set<string>();

  private tokenValidator: TokenValidator;
  private messageStore: MessageStore;
  private requestedPort: number | undefined;
  private findPort: PortFinder | undefined;

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

    // Create HTTP server for WebSocket upgrade
    this.httpServer = createServer();
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
      // If client provides a contextId (not undefined), it must match the channel's contextId
      // Clients can omit contextId (undefined) to join without validation
      if (contextIdParam !== undefined && contextIdParam !== existingChannel.contextId) {
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

      if (state.clients.size === 0) {
        this.channels.delete(channel);
      }
    });
  }

  private replayMessages(ws: WebSocket, channel: string, sinceId: number): void {
    const rows = this.messageStore.query(channel, sinceId);

    for (const row of rows) {
      // Skip presence events — they're already fully covered by replayRosterOps()
      // which replays ALL presence from the beginning. Including them here would
      // send duplicates that the client has to dedup via rosterOpIds.
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

    // Agent protocol handlers
    if (msg.action === "list-agents") {
      this.handleListAgents(client, ref);
      return;
    }

    if (msg.action === "invite-agent") {
      void this.handleInviteAgent(client, msg as InviteAgentClientMessage, ref);
      return;
    }

    if (msg.action === "channel-agents") {
      this.handleChannelAgents(client, ref);
      return;
    }

    if (msg.action === "remove-agent") {
      void this.handleRemoveAgent(client, msg as RemoveAgentClientMessage, ref);
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

    // Mark channel activity for agent inactivity tracking
    this.agentHost?.markChannelActivity(channel);

    // Schedule wake only for persisted messages (ephemeral messages can't be replayed)
    if (msg.kind === "persisted") {
      this.scheduleWake(channel);
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
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  /**
   * Schedule a debounced wake for registered agents on a channel.
   * This is called after messages are persisted to ensure checkpoint availability.
   */
  private scheduleWake(channel: string): void {
    // Skip if already scheduled
    if (this.wakeDebounceTimers.has(channel)) return;

    const timer = setTimeout(() => {
      this.wakeDebounceTimers.delete(channel);
      void this.agentHost?.wakeChannelAgents(channel);
    }, 100);

    this.wakeDebounceTimers.set(channel, timer);
  }

  // ===========================================================================
  // Agent Protocol Handlers
  // ===========================================================================

  private handleListAgents(client: ClientConnection, ref: number | undefined): void {
    // Validate ref is present
    if (ref === undefined) {
      this.send(client.ws, { kind: "error", error: "ref required for list-agents" });
      return;
    }

    if (!this.agentHost) {
      this.send(client.ws, {
        kind: "list-agents-response",
        ref,
        agents: [],
      });
      return;
    }

    const agents = this.agentHost.listAvailableAgents();
    this.send(client.ws, {
      kind: "list-agents-response",
      ref,
      agents,
    });
  }

  private async handleInviteAgent(
    client: ClientConnection,
    msg: InviteAgentClientMessage,
    ref: number | undefined
  ): Promise<void> {
    log.verbose(`[invite-agent] Received request: agentId=${msg.agentId}, handle=${msg.handle}, channel=${client.channel}`);

    // Validate ref is present
    if (ref === undefined) {
      log.verbose(`[invite-agent] Error: ref required`);
      this.send(client.ws, { kind: "error", error: "ref required for invite-agent" });
      return;
    }

    if (!this.agentHost) {
      log.verbose(`[invite-agent] Error: Agent host not initialized`);
      this.send(client.ws, {
        kind: "invite-agent-response",
        ref,
        success: false,
        error: "Agent host not initialized",
      });
      return;
    }

    // Note: Manifest constraints (channels, proposedHandle) are not enforced here.
    // This is intentional to allow flexibility during development. Agents can
    // validate their own config on startup and reject invalid configurations.
    // Future: Consider adding optional manifest constraint enforcement.
    const handle = msg.handle ?? msg.agentId;
    const config = msg.config ?? {};

    // Look up channel contextId and resolve context folder path
    const channelInfo = this.messageStore.getChannel(client.channel);
    if (!channelInfo?.contextId) {
      this.send(client.ws, {
        kind: "invite-agent-response",
        ref,
        success: false,
        error: "Channel has no contextId — cannot invite agent",
      });
      return;
    }

    if (!this.contextFolderManager) {
      this.send(client.ws, {
        kind: "invite-agent-response",
        ref,
        success: false,
        error: "ContextFolderManager not initialized",
      });
      return;
    }

    let contextFolderPath: string;
    try {
      contextFolderPath = await this.contextFolderManager.ensureContextFolder(channelInfo.contextId);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.send(client.ws, {
        kind: "invite-agent-response",
        ref,
        success: false,
        error: `Failed to resolve context folder: ${errorMsg}`,
      });
      return;
    }

    log.verbose(`[invite-agent] Spawning agent ${msg.agentId} with handle=${handle} on channel=${client.channel}`);

    try {
      const instance = await this.agentHost.spawn(msg.agentId, {
        channel: client.channel,
        handle,
        config,
        contextFolderPath,
      });

      log.verbose(`[invite-agent] Agent spawned successfully: instanceId=${instance.id}`);

      // Register agent for auto-wake (UPSERT - updates config on re-invite)
      const spawnConfig = JSON.stringify({
        channel: client.channel,
        handle,
        config,
        contextId: channelInfo.contextId,
      } satisfies StoredSpawnConfig);
      this.messageStore.registerChannelAgent(
        client.channel,
        msg.agentId,
        handle,
        spawnConfig,
        client.clientId
      );

      log.verbose(`[invite-agent] Agent registered for auto-wake`);

      this.send(client.ws, {
        kind: "invite-agent-response",
        ref,
        success: true,
        instanceId: instance.id,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.verbose(`[invite-agent] Error spawning agent: ${errorMsg}`);
      if (err instanceof Error && err.stack) {
        log.verbose(`[invite-agent] Stack: ${err.stack}`);
      }

      // Extract structured build error if available
      let buildError: AgentBuildError | undefined;
      if (err instanceof AgentSpawnError) {
        buildError = {
          message: err.message,
          buildLog: err.buildLog,
          typeErrors: err.typeErrors,
          dirtyRepo: err.dirtyRepo,
        };
      }

      // Broadcast spawn error to the channel so all participants can see it
      this.broadcastEphemeralDebug(client.channel, {
        debugType: "spawn-error",
        agentId: msg.agentId,
        handle,
        error: errorMsg,
        buildError,
      });

      this.send(client.ws, {
        kind: "invite-agent-response",
        ref,
        success: false,
        error: errorMsg,
        buildError,
      });
    }
  }

  private handleChannelAgents(client: ClientConnection, ref: number | undefined): void {
    // Validate ref is present
    if (ref === undefined) {
      this.send(client.ws, { kind: "error", error: "ref required for channel-agents" });
      return;
    }

    if (!this.agentHost) {
      this.send(client.ws, {
        kind: "channel-agents-response",
        ref,
        agents: [],
      });
      return;
    }

    const agents = this.agentHost.getChannelAgents(client.channel);
    // Map AgentInstanceInfo.id → AgentInstanceSummary.instanceId
    this.send(client.ws, {
      kind: "channel-agents-response",
      ref,
      agents: agents.map((a) => ({
        instanceId: a.id,
        agentId: a.agentId,
        handle: a.handle,
        startedAt: a.startedAt,
      })),
    });
  }

  private async handleRemoveAgent(
    client: ClientConnection,
    msg: RemoveAgentClientMessage,
    ref: number | undefined
  ): Promise<void> {
    // Validate ref is present
    if (ref === undefined) {
      this.send(client.ws, { kind: "error", error: "ref required for remove-agent" });
      return;
    }

    if (!this.agentHost) {
      this.send(client.ws, {
        kind: "remove-agent-response",
        ref,
        success: false,
        error: "Agent host not initialized",
      });
      return;
    }

    // Security: Verify the instance belongs to the client's channel
    // This prevents cross-channel agent termination attacks
    const channelAgents = this.agentHost.getChannelAgents(client.channel);
    const agentInstance = channelAgents.find((a) => a.id === msg.instanceId);
    if (!agentInstance) {
      this.send(client.ws, {
        kind: "remove-agent-response",
        ref,
        success: false,
        error: "Agent instance not found on this channel",
      });
      return;
    }

    try {
      // Kill first - if this fails, agent stays registered for auto-wake
      const killed = await this.agentHost.kill(msg.instanceId);
      if (!killed) {
        this.send(client.ws, {
          kind: "remove-agent-response",
          ref,
          success: false,
          error: "Agent instance not found",
        });
        return;
      }

      // Only unregister after successful kill (prevents auto-wake)
      this.messageStore.unregisterChannelAgent(
        client.channel,
        agentInstance.agentId,
        agentInstance.handle
      );

      this.send(client.ws, {
        kind: "remove-agent-response",
        ref,
        success: true,
      });
    } catch (err) {
      this.send(client.ws, {
        kind: "remove-agent-response",
        ref,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
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

    // Mark channel activity for agent inactivity tracking
    this.agentHost?.markChannelActivity(channel);

    // Schedule wake for registered agents
    this.scheduleWake(channel);

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

    // Mark channel activity for agent inactivity tracking
    this.agentHost?.markChannelActivity(channel);

    // Schedule wake only for persisted messages (binary messages with attachments are always persisted)
    if (msg.kind === "persisted") {
      this.scheduleWake(channel);
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

    // Compare against live participants — anyone in the DB but not connected is a ghost
    const channelState = this.channels.get(channel);
    const liveParticipants = channelState?.participants ?? new Map();
    let cleanedCount = 0;

    for (const [senderId, metadata] of rosterFromDb) {
      if (!liveParticipants.has(senderId)) {
        // Ghost participant — persist a synthetic leave event
        const ts = Date.now();
        const payload: PresencePayload = {
          action: "leave",
          metadata,
          leaveReason: "disconnect",
        };
        try {
          this.messageStore.insert(
            channel,
            "presence",
            JSON.stringify(payload),
            senderId,
            ts,
            metadata
          );
          cleanedCount++;
        } catch {
          // Ignore — best effort cleanup
        }
      }
    }

    if (cleanedCount > 0) {
      log.verbose(`Cleaned up ${cleanedCount} ghost participant(s) on channel ${channel}`);
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

  // ===========================================================================
  // AgentHost Integration (Phase 4)
  // ===========================================================================

  private agentHost: AgentHostLike | null = null;
  private contextFolderManager: ContextFolderManagerLike | null = null;

  /**
   * Set the ContextFolderManager for resolving context folder paths.
   */
  setContextFolderManager(manager: ContextFolderManagerLike): void {
    this.contextFolderManager = manager;
  }

  /**
   * Set the AgentHost reference for agent lifecycle management.
   * The full pubsub protocol (invite-agent, list-agents, etc.) is Phase 5.
   */
  setAgentHost(host: AgentHostLike): void {
    this.agentHost = host;

    // Listen for agent events and broadcast as ephemeral debug messages
    host.on("agentOutput", (data: {
      channel: string;
      handle: string;
      agentId: string;
      stream: "stdout" | "stderr";
      content: string;
      timestamp: number;
    }) => {
      this.broadcastEphemeralDebug(data.channel, {
        debugType: "output",
        agentId: data.agentId,
        handle: data.handle,
        stream: data.stream,
        content: data.content,
      });
    });

    host.on("agentLifecycle", (data: {
      channel: string;
      handle: string;
      agentId: string;
      event: "spawning" | "started" | "stopped" | "woken";
      reason?: "timeout" | "explicit" | "crash" | "idle";
      timestamp: number;
    }) => {
      this.broadcastEphemeralDebug(data.channel, {
        debugType: "lifecycle",
        agentId: data.agentId,
        handle: data.handle,
        event: data.event,
        reason: data.reason,
      });
    });

    host.on("agentLog", (data: {
      channel: string;
      handle: string;
      agentId: string;
      level: "debug" | "info" | "warn" | "error";
      message: string;
      stack?: string;
      timestamp: number;
    }) => {
      this.broadcastEphemeralDebug(data.channel, {
        debugType: "log",
        agentId: data.agentId,
        handle: data.handle,
        level: data.level,
        message: data.message,
        stack: data.stack,
      });
    });
  }

  /**
   * Get the AgentHost reference.
   */
  getAgentHost(): AgentHostLike | null {
    return this.agentHost;
  }

  /**
   * Get the MessageStore reference.
   */
  getMessageStore(): MessageStore {
    return this.messageStore;
  }

  /**
   * Broadcast an ephemeral debug event to a channel (not persisted).
   */
  private broadcastEphemeralDebug(channel: string, payload: {
    debugType: "output" | "lifecycle" | "spawn-error" | "log";
    agentId: string;
    handle: string;
    stream?: "stdout" | "stderr";
    content?: string;
    event?: "spawning" | "started" | "stopped" | "woken" | "warning";
    reason?: "timeout" | "explicit" | "crash" | "idle" | "dirty-repo";
    details?: unknown;
    error?: string;
    buildError?: AgentBuildError;
    level?: "debug" | "info" | "warn" | "error";
    message?: string;
    stack?: string;
  }): void {
    const state = this.channels.get(channel);
    if (!state) return;

    const msg = {
      kind: "ephemeral" as const,
      type: "agent-debug" as const,
      payload,
      senderId: "system",
      ts: Date.now(),
    };

    const data = JSON.stringify(msg);
    for (const client of state.clients) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(data);
      }
    }
  }

  async stop(): Promise<void> {
    // Clear all wake debounce timers
    for (const timer of this.wakeDebounceTimers.values()) {
      clearTimeout(timer);
    }
    this.wakeDebounceTimers.clear();

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

