/**
 * ServerClient — WebSocket admin client that connects Electron to the server.
 *
 * Supports both local (ws://127.0.0.1:{port}) and remote (ws://{host}:{port}/rpc)
 * connections. Handles RPC calls, disconnect recovery, and server event delivery.
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

export interface ServerClient {
  /** Call a backend service via the server */
  call(service: string, method: string, args: unknown[]): Promise<unknown>;
  /** Check if connected */
  isConnected(): boolean;
  /** Close connection, reject all pending calls */
  close(): Promise<void>;
}

export interface ServerClientOptions {
  /** Full WebSocket URL (e.g., "ws://127.0.0.1:3000" or "ws://remote.example.com:8080/rpc") */
  wsUrl?: string;
  /** Called when the connection is lost */
  onDisconnect?: () => void;
  /** Called when the server sends an event */
  onEvent?: (event: string, payload: unknown) => void;
}

/**
 * Create a server client connected to a local or remote server.
 *
 * @param serverRpcPort - Port number (used to build ws://127.0.0.1:{port} when wsUrl is not provided)
 * @param adminToken - Authentication token
 * @param options - Optional: wsUrl override, disconnect callback, event handler
 */
export async function createServerClient(
  serverRpcPort: number,
  adminToken: string,
  options?: ServerClientOptions,
): Promise<ServerClient> {
  const pendingCalls = new Map<string, PendingCall>();
  const wsUrl = options?.wsUrl ?? `ws://127.0.0.1:${serverRpcPort}`;

  const ws = new WebSocket(wsUrl);

  // Wait for connection + auth
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
      // Send auth message
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

  // Main message handler
  ws.on("message", (data) => {
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

  // On disconnect, reject all pending calls and notify
  ws.on("close", () => {
    for (const [, pending] of pendingCalls) {
      pending.reject(new Error("Server disconnected"));
    }
    pendingCalls.clear();
    options?.onDisconnect?.();
  });

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

    async close(): Promise<void> {
      if (ws.readyState === WebSocket.CLOSED) return;
      ws.close(1000, "Client closing");
      await new Promise<void>((resolve) => {
        ws.on("close", () => resolve());
        // Don't wait forever
        setTimeout(resolve, 2000);
      });
    },
  };

  return client;
}
