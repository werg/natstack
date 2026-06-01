import type { EnvelopeRpcTransport, RpcConnectionStatus, RpcEnvelope, RpcMessage } from "../types.js";
import type { WsClientMessage, WsServerMessage } from "../protocol/wsProtocol.js";
import type { RecoveryKind } from "../protocol/recoveryCoordinator.js";
import type { WsLike, WsTransportAdapter } from "../protocol/wsAdapter.js";

export interface WsClientTransportConfig {
  selfId: string;
  getWsUrl: () => string;
  adapter: WsTransportAdapter;
  connectionId?: string;
  reconnect?: boolean;
  terminalCloseCodes?: number[];
  getAuthMessageFields?: () => Partial<Extract<WsClientMessage, { type: "ws:auth" }>>;
  routeTarget?: (targetId: string) => string;
  translateEvent?: (
    event: string,
    payload: unknown,
    deliver: (message: RpcMessage) => void,
  ) => boolean;
  onServerEvent?: (event: string, payload: unknown) => void;
  onRecovery?: (kind: RecoveryKind) => void | Promise<void>;
  logPrefix?: string;
}

const OPEN = 1;

function randomId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function errorWithCode(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

export function wsClientTransport(config: WsClientTransportConfig): EnvelopeRpcTransport & {
  connect(): void;
  connectAndWait(timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
  onRecovery(kind: RecoveryKind, handler: () => void | Promise<void>): () => void;
} {
  const connectionId = config.connectionId ?? randomId();
  const messageListeners = new Set<(envelope: RpcEnvelope) => void>();
  const statusListeners = new Set<(status: RpcConnectionStatus) => void>();
  const recoveryListeners = new Map<RecoveryKind, Set<() => void | Promise<void>>>();
  let socket: WsLike | null = null;
  let authenticated = false;
  let closed = false;
  let status: RpcConnectionStatus = "disconnected";
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;
  let hasConnectedBefore = false;
  let lastSeenBootId: string | null = null;
  let authToken: string | null = null;
  let firstConnectPromise: Promise<void> | null = null;
  let firstConnectResolve: (() => void) | null = null;
  let firstConnectReject: ((error: Error) => void) | null = null;

  const setStatus = (next: RpcConnectionStatus): void => {
    if (status === next) return;
    status = next;
    for (const listener of statusListeners) listener(next);
  };

  const clearReconnectTimer = (): void => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
  };

  const emitRecovery = (kind: RecoveryKind): void => {
    void config.onRecovery?.(kind);
    for (const listener of recoveryListeners.get(kind) ?? []) {
      try {
        void listener();
      } catch (error) {
        console.error("[wsClientTransport] Recovery listener failed:", error);
      }
    }
  };

  const scheduleReconnect = (socketGeneration: number): void => {
    if (closed) return;
    clearReconnectTimer();
    const jitter = Math.random() * 500;
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempt) + jitter, 30_000);
    reconnectAttempt += 1;
    setStatus("connecting");
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (closed || socketGeneration !== generation) return;
      void openSocket();
    }, delay);
  };

  const handleAuthFailure = async (): Promise<void> => {
    if (!config.adapter.refreshAuthToken) {
      firstConnectReject?.(new Error("Server auth failed"));
      firstConnectReject = null;
      firstConnectResolve = null;
      if (!hasConnectedBefore) closed = true;
      socket?.close(4006, "Authentication failed");
      return;
    }
    try {
      authToken = await config.adapter.refreshAuthToken();
      const oldSocket = socket;
      const nextGeneration = ++generation;
      oldSocket?.close(4000, "Refreshing auth token");
      reconnectAttempt = 0;
      setTimeout(() => {
        if (closed || nextGeneration !== generation) return;
        void openSocket();
      }, 0);
    } catch (error) {
      console.warn("[wsClientTransport] Auth refresh failed:", error);
      socket?.close(4006, "Authentication failed");
    }
  };

  const handleServerMessage = (msg: WsServerMessage): void => {
    switch (msg.type) {
      case "ws:auth-result": {
        if (!msg.success) {
          void handleAuthFailure();
          return;
        }
        const previousBootId = lastSeenBootId;
        const nextBootId = msg.serverBootId ?? null;
        const isReconnect = hasConnectedBefore;
        authenticated = true;
        hasConnectedBefore = true;
        firstConnectResolve?.();
        firstConnectResolve = null;
        firstConnectReject = null;
        lastSeenBootId = nextBootId;
        reconnectAttempt = 0;
        setStatus("connected");
        if (msg.sessionDirty === true || (isReconnect && previousBootId && nextBootId && previousBootId !== nextBootId)) {
          emitRecovery("cold-recover");
        } else {
          emitRecovery("resubscribe");
        }
        return;
      }
      case "ws:rpc":
      case "ws:routed":
        if (msg.envelope) {
          for (const listener of messageListeners) listener(msg.envelope);
          return;
        }
        if (msg.message) {
          const legacyFrom =
            "fromId" in msg.message && typeof msg.message.fromId === "string"
              ? msg.message.fromId
              : "unknown";
          const from = msg.type === "ws:routed" ? (msg.fromId ?? legacyFrom) : "main";
          const callerKind = msg.type === "ws:routed" ? (msg.fromKind ?? "unknown") : "server";
          const envelope: RpcEnvelope = {
            from,
            target: config.selfId,
            delivery: { caller: { callerId: from, callerKind } },
            provenance: [{ callerId: from, callerKind }],
            message: msg.message,
          };
          for (const listener of messageListeners) listener(envelope);
        }
        return;
      case "ws:event":
        if (
          config.translateEvent?.(msg.event, msg.payload, (message) => {
            const envelope: RpcEnvelope = {
              from: "main",
              target: config.selfId,
              delivery: { caller: { callerId: "main", callerKind: "server" } },
              provenance: [{ callerId: "main", callerKind: "server" }],
              message,
            };
            for (const listener of messageListeners) listener(envelope);
          })
        ) {
          return;
        }
        config.onServerEvent?.(msg.event, msg.payload);
        return;
      case "ws:routed-event-error":
      case "ws:routed-response-error":
        return;
    }
  };

  const openSocket = async (): Promise<void> => {
    const socketGeneration = ++generation;
    const prefix = config.logPrefix ?? "wsClientTransport";
    setStatus("connecting");
    authenticated = false;

    let token: string;
    try {
      token = authToken ?? (await config.adapter.getAuthToken());
      authToken = token;
    } catch (error) {
      console.warn(`[${prefix}] Failed to get auth token:`, error);
      scheduleReconnect(socketGeneration);
      return;
    }

    const nextSocket = config.adapter.createSocket(config.getWsUrl());
    socket = nextSocket;
    nextSocket.onopen = () => {
      if (socketGeneration !== generation || socket !== nextSocket) return;
      nextSocket.send(
        JSON.stringify({
          type: "ws:auth",
          token,
          connectionId,
          ...config.getAuthMessageFields?.(),
        } satisfies WsClientMessage),
      );
    };
    nextSocket.onmessage = (event) => {
      if (socketGeneration !== generation || socket !== nextSocket) return;
      try {
        handleServerMessage(JSON.parse(String(event.data)) as WsServerMessage);
      } catch (error) {
        console.warn(`[${prefix}] Malformed message from server:`, error);
      }
    };
    nextSocket.onerror = (event) => {
      if (socketGeneration !== generation || socket !== nextSocket) return;
      console.warn(`[${prefix}] WebSocket error`, event);
      if (!hasConnectedBefore && firstConnectReject) {
        firstConnectReject(new Error(event instanceof Error ? event.message : "WebSocket error"));
        firstConnectReject = null;
        firstConnectResolve = null;
        closed = true;
      }
    };
    nextSocket.onclose = (event) => {
      if (socketGeneration !== generation || socket !== nextSocket) return;
      authenticated = false;
      const terminalCodes = new Set(config.terminalCloseCodes ?? []);
      if (closed || terminalCodes.has(event.code ?? 0) || config.reconnect === false) {
        setStatus("disconnected");
        return;
      }
      scheduleReconnect(socketGeneration);
    };
  };

  return {
    connect(): void {
      closed = false;
      clearReconnectTimer();
      void openSocket();
    },
    connectAndWait(timeoutMs = 10_000): Promise<void> {
      if (socket?.readyState === OPEN && authenticated) return Promise.resolve();
      let shouldConnect = false;
      if (!firstConnectPromise) {
        firstConnectPromise = new Promise<void>((resolve, reject) => {
          firstConnectResolve = resolve;
          firstConnectReject = reject;
        });
        shouldConnect = !socket || status === "disconnected";
      }
      if (shouldConnect) this.connect();
      return new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Server WS connection timeout (${timeoutMs}ms): ${config.getWsUrl()}`)), timeoutMs);
        firstConnectPromise!.then(
          () => {
            clearTimeout(timeout);
            resolve();
          },
          (error) => {
            clearTimeout(timeout);
            reject(error);
          },
        );
      });
    },
    async close(): Promise<void> {
      closed = true;
      clearReconnectTimer();
      const current = socket;
      socket = null;
      authenticated = false;
      setStatus("disconnected");
      if (!current || current.readyState !== OPEN) return;
      await new Promise<void>((resolve) => {
        const done = (): void => resolve();
        current.onclose = done;
        current.close(1000, "Client closing");
        setTimeout(done, 2000);
      });
    },
    async send(envelope): Promise<void> {
      const current = socket;
      if (!current || current.readyState !== OPEN || !authenticated) {
        throw errorWithCode("Not connected to server", "CONNECTION_LOST");
      }
      const target = config.routeTarget?.(envelope.target) ?? envelope.target;
      const routedEnvelope = target === envelope.target ? envelope : { ...envelope, target };
      const message: WsClientMessage =
        target === "main"
          ? { type: "ws:rpc", envelope: routedEnvelope }
          : { type: "ws:route", envelope: routedEnvelope };
      current.send(JSON.stringify(message));
    },
    onMessage(handler) {
      messageListeners.add(handler);
      return () => messageListeners.delete(handler);
    },
    status: () => status,
    ready() {
      return this.connectAndWait();
    },
    onStatusChange(handler) {
      statusListeners.add(handler);
      return () => statusListeners.delete(handler);
    },
    onRecovery(kind, handler) {
      let listeners = recoveryListeners.get(kind);
      if (!listeners) {
        listeners = new Set();
        recoveryListeners.set(kind, listeners);
      }
      listeners.add(handler);
      return () => {
        listeners?.delete(handler);
        if (listeners?.size === 0) recoveryListeners.delete(kind);
      };
    },
  };
}
