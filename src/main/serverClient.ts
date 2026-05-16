/**
 * ServerClient — WebSocket RPC client that connects Electron to the server.
 *
 * Supports both local (ws://127.0.0.1:{port}) and remote (ws://{host}:{port}/rpc)
 * connections. Handles RPC calls, disconnect recovery with automatic reconnection
 * (exponential backoff), and server event delivery.
 */

import { WebSocket } from "ws";
import { randomUUID } from "crypto";
import * as fs from "fs";
import type { RpcMessage, RpcResponse } from "@natstack/rpc";
import type { WsClientMessage, WsServerMessage } from "@natstack/shared/ws/protocol";
import type { RecoveryKind } from "@natstack/shared/shell/recoveryCoordinator";
import { redactTokenIn } from "@natstack/shared/redact";
import { mintCallerAssertion, type CallerKind } from "@natstack/shared/identity/callerAssertion";
import { createPinnedTlsSocket } from "./tlsPinning.js";

export interface TlsPinningOptions {
  /** Path to a CA certificate (PEM) for self-signed servers */
  caPath?: string;
  /** Expected leaf cert SHA-256 fingerprint (uppercase, colon-separated) */
  fingerprint?: string;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export type ConnectionStatus = "connected" | "connecting" | "disconnected";

export interface ServerClient {
  /** Call a backend service via the server */
  call(service: string, method: string, args: unknown[]): Promise<unknown>;
  /** Check if connected */
  isConnected(): boolean;
  /** Current connection status */
  getConnectionStatus(): ConnectionStatus;
  /** Close connection, reject all pending calls, stop reconnection */
  close(): Promise<void>;
}

export interface ServerClientOptions {
  /** Full WebSocket URL (e.g., "ws://127.0.0.1:3000" or "ws://remote.example.com:8080/rpc") */
  wsUrl?: string;
  /** Dynamic WebSocket URL provider, consulted before each connect/reconnect. */
  getWsUrl?: () => string;
  /** TLS pinning options — only honored for wss:// URLs */
  tls?: TlsPinningOptions;
  /** Called when the connection is permanently lost (after all retries exhausted) */
  onDisconnect?: () => void;
  /** Called when connection status changes (for UI indicators) */
  onConnectionStatusChanged?: (status: ConnectionStatus) => void;
  /** Called when the server sends an event */
  onEvent?: (event: string, payload: unknown) => void;
  /** Called after auth when the transport needs subscriptions or state replayed. */
  onRecovery?: (kind: RecoveryKind) => void | Promise<void>;
  /** Enable automatic reconnection on disconnect (default: false for local, true if wsUrl is set) */
  reconnect?: boolean;
  /** Maximum number of reconnection attempts (default: 10) */
  maxReconnectAttempts?: number;
  /** Refresh the caller token after an auth failure during reconnect. */
  refreshAuthToken?: () => Promise<string>;
  /** Local caller assertion used for direct shell connections to a local gateway. */
  callerAssertion?: {
    secretBase64: string;
    callerId: string;
    callerKind: CallerKind;
  };
}

class ServerAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServerAuthError";
  }
}

