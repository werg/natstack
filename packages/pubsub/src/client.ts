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
  ReconnectConfig,
  RosterUpdate,
  ParticipantMetadata,
  Participant,
  Attachment,
  ChannelConfig,
} from "./types.js";

/**
 * Server message envelope.
 */
interface ServerMessage {
  kind: "replay" | "persisted" | "ephemeral" | "ready" | "error" | "config-update";
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
}

type PresenceAction = "join" | "leave" | "update";

interface PresencePayload {
  action?: PresenceAction;
  metadata?: Record<string, unknown>;
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

  /** Register roster update handler. Returns unsubscribe function. */
  onRoster(handler: (roster: RosterUpdate<T>) => void): () => void;

  /** Update the channel config (merges with existing config). */
  updateChannelConfig(config: Partial<ChannelConfig>): Promise<ChannelConfig>;

  /** Register channel config change handler. Returns unsubscribe function. */
  onConfigChange(handler: (config: ChannelConfig) => void): () => void;

  /** Get the current roster participants (may be empty if no roster update received yet) */
  readonly roster: Record<string, Participant<T>>;
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
 * @param serverUrl - WebSocket server URL (e.g., "ws://127.0.0.1:49452")
 * @param token - Authentication token
 * @param options - Connection options including channel and optional sinceId
 * @returns A PubSubClient instance
 */
export function connect<T extends ParticipantMetadata = ParticipantMetadata>(
  serverUrl: string,
  token: string,
  options: ConnectOptions<T>
): PubSubClient<T> {
  const { channel, contextId, channelConfig, sinceId: initialSinceId, reconnect, metadata, clientId, skipOwnMessages } = options;

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

  // Message queue for the async iterator
  const messageQueue: Message[] = [];
  let messageResolve: ((msg: Message | null) => void) | null = null;

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
  const rosterHandlers = new Set<(roster: RosterUpdate<T>) => void>();
  const configChangeHandlers = new Set<(config: ChannelConfig) => void>();

  // Pending config update tracking
  const pendingConfigUpdates = new Map<
    number,
    { resolve: (config: ChannelConfig) => void; reject: (err: Error) => void; timeoutId: ReturnType<typeof setTimeout> }
  >();

  // Current roster state
  let currentRoster: Record<string, Participant<T>> = {};
  const rosterOpIds = new Set<number>();

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
    if (contextId !== undefined) {
      url.searchParams.set("contextId", contextId);
    }
    if (channelConfig !== undefined) {
      url.searchParams.set("channelConfig", JSON.stringify(channelConfig));
    }
    if (withSinceId !== undefined) {
      url.searchParams.set("sinceId", String(withSinceId));
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
        // Capture contextId and channelConfig from server ready message
        if (typeof msg.contextId === "string") {
          serverContextId = msg.contextId;
        }
        if (msg.channelConfig) {
          serverChannelConfig = msg.channelConfig;
        }
        readyResolve?.();
        readyResolve = null;
        readyReject = null;
        enqueueMessage({ kind: "ready" });
        break;

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

  return {
    messages,
    publish,
    updateMetadata,
    ready,
    close,
    sendRaw,
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
  };
}
