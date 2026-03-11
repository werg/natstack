/**
 * PubSub WebSocket client implementation.
 *
 * Provides an async/generator-friendly API for pub/sub messaging.
 */

import { PubSubError } from "./types.js";
import type {
  Message,
  PubSubMessage,
  PublishOptions,
  UpdateMetadataOptions,
  ConnectOptions,
  FullConnectOptions,
  ReconnectConfig,
  RosterUpdate,
  ParticipantMetadata,
  Participant,
  Attachment,
  ChannelConfig,
} from "./types.js";
import type {
  IncomingEvent,
  AggregatedEvent,
  EventStreamItem,
  EventStreamOptions,
  IncomingNewMessage,
  IncomingUpdateMessage,
  IncomingErrorMessage,
  IncomingMethodCallEvent,
  IncomingMethodResultEvent,
  IncomingPresenceEventWithType,
  IncomingExecutionPauseEvent,
  IncomingAgentDebugEvent,
  MethodCallHandle,
  MethodResultChunk,
  MethodResultValue,
} from "./protocol-types.js";
import { AgenticError } from "./protocol-types.js";
import type { MethodDefinition, MethodAdvertisement, JsonSchema, MethodExecutionContext } from "./protocol-types.js";
import { zodToJsonSchema as convertZodToJsonSchema } from "zod-to-json-schema";
import { z } from "zod";
import {
  NewMessageSchema,
  UpdateMessageSchema,
  ErrorMessageSchema,
  MethodCallSchema,
  MethodResultSchema,
  ExecutionPauseSchema,
} from "./protocol.js";
import { aggregateReplayEvents } from "./aggregation.js";
import { createFanout } from "./async-queue.js";
import type { AttachmentInput } from "./types.js";

/**
 * Server message envelope.
 */
interface ServerMessage {
  kind: "replay" | "persisted" | "ephemeral" | "ready" | "error" | "config-update" | "messages-before";
  id?: number;
  type?: string;
  payload?: unknown;
  senderId?: string;
  ts?: number;
  ref?: number;
  error?: string;
  /** Binary attachments (parsed from binary frame) */
  attachments?: Attachment[];
  senderMetadata?: Record<string, unknown>;
  /** Context ID for the channel (sent in ready message) */
  contextId?: string;
  /** Channel config (sent in ready message or config-update) */
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

type PresenceAction = "join" | "leave" | "update";

interface PresencePayload {
  action?: PresenceAction;
  metadata?: Record<string, unknown>;
  /** Reason for leave (only present when action === "leave") */
  leaveReason?: "graceful" | "disconnect";
}

/**
 * PubSub client interface.
 */
export interface PubSubClient<T extends ParticipantMetadata = ParticipantMetadata> {
  /** Async iterator for incoming messages */
  messages(): AsyncIterableIterator<Message>;

  /** Publish a message to the channel. Returns the message ID for persisted messages. */
  publish<P>(type: string, payload: P, options?: PublishOptions): Promise<number | undefined>;

  /** Update this client's participant metadata (triggers roster broadcast). */
  updateMetadata(metadata: T, options?: UpdateMetadataOptions): Promise<void>;

  /** Wait for the ready signal (replay complete). Throws if timeout exceeded. */
  ready(timeoutMs?: number): Promise<void>;

  /** Close the connection */
  close(): void;

  /** Send a raw message to the server (for protocol-level messages like "close") */
  sendRaw(message: Record<string, unknown>): Promise<void>;

  /** Whether currently connected */
  readonly connected: boolean;

  /** Whether currently attempting to reconnect */
  readonly reconnecting: boolean;

  /** Context ID for the channel (from server ready message) */
  readonly contextId: string | undefined;

  /** Channel config (from server ready message) */
  readonly channelConfig: ChannelConfig | undefined;

  /** Register error handler. Returns unsubscribe function. */
  onError(handler: (error: Error) => void): () => void;

  /** Register disconnect handler. Returns unsubscribe function. */
  onDisconnect(handler: () => void): () => void;

  /** Register reconnect handler (called after successful reconnection). Returns unsubscribe function. */
  onReconnect(handler: () => void): () => void;

  /** Register ready handler (called on every ready message, including reconnects). Returns unsubscribe function. */
  onReady(handler: () => void): () => void;

  /** Register roster update handler. Returns unsubscribe function. */
  onRoster(handler: (roster: RosterUpdate<T>) => void): () => void;

  /** Update the channel config (merges with existing config). */
  updateChannelConfig(config: Partial<ChannelConfig>): Promise<ChannelConfig>;

  /** Register channel config change handler. Returns unsubscribe function. */
  onConfigChange(handler: (config: ChannelConfig) => void): () => void;

  /** Get the current roster participants (may be empty if no roster update received yet) */
  readonly roster: Record<string, Participant<T>>;

  /** Total message count (from server ready message, for pagination) */
  readonly totalMessageCount: number | undefined;

  /** Count of type="message" events only (excludes protocol chatter), for accurate chat pagination */
  readonly chatMessageCount: number | undefined;

  /** ID of the first chat message in the channel (for pagination boundary) */
  readonly firstChatMessageId: number | undefined;

  /** Get older messages before a given ID (for pagination UI) */
  getMessagesBefore(beforeId: number, limit?: number): Promise<{
    messages: Array<{
      id: number;
      type: string;
      payload: unknown;
      senderId: string;
      ts: number;
      senderMetadata?: Record<string, unknown>;
      attachments?: Attachment[];
    }>;
    trailingUpdates?: Array<{
      id: number;
      type: string;
      payload: unknown;
      senderId: string;
      ts: number;
      senderMetadata?: Record<string, unknown>;
      attachments?: Attachment[];
    }>;
    hasMore: boolean;
  }>;

  /**
   * Async iterator for typed protocol events (IncomingEvent | AggregatedEvent).
   *
   * Higher-level than messages() — parses PubSubMessages into typed IncomingEvent
   * objects and optionally aggregates replay events into AggregatedEvent objects.
   *
   * @param options.includeReplay - Include replay events (default: false)
   * @param options.includeEphemeral - Include ephemeral events (default: false)
   */
  events(options?: EventStreamOptions): AsyncIterableIterator<EventStreamItem>;

  // === Agentic convenience methods ===

  /** This client's ID (from ConnectOptions.clientId) */
  readonly clientId: string | undefined;

  /**
   * Send a new chat message. Convenience wrapper around publish("message", ...).
   * Returns the message UUID and server-assigned pubsub ID.
   */
  send(
    content: string,
    options?: {
      replyTo?: string;
      persist?: boolean;
      attachments?: import("./types.js").AttachmentInput[];
      contentType?: string;
      at?: string[];
      metadata?: Record<string, unknown>;
    }
  ): Promise<{ messageId: string; pubsubId: number | undefined }>;

  /**
   * Update an existing message (for streaming). Convenience wrapper around publish("update-message", ...).
   */
  update(
    id: string,
    content: string,
    options?: { complete?: boolean; persist?: boolean; attachments?: import("./types.js").AttachmentInput[]; contentType?: string }
  ): Promise<number | undefined>;

  /**
   * Mark a message as complete. Convenience wrapper around publish("update-message", { id, complete: true }).
   */
  complete(id: string): Promise<number | undefined>;