/** Connect a WebSocket and wait for the server to bind the verified caller. */
async function connectAndReady(
  wsUrl: string,
  callerToken: string,
  tlsOpts: TlsPinningOptions | undefined,
  connectionId: string,
  callerAssertion?: ServerClientOptions["callerAssertion"]
): Promise<{ ws: WebSocket; serverBootId?: string }> {
  const isTls = wsUrl.startsWith("wss://");
  const readyUrl = appendConnectionId(wsUrl, connectionId);
  const wsOptions: Record<string, unknown> = {
    headers: callerAssertion
      ? { "Proxy-Authorization": basicCallerAssertion(callerAssertion) }
      : { Authorization: `Bearer ${callerToken}` },
  };

  if (isTls && tlsOpts) {
    if (tlsOpts.caPath) {
      try {
        wsOptions["ca"] = fs.readFileSync(tlsOpts.caPath);
      } catch (err) {
        throw new Error(`Failed to read CA cert at ${tlsOpts.caPath}: ${(err as Error).message}`);
      }
    }

    if (tlsOpts.fingerprint) {
      // **Fingerprint pinning.** Install a `createConnection` factory that
      // validates the leaf cert in `secureConnect` — fires between TLS
      // handshake completion and the upgrade request. See `tlsPinning.ts`.
      // `rejectUnauthorized: false` below
      // only suspends Node's own CA path; the factory's secureConnect
      // listener is what actually enforces trust.
      wsOptions["rejectUnauthorized"] = false;
      wsOptions["checkServerIdentity"] = () => undefined;

      const expected = tlsOpts.fingerprint;
      const wsProtocolUrl = new URL(wsUrl);
      const host = wsProtocolUrl.hostname;
      const port = parseInt(wsProtocolUrl.port, 10) || 443;
      wsOptions["createConnection"] = () =>
        createPinnedTlsSocket({ host, port, expectedFingerprint: expected });
    }
  }

  const ws = new WebSocket(readyUrl, wsOptions);
  let serverBootId: string | undefined;

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Server WS connection timeout (10s): ${readyUrl}`));
      ws.close();
    }, 10_000);

    ws.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    ws.on("message", function onReady(data) {
      const msg = JSON.parse(data.toString()) as WsServerMessage;
      if (msg.type === "ws:ready") {
        ws.off("message", onReady);
        clearTimeout(timeout);
        serverBootId = msg.serverBootId;
        resolve();
      }
    });
  });

  return { ws, serverBootId };
}

function basicCallerAssertion(args: NonNullable<ServerClientOptions["callerAssertion"]>): string {
  const assertion = mintCallerAssertion(Buffer.from(args.secretBase64, "base64"), {
    callerId: args.callerId,
    callerKind: args.callerKind,
    audience: "egress-proxy",
  });
  return `Basic ${Buffer.from(`natstack:${assertion}`, "utf8").toString("base64")}`;
}

function appendConnectionId(wsUrl: string, connectionId: string): string {
  const url = new URL(wsUrl);
  url.searchParams.set("connectionId", connectionId);
  return url.toString();
}

/**
 * Create a server client connected to a local or remote server.
 *
 * @param serverRpcPort - Port number (used to build ws://127.0.0.1:{port} when wsUrl is not provided)
 * @param authToken - Caller authentication token
 * @param options - Optional: wsUrl override, disconnect callback, event handler, reconnect settings
 */
export async function createServerClient(
  serverRpcPort: number,
  authToken: string,
  options?: ServerClientOptions
): Promise<ServerClient> {
  const pendingCalls = new Map<string, PendingCall>();
  const getWsUrl =
    options?.getWsUrl ?? (() => options?.wsUrl ?? `ws://127.0.0.1:${serverRpcPort}/rpc`);
  const shouldReconnect = options?.reconnect ?? !!(options?.wsUrl || options?.getWsUrl);
  const maxAttempts = options?.maxReconnectAttempts ?? 10;
  const tls = options?.tls;
  const callerAssertion = options?.callerAssertion;
  const connectionId = randomUUID();

  let ws: WebSocket;
  let activeAuthToken = authToken;
  let connectionStatus: ConnectionStatus = "connecting";
  let closed = false; // true after explicit close()
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let lastSeenBootId: string | undefined;

  function setStatus(status: ConnectionStatus) {
    if (status === connectionStatus) return;
    connectionStatus = status;
    options?.onConnectionStatusChanged?.(status);
  }

  function wireErrorHandler(socket: WebSocket) {
    socket.on("error", (err) => {
      console.warn("[ServerClient] WebSocket error:", redactTokenIn(err.message, activeAuthToken));
      // The 'close' event will follow and trigger reconnection
    });
  }

  function wireMessageHandler(socket: WebSocket) {
    socket.on("message", (data) => {
      let msg: WsServerMessage;
      try {
        msg = JSON.parse(data.toString()) as WsServerMessage;
      } catch (e) {
        console.warn("[ServerClient] Malformed message from server:", e);
        return;
      }

      if (msg.type === "ws:rpc") {
        const rpcMsg = msg.message as RpcResponse;
        if (rpcMsg.type === "response") {
          const pending = pendingCalls.get(rpcMsg.requestId);
          if (pending) {
            pendingCalls.delete(rpcMsg.requestId);
            if ("error" in rpcMsg) {
              pending.reject(new Error(rpcMsg.error));
            } else {
              pending.resolve(rpcMsg.result);
            }
          }
        }
      } else if (msg.type === "ws:event") {
        options?.onEvent?.(msg.event, msg.payload);
      } else if (msg.type === "ws:routed-event-error") {
        options?.onEvent?.("runtime:routed-event-error", {
          targetId: msg.targetId,
          event: msg.event,
          error: msg.error,
          errorCode: msg.errorCode,
        });
      } else if (msg.type === "ws:routed-response-error") {
        options?.onEvent?.("runtime:routed-response-error", {
          targetId: msg.targetId,
          requestId: msg.requestId,
          error: msg.error,
          errorCode: msg.errorCode,
        });
      }
    });
  }

  function wireSocket(socket: WebSocket) {
    wireErrorHandler(socket);
    wireMessageHandler(socket);
    wireCloseHandler(socket);
  }

  function emitRecovery(serverBootId?: string) {
    const previousBootId = lastSeenBootId;
    lastSeenBootId = serverBootId;
    void options?.onRecovery?.("resubscribe");
    if (previousBootId && serverBootId && previousBootId !== serverBootId) {
      void options?.onRecovery?.("cold-recover");
    }
  }

  async function connectWithActiveToken(): Promise<{ socket: WebSocket; serverBootId?: string }> {
    const { ws: socket, serverBootId } = await connectAndReady(
      getWsUrl(),
      activeAuthToken,
      tls,
      connectionId,
      callerAssertion
    );
    return { socket, serverBootId };
  }

  async function refreshAndConnect(): Promise<{ socket: WebSocket; serverBootId?: string } | null> {
    if (!options?.refreshAuthToken) return null;
    activeAuthToken = await options.refreshAuthToken();
    return connectWithActiveToken();
  }

  async function attemptReconnect() {
    if (closed) return;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (closed) return;
      setStatus("connecting");

      // Exponential backoff: 1s, 2s, 4s, 8s, ... capped at 30s
      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 30_000);
      console.log(
        `[ServerClient] Reconnecting (attempt ${attempt}/${maxAttempts}) in ${delay}ms...`
      );

      await new Promise<void>((resolve) => {
        reconnectTimer = setTimeout(resolve, delay);
      });
      reconnectTimer = null;

      if (closed) return;

      try {
        const connected = await connectWithActiveToken();
        ws = connected.socket;
        wireSocket(ws);
        setStatus("connected");
        emitRecovery(connected.serverBootId);
        console.log(`[ServerClient] Reconnected successfully`);
        return;
      } catch (err) {
        if (err instanceof ServerAuthError) {
          try {
            const refreshed = await refreshAndConnect();
            if (refreshed) {
              ws = refreshed.socket;
              wireSocket(ws);
              setStatus("connected");
              emitRecovery(refreshed.serverBootId);
              console.log("[ServerClient] Reconnected successfully after refreshing caller token");
              return;
            }
          } catch (refreshErr) {
            console.warn(
              "[ServerClient] Reconnect token refresh failed:",
              redactTokenIn((refreshErr as Error).message, activeAuthToken)
            );
          }
        }
        console.warn(
          `[ServerClient] Reconnect attempt ${attempt} failed:`,
          redactTokenIn((err as Error).message, activeAuthToken)
        );
      }
    }

    // All retries exhausted
    console.error(`[ServerClient] Failed to reconnect after ${maxAttempts} attempts`);
    setStatus("disconnected");
    options?.onDisconnect?.();
  }

  function wireCloseHandler(socket: WebSocket) {
    socket.on("close", () => {
      if (closed) return;
      if (socket !== ws) return;

      // Reject pending calls — they won't be answered on the old socket
      for (const [, pending] of pendingCalls) {
        pending.reject(new Error("Server disconnected"));
      }
      pendingCalls.clear();

      if (shouldReconnect) {
        setStatus("connecting");
        void attemptReconnect();
      } else {
        setStatus("disconnected");
        options?.onDisconnect?.();
      }
    });
  }

  // Initial connection
  const initial = await connectWithActiveToken();
  ws = initial.socket;
  wireSocket(ws);
  setStatus("connected");
  emitRecovery(initial.serverBootId);

  const client: ServerClient = {
    call(service: string, method: string, args: unknown[]): Promise<unknown> {
      if (ws.readyState !== WebSocket.OPEN) {
        return Promise.reject(new Error("Server not connected"));
      }

      const requestId = randomUUID();
      return new Promise((resolve, reject) => {
        pendingCalls.set(requestId, { resolve, reject });

        const rpcMsg: RpcMessage = {
          type: "request",
          requestId,
          method: `${service}.${method}`,
          args,
        };
        const envelope: WsClientMessage = { type: "ws:rpc", message: rpcMsg };
        ws.send(JSON.stringify(envelope));
      });
    },

    isConnected(): boolean {
      return ws.readyState === WebSocket.OPEN;
    },

    getConnectionStatus(): ConnectionStatus {
      return connectionStatus;
    },

    async close(): Promise<void> {
      closed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (ws.readyState === WebSocket.CLOSED) return;
      ws.close(1000, "Client closing");
      await new Promise<void>((resolve) => {
        ws.on("close", () => resolve());
        setTimeout(resolve, 2000);
      });
    },
  };

  return client;
}
