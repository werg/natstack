/**
 * ServerClient — WebSocket admin client that connects Electron to the server.
 *
 * Handles RPC proxying, AI stream bridging, and tool result forwarding.
 * Electron's RPC server uses this to delegate backend calls to the server process.
 */

import { WebSocket } from "ws";
import { randomUUID } from "crypto";
import type { RpcMessage, RpcResponse } from "@natstack/rpc";
import type {
  WsClientMessage,
  WsServerMessage,
} from "../shared/ws/protocol.js";
import type { ToolExecutionResult } from "./ai/claudeCodeToolProxy.js";

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

/** Active stream bridge: server stream → panel WS */
interface StreamBridge {
  panelWs: WebSocket;
  streamId: string;
}

export interface ServerClient {
  /** Call a backend service via the server */
  call(service: string, method: string, args: unknown[]): Promise<unknown>;
  /** Register a stream bridge: server stream chunks → panel WS */
  bridgeStream(streamId: string, panelWs: WebSocket): void;
  /** Forward a tool result from panel → server */
  forwardToolResult(callId: string, result: ToolExecutionResult): void;
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
  const activeStreams = new Map<string, StreamBridge>();

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

    switch (msg.type) {
      case "ws:rpc": {
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
        break;
      }

      // Stream bridging: forward from server → panel
      case "ws:stream-chunk":
      case "ws:stream-end": {
        const bridge = activeStreams.get(msg.streamId);
        if (bridge && bridge.panelWs.readyState === WebSocket.OPEN) {
          bridge.panelWs.send(JSON.stringify(msg));
        }
        if (msg.type === "ws:stream-end") {
          activeStreams.delete(msg.streamId);
        }
        break;
      }

      // Tool execution requests: forward from server → panel
      case "ws:tool-exec": {
        const bridge = activeStreams.get(msg.streamId);
        if (bridge && bridge.panelWs.readyState === WebSocket.OPEN) {
          bridge.panelWs.send(JSON.stringify(msg));
        }
        break;
      }
    }
  });

  // On disconnect, reject all pending calls and clean up streams
  ws.on("close", () => {
    for (const [, pending] of pendingCalls) {
      pending.reject(new Error("Server disconnected"));
    }
    pendingCalls.clear();

    // Send stream-end errors to active stream panels
    for (const [streamId, bridge] of activeStreams) {
      if (bridge.panelWs.readyState === WebSocket.OPEN) {
        bridge.panelWs.send(JSON.stringify({ type: "ws:stream-end", streamId }));
      }
    }
    activeStreams.clear();
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

    bridgeStream(streamId: string, panelWs: WebSocket): void {
      activeStreams.set(streamId, { panelWs, streamId });
    },

    forwardToolResult(callId: string, result: ToolExecutionResult): void {
      if (ws.readyState !== WebSocket.OPEN) return;
      const msg: WsClientMessage = { type: "ws:tool-result", callId, result };
      ws.send(JSON.stringify(msg));
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