  /**
   * Publish an error for a message. Convenience wrapper around publish("error", ...).
   */
  error(id: string, error: string, code?: string): Promise<number | undefined>;

  /**
   * Call a method on a remote provider. Publishes a method-call message and
   * tracks the result via method-result messages.
   */
  callMethod(
    providerId: string,
    methodName: string,
    args?: unknown,
    options?: { timeoutMs?: number }
  ): import("./protocol-types.js").MethodCallHandle;

}

/** Default reconnection configuration */
const DEFAULT_RECONNECT_CONFIG: Required<ReconnectConfig> = {
  delayMs: 1000,
  maxDelayMs: 30000,
  maxAttempts: 0, // infinite
};

/**
 * Connect to a PubSub channel.
 *
 * Supports two call signatures:
 * - `connect(serverUrl, token, options)` — three-arg form
 * - `connect(options)` — single-arg form with serverUrl and token in options
 */
export function connect<T extends ParticipantMetadata = ParticipantMetadata>(
  options: FullConnectOptions<T>
): PubSubClient<T>;
export function connect<T extends ParticipantMetadata = ParticipantMetadata>(
  serverUrl: string,
  token: string,
  options: ConnectOptions<T>
): PubSubClient<T>;
export function connect<T extends ParticipantMetadata = ParticipantMetadata>(
  serverUrlOrOptions: string | FullConnectOptions<T>,
  token?: string,
  options?: ConnectOptions<T>
): PubSubClient<T> {
  let serverUrl: string;
  let actualToken: string;
  let actualOptions: ConnectOptions<T>;

  if (typeof serverUrlOrOptions === "string") {
    serverUrl = serverUrlOrOptions;
    actualToken = token!;
    actualOptions = options!;
  } else {
    const { serverUrl: url, token: tok, ...rest } = serverUrlOrOptions;
    serverUrl = url;
    actualToken = tok;
    actualOptions = rest;
  }

  return connectImpl<T>(serverUrl, actualToken, actualOptions);
}

function connectImpl<T extends ParticipantMetadata = ParticipantMetadata>(
  serverUrl: string,
  token: string,
  options: ConnectOptions<T>
): PubSubClient<T> {
  const { channel, contextId, channelConfig, sinceId: initialSinceId, replayMessageLimit, reconnect, clientId, skipOwnMessages, replayMode = "stream", methods: providedMethods } = options;

  // Convert MethodDefinitions to MethodAdvertisements for metadata
  function toMethodAdvertisements(methods: Record<string, MethodDefinition>): MethodAdvertisement[] {
    // Internal methods are registered (callable) but not advertised in metadata.
    // This prevents them from being discovered by harnesses as AI model tools.
    return Object.entries(methods).filter(([, def]) => !def.internal).map(([methodName, def]) => {
      // Handle both Zod schemas and plain JSON schema objects
      const parameters = def.parameters && typeof def.parameters === "object" && !("_def" in def.parameters)
        ? (def.parameters as JsonSchema)
        : convertZodToJsonSchema(def.parameters as z.ZodTypeAny, { target: "openApi3" }) as JsonSchema;

      const returns = def.returns
        ? (def.returns && typeof def.returns === "object" && !("_def" in def.returns)
          ? (def.returns as JsonSchema)
          : convertZodToJsonSchema(def.returns as z.ZodTypeAny, { target: "openApi3" }) as JsonSchema)
        : undefined;

      return {
        name: methodName,
        description: def.description,
        parameters,
        returns,
        streaming: def.streaming,
        timeout: def.timeout,
        menu: def.menu,
      };
    });
  }

  // Auto-pack handle/name/type/methods into metadata when provided as convenience fields
  const metadata: T | undefined = (() => {
    const { handle, name, type } = options;
    if (!handle && !name && !type && !providedMethods) return options.metadata;
    const base = (options.metadata ?? {}) as Record<string, unknown>;
    const packed: Record<string, unknown> = { ...base };
    if (handle) packed["handle"] = handle;
    if (name) packed["name"] = name;
    if (type) packed["type"] = type;
    if (providedMethods && Object.keys(providedMethods).length > 0) {
      packed["methods"] = toMethodAdvertisements(providedMethods);
    }
    return packed as T;
  })();

  // Parse reconnection config
  const reconnectEnabled = reconnect !== undefined && reconnect !== false;
  const reconnectConfig: Required<ReconnectConfig> = reconnectEnabled
    ? { ...DEFAULT_RECONNECT_CONFIG, ...(typeof reconnect === "object" ? reconnect : {}) }
    : DEFAULT_RECONNECT_CONFIG;

  // Shared state
  let ws: WebSocket;
  let lastSeenId: number | undefined = initialSinceId;
  let closed = false;
  let isReconnecting = false;
  let reconnectAttempt = 0;
  let reconnectTimeoutId: ReturnType<typeof setTimeout> | null = null;
  let refCounter = 0;
  let serverContextId: string | undefined;
  let serverChannelConfig: ChannelConfig | undefined;
  let serverTotalCount: number | undefined;
  let serverChatMessageCount: number | undefined;
  let serverFirstChatMessageId: number | undefined;

  // Message queue for the async iterator
  const messageQueue: Message[] = [];
  let messageResolve: ((msg: Message | null) => void) | null = null;

  // Raw PubSubMessage notification callbacks (used by events() infrastructure)
  const rawMessageCallbacks = new Set<(msg: PubSubMessage) => void>();
  // Ready signal callbacks (used by events() infrastructure)
  const readySignalCallbacks = new Set<() => void>();

  // Pending publish tracking
  const pendingPublishes = new Map<
    number,
    { resolve: (id?: number) => void; reject: (err: Error) => void; timeoutId: ReturnType<typeof setTimeout> }
  >();

  const pendingMetadataUpdates = new Map<
    number,
    { resolve: () => void; reject: (err: Error) => void; timeoutId: ReturnType<typeof setTimeout> }
  >();

  // Event handlers
  const errorHandlers = new Set<(error: Error) => void>();
  const disconnectHandlers = new Set<() => void>();
  const reconnectHandlers = new Set<() => void>();
  const readyHandlers = new Set<() => void>();
  const rosterHandlers = new Set<(roster: RosterUpdate<T>) => void>();
  const configChangeHandlers = new Set<(config: ChannelConfig) => void>();

  // Pending config update tracking
  const pendingConfigUpdates = new Map<
    number,
    { resolve: (config: ChannelConfig) => void; reject: (err: Error) => void; timeoutId: ReturnType<typeof setTimeout> }
  >();

  // Pending get-messages-before tracking
  type MessagesBeforeResult = {
    messages: Array<{
      id: number;
      type: string;
      payload: unknown;
      senderId: string;
      ts: number;
      senderMetadata?: Record<string, unknown>;
      attachments?: Attachment[];
    }>;
    trailingUpdates?: Array<{
      id: number;
      type: string;
      payload: unknown;
      senderId: string;
      ts: number;
      senderMetadata?: Record<string, unknown>;
      attachments?: Attachment[];
    }>;
    hasMore: boolean;
  };
  const pendingMessagesBeforeRequests = new Map<
    number,
    { resolve: (result: MessagesBeforeResult) => void; reject: (err: Error) => void; timeoutId: ReturnType<typeof setTimeout> }
  >();

  // Current roster state
  let currentRoster: Record<string, Participant<T>> = {};
  const rosterOpIds = new Set<number>();
  const MAX_ROSTER_OP_IDS = 1000; // Limit to prevent unbounded growth

  // Ready promise management
  let readyResolve: (() => void) | null = null;
  let readyReject: ((err: Error) => void) | null = null;
  let readyPromise: Promise<void>;

  function resetReadyPromise(): void {
    readyPromise = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
  }

  function buildWsUrl(withSinceId?: number): string {
    const url = new URL(serverUrl);
    url.searchParams.set("token", token);
    url.searchParams.set("channel", channel);
    if (contextId) {
      url.searchParams.set("contextId", contextId);
    }
    if (channelConfig !== undefined) {
      url.searchParams.set("channelConfig", JSON.stringify(channelConfig));
    }
    if (withSinceId !== undefined) {
      url.searchParams.set("sinceId", String(withSinceId));
    }
    if (replayMessageLimit !== undefined) {
      url.searchParams.set("replayMessageLimit", String(replayMessageLimit));
    }
    // Note: metadata is always sent via updateMetadata after connection.
    // This avoids URL length limits (~2KB-8KB depending on browser/server).
    // WebSocket connections must use HTTP GET for the upgrade handshake (RFC 6455),
    // so POST is not an option. The extra round-trip is acceptable since
    // participants without metadata can still receive messages during this window.
    return url.toString();
  }

  function handleError(error: PubSubError): void {
    for (const handler of errorHandlers) {
      handler(error);
    }
  }

  function enqueueMessage(message: Message): void {
    if (messageResolve) {
      messageResolve(message);
      messageResolve = null;
    } else {
      messageQueue.push(message);
    }
  }

  function handleMessage(event: MessageEvent | { data: ArrayBuffer }): void {
    let msg: ServerMessage;

    // Handle binary messages (messages with attachments)
    if (event.data instanceof ArrayBuffer) {
      const buffer = event.data;
      if (buffer.byteLength < 5) {
        handleError(new PubSubError("invalid binary message format", "validation"));
        return;
      }

      const view = new DataView(buffer);
      // Byte 0 is a binary marker (0)
      const metadataLen = view.getUint32(1, true);

      if (buffer.byteLength < 5 + metadataLen) {
        handleError(new PubSubError("binary message truncated", "validation"));
        return;
      }

      // Parse metadata (contains kind, type, payload, senderId, ts, attachmentMeta, etc.)
      const metadataBytes = new Uint8Array(buffer, 5, metadataLen);
      const metadataStr = new TextDecoder().decode(metadataBytes);
      let metadata: Record<string, unknown> = {};
      try {
        metadata = JSON.parse(metadataStr);
      } catch {
        handleError(new PubSubError("invalid metadata in binary message", "validation"));
        return;
      }

      // Extract attachments from binary data based on attachmentMeta sizes
      const attachmentMeta = metadata["attachmentMeta"] as Array<{ id: string; mimeType: string; name?: string; size: number }> | undefined;
      const attachmentStart = 5 + metadataLen;
      let attachments: Attachment[] | undefined;

      if (attachmentMeta && attachmentMeta.length > 0) {
        attachments = [];
        let offset = attachmentStart;
        for (const meta of attachmentMeta) {
          const data = new Uint8Array(buffer.slice(offset, offset + meta.size));
          attachments.push({
            id: meta.id,
            data,
            mimeType: meta.mimeType,
            name: meta.name,
          });
          offset += meta.size;
        }
        // Remove attachmentMeta from the message object (it's internal wire format)
        delete metadata["attachmentMeta"];
      }

      msg = {
        ...metadata,
        attachments,
      } as ServerMessage;
    } else {
      // Handle text messages (JSON)
      msg = JSON.parse(event.data as string) as ServerMessage;
    }


    switch (msg.kind) {
      case "ready":
        // Capture contextId, channelConfig, and totalCount from server ready message
        if (typeof msg.contextId === "string") {
          serverContextId = msg.contextId;
        }
        if (msg.channelConfig) {
          serverChannelConfig = msg.channelConfig;
        }
        if (typeof msg.totalCount === "number") {
          serverTotalCount = msg.totalCount;
        }
        if (typeof msg.chatMessageCount === "number") {
          serverChatMessageCount = msg.chatMessageCount;
        }
        if (typeof msg.firstChatMessageId === "number") {
          serverFirstChatMessageId = msg.firstChatMessageId;
        } else {
          serverFirstChatMessageId = undefined;
        }
        readyResolve?.();
        readyResolve = null;
        readyReject = null;
        enqueueMessage({ kind: "ready", totalCount: serverTotalCount, chatMessageCount: serverChatMessageCount, firstChatMessageId: serverFirstChatMessageId });
        for (const handler of readyHandlers) handler();
        // Notify events infrastructure about ready signal
        for (const cb of readySignalCallbacks) cb();
        break;

      case "messages-before": {
        // Handle messages-before response
        if (msg.ref !== undefined) {
          const pending = pendingMessagesBeforeRequests.get(msg.ref);
          if (pending) {
            clearTimeout(pending.timeoutId);
            pending.resolve({
              messages: msg.messages ?? [],
              trailingUpdates: msg.trailingUpdates,
              hasMore: msg.hasMore ?? false,
            });
            pendingMessagesBeforeRequests.delete(msg.ref);
          }
        }
        break;
      }

      case "config-update": {
        // Update local channel config
        if (msg.channelConfig) {
          serverChannelConfig = msg.channelConfig;

          // Resolve pending config update if this is our request
          if (msg.ref !== undefined) {
            const pending = pendingConfigUpdates.get(msg.ref);
            if (pending) {
              clearTimeout(pending.timeoutId);
              pending.resolve(msg.channelConfig);
              pendingConfigUpdates.delete(msg.ref);
            }
          }

          // Notify all config change handlers
          for (const handler of configChangeHandlers) {
            handler(msg.channelConfig);
          }
        }
        break;
      }

      case "error": {
        const errorMsg = msg.error || "unknown server error";
        let code: "validation" | "server" = "server";
        if (errorMsg.includes("not serializable") || errorMsg.includes("invalid")) {
          code = "validation";
        }
        const error = new PubSubError(errorMsg, code);

        if (msg.ref !== undefined) {
          const pendingPublish = pendingPublishes.get(msg.ref);
          if (pendingPublish) {
            clearTimeout(pendingPublish.timeoutId);
            pendingPublish.reject(error);
            pendingPublishes.delete(msg.ref);
          }
          const pendingMetadata = pendingMetadataUpdates.get(msg.ref);
          if (pendingMetadata) {
            clearTimeout(pendingMetadata.timeoutId);
            pendingMetadata.reject(error);
            pendingMetadataUpdates.delete(msg.ref);
          }
          const pendingConfig = pendingConfigUpdates.get(msg.ref);
          if (pendingConfig) {
            clearTimeout(pendingConfig.timeoutId);
            pendingConfig.reject(error);
            pendingConfigUpdates.delete(msg.ref);
          }
          const pendingMsgBefore = pendingMessagesBeforeRequests.get(msg.ref);
          if (pendingMsgBefore) {
            clearTimeout(pendingMsgBefore.timeoutId);
            pendingMsgBefore.reject(error);
            pendingMessagesBeforeRequests.delete(msg.ref);
          }
        }

        handleError(error);
        break;
      }

      case "replay":
      case "persisted":
      case "ephemeral": {
        // Track last seen ID for reconnection
        if (msg.id !== undefined) {
          lastSeenId = msg.id;
        }

        const isPresence = msg.type === "presence";
        let presenceAction: PresenceAction | undefined;

        if (isPresence) {
          const payload = msg.payload as PresencePayload;
          presenceAction = payload?.action;

          if (msg.id !== undefined) {
            if (rosterOpIds.has(msg.id)) {
              return;
            }
            rosterOpIds.add(msg.id);

            // Simple cleanup to prevent unbounded growth
            if (rosterOpIds.size > MAX_ROSTER_OP_IDS) {
              // Remove oldest entries to bring the set back to ~800
              const toRemove = rosterOpIds.size - (MAX_ROSTER_OP_IDS - 200);
              const iter = rosterOpIds.values();
              for (let i = 0; i < toRemove; i++) {
                const { value } = iter.next();
                if (value !== undefined) rosterOpIds.delete(value);
              }
            }
          }

          if (presenceAction === "join" || presenceAction === "update") {
            if (payload?.metadata) {
              currentRoster = {
                ...currentRoster,
                [msg.senderId!]: {
                  id: msg.senderId!,
                  metadata: payload.metadata as T,
                },
              };
            }
          } else if (presenceAction === "leave") {
            const { [msg.senderId!]: _removed, ...rest } = currentRoster;
            currentRoster = rest;
          }

          if (presenceAction) {
            const rosterUpdate: RosterUpdate<T> = {
              participants: currentRoster,
              ts: msg.ts ?? Date.now(),
              change: {
                type: presenceAction,
                participantId: msg.senderId!,
                metadata: payload?.metadata,
                ...(presenceAction === "leave" && payload?.leaveReason && { leaveReason: payload.leaveReason }),
              },
              ...(presenceAction === "leave" && msg.senderId && {
                leaves: {
                  [msg.senderId]: {
                    leaveReason: (msg.payload as PresencePayload)?.leaveReason,
                  },
                },
              }),
            };
            for (const handler of rosterHandlers) {
              handler(rosterUpdate);
            }
          }

          if (msg.ref !== undefined && presenceAction === "update") {
            const pending = pendingMetadataUpdates.get(msg.ref);
            if (pending) {
              clearTimeout(pending.timeoutId);
              pending.resolve();
              pendingMetadataUpdates.delete(msg.ref);
            }
          }
        }

        // Resolve pending publish if this is our own message
        if (msg.ref !== undefined) {
          const pending = pendingPublishes.get(msg.ref);
          if (pending) {
            clearTimeout(pending.timeoutId);
            pending.resolve(msg.id);
            pendingPublishes.delete(msg.ref);
          }
        }

        // Skip own messages if configured (but never skip roster ops)
        if (skipOwnMessages && clientId && msg.senderId === clientId && !isPresence) {
          break;
        }

        // Build the PubSubMessage for all events (including presence)
        const message: PubSubMessage = {
          kind: msg.kind,
          id: msg.id,
          type: msg.type!,
          payload: msg.payload,
          senderId: msg.senderId!,
          ts: msg.ts!,
          attachments: msg.attachments,
          senderMetadata: msg.senderMetadata,
        };

        // Notify raw message callbacks (for events() infrastructure)
        for (const cb of rawMessageCallbacks) {
          cb(message);
        }

        // Don't leak presence events into the consumer message stream — they're
        // fully handled by the roster handlers above. Enqueueing them is redundant
        // and forces consumers to filter/re-parse events already processed here.
        if (isPresence) {
          break;
        }

        enqueueMessage(message);
        break;
      }
    }
  }

  function handleWsError(): void {
    const error = new PubSubError("WebSocket error", "connection");
    handleError(error);
    readyReject?.(error);
    readyResolve = null;
    readyReject = null;
  }

  function handleWsClose(event?: CloseEvent): void {
    // Build error message with close code and reason if available
    const closeReason = event?.reason || "unknown";
    const closeCode = event?.code ?? 1000;
    const errorMessage = closeCode >= 4000
      ? `connection closed by server: ${closeReason} (code ${closeCode})`
      : "connection closed";

    // Notify disconnect handlers
    for (const handler of disconnectHandlers) {
      handler();
    }

    if (closed) {
      // Intentional close - terminate everything
      if (messageResolve) {
        messageResolve(null);
        messageResolve = null;
      }
      rejectPendingPublishes(new PubSubError(errorMessage, "connection"));
      rejectPendingMetadataUpdates(new PubSubError(errorMessage, "connection"));
      rejectPendingConfigUpdates(new PubSubError(errorMessage, "connection"));
      rejectPendingMessagesBeforeRequests(new PubSubError(errorMessage, "connection"));
      readyReject?.(new PubSubError(errorMessage, "connection"));
      readyResolve = null;
      readyReject = null;
      return;
    }

    if (reconnectEnabled) {
      // Attempt reconnection
      scheduleReconnect();
    } else {
      // No reconnection - close everything
      closed = true;
      if (messageResolve) {
        messageResolve(null);
        messageResolve = null;
      }
      rejectPendingPublishes(new PubSubError(errorMessage, "connection"));
      rejectPendingMetadataUpdates(new PubSubError(errorMessage, "connection"));
      rejectPendingConfigUpdates(new PubSubError(errorMessage, "connection"));
      rejectPendingMessagesBeforeRequests(new PubSubError(errorMessage, "connection"));
      readyReject?.(new PubSubError(errorMessage, "connection"));
      readyResolve = null;
      readyReject = null;
    }
  }

  function rejectPendingPublishes(error: PubSubError): void {
    for (const [, pending] of pendingPublishes) {
      clearTimeout(pending.timeoutId);
      pending.reject(error);
    }
    pendingPublishes.clear();
  }

  function rejectPendingMetadataUpdates(error: PubSubError): void {
    for (const [, pending] of pendingMetadataUpdates) {
      clearTimeout(pending.timeoutId);
      pending.reject(error);
    }
    pendingMetadataUpdates.clear();
  }

  function rejectPendingConfigUpdates(error: PubSubError): void {
    for (const [, pending] of pendingConfigUpdates) {
      clearTimeout(pending.timeoutId);
      pending.reject(error);
    }
    pendingConfigUpdates.clear();
  }

  function rejectPendingMessagesBeforeRequests(error: PubSubError): void {
    for (const [, pending] of pendingMessagesBeforeRequests) {
      clearTimeout(pending.timeoutId);
      pending.reject(error);
    }
    pendingMessagesBeforeRequests.clear();
  }

  function scheduleReconnect(): void {
    if (closed) return;

    isReconnecting = true;
    reconnectAttempt++;

    // Check max attempts
    if (reconnectConfig.maxAttempts > 0 && reconnectAttempt > reconnectConfig.maxAttempts) {
      closed = true;
      isReconnecting = false;
      const error = new PubSubError("max reconnection attempts exceeded", "connection");
      handleError(error);
      if (messageResolve) {
        messageResolve(null);
        messageResolve = null;
      }
      rejectPendingPublishes(error);
      rejectPendingMetadataUpdates(error);
      rejectPendingConfigUpdates(error);
      rejectPendingMessagesBeforeRequests(error);
      return;
    }

    // Calculate delay with exponential backoff
    const delay = Math.min(
      reconnectConfig.delayMs * Math.pow(2, reconnectAttempt - 1),
      reconnectConfig.maxDelayMs
    );

    reconnectTimeoutId = setTimeout(() => {
      reconnectTimeoutId = null;
      attemptReconnect();
    }, delay);
  }

  function attemptReconnect(): void {
    if (closed) return;

    // Reset ready promise for new connection
    resetReadyPromise();

    // Clear roster state so it's rebuilt cleanly from the server's full
    // presence replay. Without this, stale entries accumulate and the
    // rosterOpIds dedup set can mask events that should be reprocessed.
    currentRoster = {};
    rosterOpIds.clear();

    // Create new WebSocket with lastSeenId for replay
    ws = new WebSocket(buildWsUrl(lastSeenId));
    wireUpWebSocket();
  }

  function wireUpWebSocket(): void {
    // Receive binary data as ArrayBuffer (default is Blob which breaks our parsing)
    ws.binaryType = "arraybuffer";
    ws.onmessage = handleMessage;
    ws.onerror = handleWsError;
    ws.onclose = handleWsClose;
    ws.onopen = () => {
      if (isReconnecting) {
        // Successful reconnection
        isReconnecting = false;
        reconnectAttempt = 0;
        for (const handler of reconnectHandlers) {
          handler();
        }
      }
      // Always send metadata after connection (avoids URL length limits)
      if (metadata !== undefined) {
        void updateMetadata(metadata).catch((err) => {
          const error = err instanceof PubSubError ? err : new PubSubError(String(err), "connection");
          handleError(error);
        });
      }
    };
  }

  // Initial connection
  resetReadyPromise();
  ws = new WebSocket(buildWsUrl(initialSinceId));
  wireUpWebSocket();

  async function* messages(): AsyncIterableIterator<Message> {
    while (!closed) {
      if (messageQueue.length > 0) {
        const msg = messageQueue.shift()!;
        yield msg;
      } else {
        const msg = await new Promise<Message | null>((resolve) => {
          if (closed && !isReconnecting) {
            resolve(null);
            return;
          }
          messageResolve = resolve;
        });
        if (msg === null) {
          break;
        }
        yield msg;
      }
    }
  }

  async function ready(timeoutMs = 30000): Promise<void> {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new PubSubError("ready timeout", "timeout")), timeoutMs);
    });
    return Promise.race([readyPromise, timeoutPromise]);
  }

  async function publish<P>(
    type: string,
    payload: P,
    publishOptions: PublishOptions = {}
  ): Promise<number | undefined> {
    const ref = ++refCounter;
    const { persist = true, timeoutMs = 30000, attachments } = publishOptions;

    return new Promise((resolve, reject) => {
      if (ws.readyState !== WebSocket.OPEN) {
        reject(new PubSubError("not connected", "connection"));
        return;
      }

      const timeoutId = setTimeout(() => {
        const pending = pendingPublishes.get(ref);
        if (pending) {
          pendingPublishes.delete(ref);
          pending.reject(new PubSubError("publish timeout", "timeout"));
        }
      }, timeoutMs);

      pendingPublishes.set(ref, {
        resolve: (id) => {
          clearTimeout(timeoutId);
          resolve(id);
        },
        reject: (err) => {
          clearTimeout(timeoutId);
          reject(err);
        },
        timeoutId,
      });

      if (attachments && attachments.length > 0) {
        // Send as binary frame: metadata JSON + concatenated attachments
        // Wire format: [0x00][4-byte JSON len][JSON with attachmentMeta][attachment bytes...]
        // Note: No 'id' field - server assigns IDs
        const attachmentMeta = attachments.map((a) => ({
          mimeType: a.mimeType,
          name: a.name,
          size: a.data.length,
        }));
        const totalAttachmentSize = attachments.reduce((sum, a) => sum + a.data.length, 0);

        const metadata = JSON.stringify({
          action: "publish",
          type,
          payload,
          persist,
          ref,
          attachmentMeta,
        });
        const metadataBytes = new TextEncoder().encode(metadata);
        const metadataLen = metadataBytes.length;

        // Create buffer: 1 byte marker (0) + 4 bytes length + metadata + all attachments
        const buffer = new ArrayBuffer(1 + 4 + metadataLen + totalAttachmentSize);
        const view = new DataView(buffer);
        view.setUint8(0, 0); // Binary frame marker
        view.setUint32(1, metadataLen, true); // Metadata length (little-endian)

        // Copy metadata
        new Uint8Array(buffer, 5, metadataLen).set(metadataBytes);

        // Copy attachments sequentially
        let offset = 5 + metadataLen;
        for (const attachment of attachments) {
          new Uint8Array(buffer, offset, attachment.data.length).set(attachment.data);
          offset += attachment.data.length;
        }

        ws.send(buffer);
      } else {
        // Send as JSON text frame
        ws.send(
          JSON.stringify({
            action: "publish",
            type,
            payload,
            persist,
            ref,
          })
        );
      }
    });
  }

  async function updateMetadata(
    newMetadata: T,
    updateOptions: UpdateMetadataOptions = {}
  ): Promise<void> {
    const ref = ++refCounter;
    const { timeoutMs = 30000 } = updateOptions;

    return new Promise((resolve, reject) => {
      if (ws.readyState !== WebSocket.OPEN) {
        reject(new PubSubError("not connected", "connection"));
        return;
      }

      const timeoutId = setTimeout(() => {
        const pending = pendingMetadataUpdates.get(ref);
        if (pending) {
          pendingMetadataUpdates.delete(ref);
          pending.reject(new PubSubError("metadata update timeout", "timeout"));
        }
      }, timeoutMs);

      pendingMetadataUpdates.set(ref, {
        resolve: () => {
          clearTimeout(timeoutId);
          resolve();
        },
        reject: (err) => {
          clearTimeout(timeoutId);
          reject(err);
        },
        timeoutId,
      });

      ws.send(
        JSON.stringify({
          action: "update-metadata",
          payload: newMetadata,
          ref,
        })
      );
    });
  }

  async function updateChannelConfig(
    config: Partial<ChannelConfig>,
    timeoutMs = 30000
  ): Promise<ChannelConfig> {
    const ref = ++refCounter;

    return new Promise((resolve, reject) => {
      if (ws.readyState !== WebSocket.OPEN) {
        reject(new PubSubError("not connected", "connection"));
        return;
      }

      const timeoutId = setTimeout(() => {
        const pending = pendingConfigUpdates.get(ref);
        if (pending) {
          pendingConfigUpdates.delete(ref);
          pending.reject(new PubSubError("config update timeout", "timeout"));
        }
      }, timeoutMs);

      pendingConfigUpdates.set(ref, {
        resolve: (newConfig) => {
          clearTimeout(timeoutId);
          resolve(newConfig);
        },
        reject: (err) => {
          clearTimeout(timeoutId);
          reject(err);
        },
        timeoutId,
      });

      ws.send(
        JSON.stringify({
          action: "update-config",
          config,
          ref,
        })
      );
    });
  }

  function close(): void {
    closed = true;
    isReconnecting = false;
    if (reconnectTimeoutId) {
      clearTimeout(reconnectTimeoutId);
      reconnectTimeoutId = null;
    }
    // Close the events fanout so events() iterators complete
    eventsFanout.close();
    // Send a graceful close action before closing the WebSocket. TCP ordering
    // guarantees the server processes this before the close frame, so it can
    // record a "graceful" leave reason instead of "disconnect". Fire-and-forget:
    // we don't need the ack since we're closing immediately after.
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ action: "close" }));
      } catch {
        // Best effort — connection may already be degraded
      }
    }
    ws.close();
  }

  async function sendRaw(message: Record<string, unknown>): Promise<void> {
    const ref = ++refCounter;
    const timeoutMs = 5000; // Short timeout for protocol messages

    return new Promise((resolve, reject) => {
      if (ws.readyState !== WebSocket.OPEN) {
        reject(new PubSubError("not connected", "connection"));
        return;
      }

      const timeoutId = setTimeout(() => {
        const pending = pendingPublishes.get(ref);
        if (pending) {
          pendingPublishes.delete(ref);
          pending.reject(new PubSubError("sendRaw timeout", "timeout"));
        }
      }, timeoutMs);

      pendingPublishes.set(ref, {
        resolve: () => {
          clearTimeout(timeoutId);
          resolve();
        },
        reject: (err) => {
          clearTimeout(timeoutId);
          reject(err);
        },
        timeoutId,
      });

      ws.send(JSON.stringify({ ...message, ref }));
    });
  }

  // =========================================================================
  // events() infrastructure — typed event stream over raw messages()
  // =========================================================================

  function normalizeSenderMetadata(
    meta: Record<string, unknown> | undefined
  ): { name?: string; type?: string; handle?: string } | undefined {
    if (!meta) return undefined;
    const result: { name?: string; type?: string; handle?: string } = {};
    if (typeof meta["name"] === "string") result.name = meta["name"] as string;
    if (typeof meta["type"] === "string") result.type = meta["type"] as string;
    if (typeof meta["handle"] === "string") result.handle = meta["handle"] as string;
    return Object.keys(result).length > 0 ? result : undefined;
  }

  function parseIncoming(pubsubMsg: PubSubMessage): IncomingEvent | null {
    const {
      type: msgType,
      payload,
      attachments: msgAttachments,
      senderId,
      ts,
      kind,
      id: pubsubId,
      senderMetadata,
    } = pubsubMsg;
    const normalizedSender = normalizeSenderMetadata(senderMetadata);

    if (msgType === "message") {
      const parsed = NewMessageSchema.safeParse(payload);
      if (!parsed.success) return null;
      return {
        type: "message",
        kind,
        senderId,
        ts,
        attachments: msgAttachments,
        pubsubId,
        senderMetadata: normalizedSender,
        id: parsed.data.id,
        content: parsed.data.content,
        replyTo: parsed.data.replyTo,
        contentType: parsed.data.contentType,
        at: parsed.data.at,
        metadata: parsed.data.metadata,
      } as IncomingNewMessage;
    }

    if (msgType === "update-message") {
      const parsed = UpdateMessageSchema.safeParse(payload);
      if (!parsed.success) return null;
      return {
        type: "update-message",
        kind,
        senderId,
        ts,
        attachments: msgAttachments,
        pubsubId,
        senderMetadata: normalizedSender,
        id: parsed.data.id,
        content: parsed.data.content,
        complete: parsed.data.complete,
        contentType: parsed.data.contentType,
      } as IncomingUpdateMessage;
    }

    if (msgType === "error") {
      const parsed = ErrorMessageSchema.safeParse(payload);
      if (!parsed.success) return null;
      return {
        type: "error",
        kind,
        senderId,
        ts,
        attachments: msgAttachments,
        pubsubId,
        senderMetadata: normalizedSender,
        id: parsed.data.id,
        error: parsed.data.error,
        code: parsed.data.code,
      } as IncomingErrorMessage;
    }

    if (msgType === "method-call") {
      const parsed = MethodCallSchema.safeParse(payload);
      if (!parsed.success) return null;
      return {
        type: "method-call",
        kind,
        senderId,
        ts,
        pubsubId,
        senderMetadata: normalizedSender,
        callId: parsed.data.callId,
        methodName: parsed.data.methodName,
        providerId: parsed.data.providerId,
        args: parsed.data.args,
      } as IncomingMethodCallEvent;
    }

    if (msgType === "method-result") {
      const parsed = MethodResultSchema.safeParse(payload);
      if (!parsed.success) return null;
      return {
        type: "method-result",
        kind,
        senderId,
        ts,
        pubsubId,
        senderMetadata: normalizedSender,
        callId: parsed.data.callId,
        content: parsed.data.content,
        contentType: parsed.data.contentType,
        complete: parsed.data.complete ?? false,
        isError: parsed.data.isError ?? false,
        progress: parsed.data.progress,
        attachments: msgAttachments,
      } as IncomingMethodResultEvent;
    }

    if (msgType === "execution-pause") {
      const parsed = ExecutionPauseSchema.safeParse(payload);
      if (!parsed.success) return null;
      return {
        type: "execution-pause",
        kind,
        senderId,
        ts,
        pubsubId,
        senderMetadata: normalizedSender,
        messageId: parsed.data.messageId,
        status: parsed.data.status,
        reason: parsed.data.reason,
      } as IncomingExecutionPauseEvent;
    }

    if (msgType === "presence") {
      const presencePayload = payload as { action?: string; metadata?: Record<string, unknown>; leaveReason?: string };
      if (!presencePayload.action || !presencePayload.metadata) return null;
      return {
        type: "presence",
        kind,
        senderId,
        ts,
        pubsubId,
        senderMetadata: normalizedSender,
        action: presencePayload.action,
        leaveReason: presencePayload.leaveReason,
        metadata: presencePayload.metadata,
      } as IncomingPresenceEventWithType;
    }

    if (msgType === "agent-debug") {
      return {
        type: "agent-debug",
        kind,
        senderId,
        ts,
        pubsubId,
        senderMetadata: normalizedSender,
        payload,
      } as unknown as IncomingAgentDebugEvent;
    }

    return null;
  }

  // Events fanout — broadcasts parsed IncomingEvents to all events() subscribers
  const eventsFanout = createFanout<IncomingEvent>();
  // Replay buffering for collect mode
  let bufferingReplay = replayMode !== "skip";
  let pendingReplay: IncomingEvent[] = [];
  let aggregatedReplay: AggregatedEvent[] = [];
  let initialReplayComplete = false;
  // Stream mode: raw replay events stored for yielding
  const streamReplayEvents: IncomingEvent[] = [];

  // Method auto-execution for provided methods
  const registeredMethods: Record<string, MethodDefinition> = { ...(providedMethods ?? {}) };

  async function handleMethodCallExec(event: IncomingMethodCallEvent): Promise<void> {
    // Only handle calls targeting this client
    if (!clientId || event.providerId !== clientId) {
      if (clientId && event.providerId) {
        console.warn(`[PubSubClient] Ignoring method-call "${event.methodName}" — target mismatch (target=${event.providerId}, self=${clientId}, callId=${event.callId})`);
      }
      return;
    }

    const methodDef = registeredMethods[event.methodName];
    if (!methodDef) {
      console.warn(`[PubSubClient] Received method-call for unregistered method "${event.methodName}" (callId=${event.callId}, from=${event.senderId})`);
      // Send error response so the caller doesn't hang waiting
      try {
        await publish("method-result", {
          callId: event.callId,
          content: { error: `Method "${event.methodName}" not registered on this client` },
          complete: true,
          isError: true,
        }, { persist: true });
      } catch { /* best effort */ }
      return;
    }

    const abortController = new AbortController();
    const ctx: MethodExecutionContext = {
      callId: event.callId,
      callerId: event.senderId,
      signal: abortController.signal,
      stream: async (content: unknown) => {
        await publish("method-result", {
          callId: event.callId,
          content,
          complete: false,
          isError: false,
        }, { persist: true });
      },
      streamWithAttachments: async (content: unknown, attachments: AttachmentInput[], streamOpts?: { contentType?: string }) => {
        await publish("method-result", {
          callId: event.callId,
          content,
          contentType: streamOpts?.contentType,
          complete: false,
          isError: false,
        }, { persist: true, attachments });
      },
      resultWithAttachments: <R>(content: R, attachments: AttachmentInput[], resultOpts?: { contentType?: string }) => ({
        content,
        attachments,
        contentType: resultOpts?.contentType,
      }),
      progress: async (percent: number) => {
        await publish("method-result", {
          callId: event.callId,
          complete: false,
          isError: false,
          progress: percent,
        }, { persist: false });
      },
    };

    try {
      // Validate and execute
      let args = event.args;
      if (methodDef.parameters && "_def" in methodDef.parameters) {
        args = (methodDef.parameters as z.ZodTypeAny).parse(args);
      }

      const result = await methodDef.execute(args, ctx);

      // Check if result has attachments (from resultWithAttachments)
      if (result && typeof result === "object" && "attachments" in (result as Record<string, unknown>) && "content" in (result as Record<string, unknown>)) {
        const withAttachments = result as { content: unknown; attachments: AttachmentInput[]; contentType?: string };
        await publish("method-result", {
          callId: event.callId,
          content: withAttachments.content,
          contentType: withAttachments.contentType,
          complete: true,
          isError: false,
        }, { persist: true, attachments: withAttachments.attachments });
      } else {
        await publish("method-result", {
          callId: event.callId,
          content: result,
          complete: true,
          isError: false,
        }, { persist: true });
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      await publish("method-result", {
        callId: event.callId,
        content: { error: errorMsg },
        complete: true,
        isError: true,
      }, { persist: true }).catch(() => {});
    }
  }

  // Process raw PubSubMessages for the events() infrastructure
  // This is callback-based (not iterator-based) to avoid competing with messages()
  rawMessageCallbacks.add((pubsubMsg: PubSubMessage) => {
    try {
      const event = parseIncoming(pubsubMsg);
      if (!event) return;

      // Auto-execute incoming method calls targeting this client
      if (event.type === "method-call" && event.kind !== "replay") {
        handleMethodCallExec(event as IncomingMethodCallEvent)
          .catch((err) => console.error(`[PubSubClient] Method execution failed:`, err));
      }

      // Buffer replay events
      if (event.kind === "replay") {
        if (replayMode === "skip") return;
        if (!bufferingReplay) {
          bufferingReplay = true;
          pendingReplay = [];
        }
        pendingReplay.push(event);
        if (replayMode === "stream") {
          streamReplayEvents.push(event);
        }
        return;
      }

      // Emit live events to all subscribers
      eventsFanout.emit(event);
    } catch {
      // Don't let a single bad message kill the processing
    }
  });

  // Handle ready signal for events infrastructure
  readySignalCallbacks.add(() => {
    if (replayMode !== "skip") {
      const aggregated = aggregateReplayEvents(pendingReplay);
      if (!initialReplayComplete) {
        aggregatedReplay = aggregated;
      } else if (aggregated.length > 0) {
        aggregatedReplay = [...aggregatedReplay, ...aggregated];
      }
    }
    bufferingReplay = false;
    pendingReplay = [];
    initialReplayComplete = true;
  });

  // Handle reconnection: reset replay buffering
  reconnectHandlers.add(() => {
    if (replayMode === "skip") return;
    bufferingReplay = true;
    pendingReplay = [];
  });

  function events(evtOptions?: EventStreamOptions): AsyncIterableIterator<EventStreamItem> {
    const source = eventsFanout.subscribe();
    const includeReplay = evtOptions?.includeReplay ?? false;
    const includeEphemeral = evtOptions?.includeEphemeral ?? false;

    function isIncomingEvent(event: EventStreamItem): event is IncomingEvent {
      return !("aggregated" in event);
    }

    return (async function* () {
      // Yield replay events first if requested
      if (includeReplay && replayMode !== "skip") {
        const replaySeed: EventStreamItem[] =
          replayMode === "stream" ? streamReplayEvents : aggregatedReplay;
        for (const item of replaySeed) {
          if (isIncomingEvent(item)) {
            if (!includeEphemeral && item.kind === "ephemeral") continue;
          }
          yield item;
        }
      }

      // Then yield live events
      for await (const event of source) {
        if (!includeEphemeral && event.kind === "ephemeral") continue;
        yield event;
      }
    })();
  }

  // =========================================================================
  // Agentic convenience methods — thin wrappers around publish()
  // =========================================================================

  function randomId(): string {
    const cryptoObj = (globalThis as unknown as { crypto?: { randomUUID(): string } }).crypto;
    if (cryptoObj?.randomUUID) return cryptoObj.randomUUID();
    // Fallback for environments without crypto.randomUUID
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  async function sendMessage(
    content: string,
    sendOptions?: {
      replyTo?: string;
      persist?: boolean;
      attachments?: AttachmentInput[];
      contentType?: string;
      at?: string[];
      metadata?: Record<string, unknown>;
    }
  ): Promise<{ messageId: string; pubsubId: number | undefined }> {
    const id = randomId();
    const payload: Record<string, unknown> = {
      id,
      content,
    };
    if (sendOptions?.replyTo) payload["replyTo"] = sendOptions.replyTo;
    if (sendOptions?.contentType) payload["contentType"] = sendOptions.contentType;
    if (sendOptions?.at) payload["at"] = sendOptions.at;
    if (sendOptions?.metadata) payload["metadata"] = sendOptions.metadata;

    const pubsubId = await publish("message", payload, {
      persist: sendOptions?.persist ?? true,
      attachments: sendOptions?.attachments,
    });
    return { messageId: id, pubsubId };
  }

  async function updateMessage(
    id: string,
    content: string,
    updateOptions?: { complete?: boolean; persist?: boolean; attachments?: AttachmentInput[]; contentType?: string }
  ): Promise<number | undefined> {
    const payload: Record<string, unknown> = { id, content };
    if (updateOptions?.complete !== undefined) payload["complete"] = updateOptions.complete;
    if (updateOptions?.contentType) payload["contentType"] = updateOptions.contentType;
    return await publish("update-message", payload, {
      persist: updateOptions?.persist ?? true,
      attachments: updateOptions?.attachments,
    });
  }

  async function completeMessage(id: string): Promise<number | undefined> {
    return await publish("update-message", { id, complete: true }, { persist: true });
  }

  async function errorMessage(id: string, errorMsg: string, code?: string): Promise<number | undefined> {
    const payload: Record<string, unknown> = { id, error: errorMsg };
    if (code) payload["code"] = code;
    return await publish("error", payload, { persist: true });
  }

  // Method call tracking for callMethod()
  interface MethodCallState {
    readonly callId: string;
    readonly stream: ReturnType<typeof createFanout<MethodResultChunk>>;
    readonly resolve: (value: MethodResultValue) => void;
    readonly reject: (error: Error) => void;
    complete: boolean;
    isError: boolean;
  }

  const methodCallStates = new Map<string, MethodCallState>();

  // Subscribe to the events fanout to intercept method-result events
  const methodResultSource = eventsFanout.subscribe();
  void (async () => {
    try {
      for await (const event of methodResultSource) {
        if (event.type !== "method-result") continue;
        const result = event as IncomingMethodResultEvent;
        const state = methodCallStates.get(result.callId);
        if (!state) continue;

        const chunk: MethodResultChunk = {
          content: result.content,
          attachments: result.attachments,
          contentType: result.contentType,
          complete: result.complete,
          isError: result.isError,
          progress: result.progress,
        };

        state.stream.emit(chunk);

        if (chunk.complete) {
          state.complete = true;
          state.isError = chunk.isError;
          state.stream.close();

          if (chunk.isError) {
            const content = chunk.content;
            let errorMsg = "method execution failed";
            if (content && typeof content === "object" && typeof (content as Record<string, unknown>)["error"] === "string") {
              errorMsg = (content as Record<string, unknown>)["error"] as string;
            }
            state.reject(new AgenticError(errorMsg, "execution-error", content));
          } else {
            state.resolve({
              content: chunk.content,
              attachments: chunk.attachments,
              contentType: chunk.contentType,
            });
          }
          methodCallStates.delete(result.callId);
        }
      }
    } catch {
      // Stream closed
    }
  })();

  function callMethod(
    providerId: string,
    methodName: string,
    args?: unknown,
    callOptions?: { timeoutMs?: number }
  ): MethodCallHandle {
    const callId = randomId();

    let resolveResult!: (value: MethodResultValue) => void;
    let rejectResult!: (error: Error) => void;
    const result = new Promise<MethodResultValue>((res, rej) => {
      resolveResult = res;
      rejectResult = rej;
    });

    const stream = createFanout<MethodResultChunk>();
    const state: MethodCallState = {
      callId,
      stream,
      resolve: resolveResult,
      reject: rejectResult,
      complete: false,
      isError: false,
    };
    methodCallStates.set(callId, state);

    // Publish the method-call message
    void publish("method-call", { callId, methodName, providerId, args: args ?? {} }, { persist: true }).catch((e: unknown) => {
      const err = e instanceof Error ? e : new Error(String(e));
      state.complete = true;
      state.isError = true;
      stream.close(err);
      rejectResult(new AgenticError(err.message, "connection-error", err));
      methodCallStates.delete(callId);
    });

    // Timeout
    const timeoutMs = callOptions?.timeoutMs;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    if (timeoutMs && timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        if (!state.complete) {
          state.complete = true;
          state.isError = true;
          stream.close();
          rejectResult(new AgenticError("method call timeout", "timeout"));
          methodCallStates.delete(callId);
        }
      }, timeoutMs);
    }

    // Clean up timeout when result arrives
    void result.finally(() => {
      if (timeoutId) clearTimeout(timeoutId);
    });

    return {
      callId,
      result,
      stream: stream.subscribe(),
      cancel: async () => {
        if (state.complete) return;
        state.complete = true;
        state.isError = true;
        stream.close();
        rejectResult(new AgenticError("cancelled", "cancelled"));
        methodCallStates.delete(callId);
        await publish("method-cancel", { callId }, { persist: true }).catch(() => {});
      },
      get complete() { return state.complete; },
      get isError() { return state.isError; },
    };
  }

  return {
    messages,
    publish,
    updateMetadata,
    ready,
    close,
    sendRaw,
    events,
    send: sendMessage,
    update: updateMessage,
    complete: completeMessage,
    error: errorMessage,
    callMethod,
    get clientId() {
      return clientId;
    },
    get connected() {
      return ws.readyState === WebSocket.OPEN;
    },
    get reconnecting() {
      return isReconnecting;
    },
    get contextId() {
      return serverContextId;
    },
    get channelConfig() {
      return serverChannelConfig;
    },
    onError: (handler: (error: Error) => void) => {
      errorHandlers.add(handler);
      return () => errorHandlers.delete(handler);
    },
    onDisconnect: (handler: () => void) => {
      disconnectHandlers.add(handler);
      return () => disconnectHandlers.delete(handler);
    },
    onReconnect: (handler: () => void) => {
      reconnectHandlers.add(handler);
      return () => reconnectHandlers.delete(handler);
    },
    onReady: (handler: () => void) => {
      readyHandlers.add(handler);
      return () => readyHandlers.delete(handler);
    },
    onRoster: (handler: (roster: RosterUpdate<T>) => void) => {
      rosterHandlers.add(handler);
      // Immediately call handler with current roster if it's not empty
      // This ensures handlers registered after replay still get the roster state
      if (Object.keys(currentRoster).length > 0) {
        handler({ participants: { ...currentRoster }, ts: Date.now() });
      }
      return () => rosterHandlers.delete(handler);
    },
    updateChannelConfig,
    onConfigChange: (handler: (config: ChannelConfig) => void) => {
      configChangeHandlers.add(handler);
      // Immediately call handler with current config if available
      if (serverChannelConfig) {
        handler(serverChannelConfig);
      }
      return () => configChangeHandlers.delete(handler);
    },
    get roster() {
      return { ...currentRoster };
    },
    get totalMessageCount() {
      return serverTotalCount;
    },
    get chatMessageCount() {
      return serverChatMessageCount;
    },
    get firstChatMessageId() {
      return serverFirstChatMessageId;
    },
    async getMessagesBefore(beforeId: number, limit = 100) {
      const ref = ++refCounter;
      const timeoutMs = 30000;

      return new Promise<MessagesBeforeResult>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          pendingMessagesBeforeRequests.delete(ref);
          reject(new PubSubError("get-messages-before timeout", "timeout"));
        }, timeoutMs);

        pendingMessagesBeforeRequests.set(ref, { resolve, reject, timeoutId });

        try {
          ws.send(JSON.stringify({
            action: "get-messages-before",
            beforeId,
            limit,
            ref,
          }));
        } catch (err) {
          clearTimeout(timeoutId);
          pendingMessagesBeforeRequests.delete(ref);
          reject(new PubSubError(`send failed: ${err}`, "connection"));
        }
      });
    },

  };
}
