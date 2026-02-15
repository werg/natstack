/**
 * ServerClient — WebSocket admin client that connects Electron to the server.
 *
 * Handles RPC calls for Electron-internal operations (tokens, git, build,
 * ai.reinitialize, etc.). Panels connect directly to the server for AI
 * streaming, tool execution, and other backend services.
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

export async function createServerClient(
  serverRpcPort: number,
  adminToken: string
): Promise<ServerClient> {
  const pendingCalls = new Map<string, PendingCall>();

  const ws = new WebSocket(`ws://127.0.0.1:${serverRpcPort}`);

  // Wait for connection + auth
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Server WS connection timeout (10s)"));
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
    } catch {
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
    }
  });

  // On disconnect, reject all pending calls
  ws.on("close", () => {
    for (const [, pending] of pendingCalls) {
      pending.reject(new Error("Server disconnected"));
    }
    pendingCalls.clear();
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
