/**
 * PubSub WebSocket client implementation.
 *
 * Provides an async/generator-friendly API for pub/sub messaging.
 */

import { PubSubError } from "./types.js";
import type { Message, PublishOptions, ConnectOptions, ReconnectConfig } from "./types.js";

/**
 * Server message envelope.
 */
interface ServerMessage {
  kind: "replay" | "persisted" | "ephemeral" | "ready" | "error";
  id?: number;
  type?: string;
  payload?: unknown;
  senderId?: string;
  ts?: number;
  ref?: number;
  error?: string;
}

/**
 * PubSub client interface.
 */
export interface PubSubClient {
  /** Async iterator for incoming messages */
  messages(): AsyncIterableIterator<Message>;

  /** Publish a message to the channel. Returns the message ID for persisted messages. */
  publish<T>(type: string, payload: T, options?: PublishOptions): Promise<number | undefined>;

  /** Wait for the ready signal (replay complete). Throws if timeout exceeded. */
  ready(timeoutMs?: number): Promise<void>;

  /** Close the connection */
  close(): void;

  /** Whether currently connected */
  readonly connected: boolean;

  /** Whether currently attempting to reconnect */
  readonly reconnecting: boolean;

  /** Register error handler. Returns unsubscribe function. */
  onError(handler: (error: Error) => void): () => void;

  /** Register disconnect handler. Returns unsubscribe function. */
  onDisconnect(handler: () => void): () => void;

  /** Register reconnect handler (called after successful reconnection). Returns unsubscribe function. */
  onReconnect(handler: () => void): () => void;
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
export function connect(serverUrl: string, token: string, options: ConnectOptions): PubSubClient {
  const { channel, sinceId: initialSinceId, reconnect } = options;

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

  // Message queue for the async iterator
  const messageQueue: Message[] = [];
  let messageResolve: ((msg: Message | null) => void) | null = null;

  // Pending publish tracking
  const pendingPublishes = new Map<
    number,
    { resolve: (id?: number) => void; reject: (err: Error) => void; timeoutId: ReturnType<typeof setTimeout> }
  >();

  // Event handlers
  const errorHandlers = new Set<(error: Error) => void>();
  const disconnectHandlers = new Set<() => void>();
  const reconnectHandlers = new Set<() => void>();

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
    if (withSinceId !== undefined) {
      url.searchParams.set("sinceId", String(withSinceId));
    }
    return url.toString();
  }

  function handleError(error: PubSubError): void {
    for (const handler of errorHandlers) {
      handler(error);
    }
  }

  function handleMessage(event: MessageEvent): void {
    const msg = JSON.parse(event.data as string) as ServerMessage;

    switch (msg.kind) {
      case "ready":
        readyResolve?.();
        readyResolve = null;
        readyReject = null;
        break;

      case "error": {
        const errorMsg = msg.error || "unknown server error";
        let code: "validation" | "server" = "server";
        if (errorMsg.includes("not serializable") || errorMsg.includes("invalid")) {
          code = "validation";
        }
        const error = new PubSubError(errorMsg, code);

        if (msg.ref !== undefined) {
          const pending = pendingPublishes.get(msg.ref);
          if (pending) {
            clearTimeout(pending.timeoutId);
            pending.reject(error);
            pendingPublishes.delete(msg.ref);
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

        // Resolve pending publish if this is our own message
        if (msg.ref !== undefined) {
          const pending = pendingPublishes.get(msg.ref);
          if (pending) {
            clearTimeout(pending.timeoutId);
            pending.resolve(msg.id);
            pendingPublishes.delete(msg.ref);
          }
        }

        const message: Message = {
          kind: msg.kind,
          id: msg.id,
          type: msg.type!,
          payload: msg.payload,
          senderId: msg.senderId!,
          ts: msg.ts!,
        };

        if (messageResolve) {
          messageResolve(message);
          messageResolve = null;
        } else {
          messageQueue.push(message);
        }
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

  function handleWsClose(): void {
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
      rejectPendingPublishes(new PubSubError("connection closed", "connection"));
      readyReject?.(new PubSubError("connection closed", "connection"));
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
      rejectPendingPublishes(new PubSubError("connection closed", "connection"));
      readyReject?.(new PubSubError("connection closed", "connection"));
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
    };
  }

  // Initial connection
  resetReadyPromise();
  ws = new WebSocket(buildWsUrl(initialSinceId));
  wireUpWebSocket();

  async function* messages(): AsyncIterableIterator<Message> {
    while (!closed) {
      if (messageQueue.length > 0) {
        yield messageQueue.shift()!;
      } else {
        const msg = await new Promise<Message | null>((resolve) => {
          if (closed && !isReconnecting) {
            resolve(null);
            return;
          }
          messageResolve = resolve;
        });
        if (msg === null) break;
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

  async function publish<T>(
    type: string,
    payload: T,
    publishOptions: PublishOptions = {}
  ): Promise<number | undefined> {
    const ref = ++refCounter;
    const { persist = true, timeoutMs = 30000 } = publishOptions;

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

      ws.send(
        JSON.stringify({
          action: "publish",
          type,
          payload,
          persist,
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

  return {
    messages,
    publish,
    ready,
    close,
    get connected() {
      return ws.readyState === WebSocket.OPEN;
    },
    get reconnecting() {
      return isReconnecting;
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
  };
}
