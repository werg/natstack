/**
 * ServerClient — WebSocket admin client that connects Electron to the server.
 *
 * Supports both local (ws://127.0.0.1:{port}) and remote (ws://{host}:{port}/rpc)
 * connections. Handles RPC calls, disconnect recovery with automatic reconnection
 * (exponential backoff), and server event delivery.
 */

import { WebSocket } from "ws";
import { randomUUID } from "crypto";
import type { RpcMessage, RpcResponse } from "@natstack/rpc";
import type {
  WsClientMessage,
  WsServerMessage,
} from "../shared/ws/protocol.js";

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
  /** Called when the connection is permanently lost (after all retries exhausted) */
  onDisconnect?: () => void;
  /** Called when connection status changes (for UI indicators) */
  onConnectionStatusChanged?: (status: ConnectionStatus) => void;
  /** Called when the server sends an event */
  onEvent?: (event: string, payload: unknown) => void;
  /** Enable automatic reconnection on disconnect (default: false for local, true if wsUrl is set) */
  reconnect?: boolean;
  /** Maximum number of reconnection attempts (default: 10) */
  maxReconnectAttempts?: number;
}

/** Connect a WebSocket and authenticate. Returns the connected+authed ws. */
async function connectAndAuth(wsUrl: string, adminToken: string): Promise<WebSocket> {
  const ws = new WebSocket(wsUrl);

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Server WS connection timeout (10s): ${wsUrl}`));
      ws.close();
    }, 10_000);

    ws.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    ws.on("open", () => {
      const authMsg: WsClientMessage = { type: "ws:auth", token: adminToken };
      ws.send(JSON.stringify(authMsg));
    });

    ws.on("message", function onAuth(data) {
      const msg = JSON.parse(data.toString()) as WsServerMessage;
      if (msg.type === "ws:auth-result") {
        ws.off("message", onAuth);
        clearTimeout(timeout);
        if (msg.success) {
          resolve();
        } else {
          reject(new Error(`Server auth failed: ${msg.error}`));
        }
      }
    });
  });

  return ws;
}

/**
 * Create a server client connected to a local or remote server.
 *
 * @param serverRpcPort - Port number (used to build ws://127.0.0.1:{port} when wsUrl is not provided)
 * @param adminToken - Authentication token
 * @param options - Optional: wsUrl override, disconnect callback, event handler, reconnect settings
 */
export async function createServerClient(
  serverRpcPort: number,
  adminToken: string,
  options?: ServerClientOptions,
): Promise<ServerClient> {
  const pendingCalls = new Map<string, PendingCall>();
  const wsUrl = options?.wsUrl ?? `ws://127.0.0.1:${serverRpcPort}`;
  const shouldReconnect = options?.reconnect ?? !!options?.wsUrl;
  const maxAttempts = options?.maxReconnectAttempts ?? 10;

  let ws: WebSocket;
  let connectionStatus: ConnectionStatus = "connecting";
  let closed = false; // true after explicit close()
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function setStatus(status: ConnectionStatus) {
    if (status === connectionStatus) return;
    connectionStatus = status;
    options?.onConnectionStatusChanged?.(status);
  }

  function wireErrorHandler(socket: WebSocket) {
    socket.on("error", (err) => {
      console.warn("[ServerClient] WebSocket error:", err.message);
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
        options?.onEvent?.(
          (msg as any).event as string,
          (msg as any).payload,
        );
      }
    });
  }

  async function attemptReconnect() {
    if (closed) return;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (closed) return;
      setStatus("connecting");

      // Exponential backoff: 1s, 2s, 4s, 8s, ... capped at 30s
      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 30_000);
      console.log(`[ServerClient] Reconnecting (attempt ${attempt}/${maxAttempts}) in ${delay}ms...`);

      await new Promise<void>((resolve) => {
        reconnectTimer = setTimeout(resolve, delay);
      });
      reconnectTimer = null;

      if (closed) return;

      try {
        ws = await connectAndAuth(wsUrl, adminToken);
        wireErrorHandler(ws);
        wireMessageHandler(ws);
        wireCloseHandler(ws);
        setStatus("connected");
        console.log(`[ServerClient] Reconnected successfully`);
        return;
      } catch (err) {
        console.warn(`[ServerClient] Reconnect attempt ${attempt} failed:`, (err as Error).message);
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
  ws = await connectAndAuth(wsUrl, adminToken);
  wireErrorHandler(ws);
  wireMessageHandler(ws);
  wireCloseHandler(ws);
  setStatus("connected");

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
          fromId: "admin",
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
