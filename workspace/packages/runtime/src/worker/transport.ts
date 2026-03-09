/**
 * WebSocket transport for workerd workers.
 *
 * Uses the WebSocket client API (natively supported in workerd) to connect
 * to the NatStack RPC server. Provides a full RpcTransport implementation.
 */

import type { RpcMessage, RpcTransport, RpcRequest, RpcResponse, RpcEvent } from "@natstack/rpc";

interface WsTransportConfig {
  wsUrl: string;
  authToken: string;
  workerId: string;
}

type MessageHandler = (message: RpcMessage) => void;
type AnyMessageHandler = (sourceId: string, message: RpcMessage) => void;

/**
 * Create an RpcTransport backed by a WebSocket connection to the NatStack RPC server.
 *
 * The transport handles:
 * - Authentication handshake (ws:auth)
 * - RPC request/response routing (ws:rpc)
 * - Streaming (ws:stream-chunk, ws:stream-end)
 * - Tool execution (ws:tool-exec / ws:tool-result)
 * - Events (ws:event)
 * - Message buffering during connection/auth
 */
export function createWorkerWsTransport(config: WsTransportConfig): RpcTransport {
  const sourceHandlers = new Map<string, Set<MessageHandler>>();
  const anyHandlers = new Set<AnyMessageHandler>();
  const outgoingBuffer: string[] = [];
  const pendingToolCallIds = new Set<string>();
  let ws: WebSocket | null = null;
  let authenticated = false;
  let reconnectAttempt = 0;

  const deliver = (fromId: string, message: RpcMessage) => {
    // Source-specific handlers
    const handlers = sourceHandlers.get(fromId);
    if (handlers) {
      for (const handler of handlers) {
        try { handler(message); } catch (e) { console.error("WS transport handler error:", e); }
      }
    }
    // Any-source handlers
    for (const handler of anyHandlers) {
      try { handler(fromId, message); } catch (e) { console.error("WS transport handler error:", e); }
    }
  };

  const wsSend = (msg: object) => {
    const data = JSON.stringify(msg);
    if (ws && ws.readyState === WebSocket.OPEN && authenticated) {
      ws.send(data);
    } else {
      outgoingBuffer.push(data);
      if (outgoingBuffer.length > 500) outgoingBuffer.shift();
    }
  };

  const flushOutgoing = () => {
    if (!ws || ws.readyState !== WebSocket.OPEN || !authenticated) return;
    for (const data of outgoingBuffer) {
      ws.send(data);
    }
    outgoingBuffer.length = 0;
  };

  const handleServerMessage = (msg: any): void => {
    switch (msg.type) {
      case "ws:auth-result": {
        if (msg.success) {
          authenticated = true;
          reconnectAttempt = 0;
          flushOutgoing();
        } else {
          console.error("[WorkerTransport] Auth failed:", msg.error);
        }
        break;
      }

      case "ws:rpc": {
        deliver("main", msg.message);
        break;
      }

      case "ws:stream-chunk": {
        deliver("main", {
          type: "event",
          fromId: "main",
          event: "ai:stream-text-chunk",
          payload: { streamId: msg.streamId, chunk: msg.chunk },
        } as RpcEvent);
        break;
      }

      case "ws:stream-end": {
        deliver("main", {
          type: "event",
          fromId: "main",
          event: "ai:stream-text-end",
          payload: { streamId: msg.streamId },
        } as RpcEvent);
        break;
      }

      case "ws:tool-exec": {
        pendingToolCallIds.add(msg.callId);
        deliver("main", {
          type: "request",
          requestId: msg.callId,
          fromId: "main",
          method: "ai.executeTool",
          args: [msg.streamId, msg.toolName, msg.args],
        } as RpcRequest);
        break;
      }

      case "ws:event": {
        deliver("main", {
          type: "event",
          fromId: "main",
          event: msg.event,
          payload: msg.payload,
        } as RpcEvent);
        break;
      }

      case "ws:routed": {
        deliver(msg.fromId, msg.message);
        break;
      }
    }
  };

  const connect = () => {
    ws = new WebSocket(config.wsUrl);

    ws.addEventListener("open", () => {
      ws!.send(JSON.stringify({ type: "ws:auth", token: config.authToken }));
    });

    ws.addEventListener("message", (event) => {
      try {
        const msg = JSON.parse(event.data as string);
        handleServerMessage(msg);
      } catch (e) {
        console.error("[WorkerTransport] Failed to parse message:", e);
      }
    });

    ws.addEventListener("close", (event) => {
      authenticated = false;
      // Terminal close codes — don't reconnect
      if (event.code === 4001 || event.code === 4005 || event.code === 4006) {
        deliver("main", {
          type: "event",
          fromId: "main",
          event: "runtime:connection-error",
          payload: { code: event.code, reason: event.reason || "Authentication failed" },
        } as RpcEvent);
        return;
      }
      const jitter = Math.random() * 500;
      const delay = Math.min(1000 * Math.pow(2, reconnectAttempt) + jitter, 10000);
      reconnectAttempt++;
      setTimeout(connect, delay);
    });

    ws.addEventListener("error", () => {
      // Close event handles reconnection
    });
  };

  // Start connection
  connect();

  const transport: RpcTransport = {
    async send(targetId: string, message: RpcMessage): Promise<void> {
      const normalized = targetId.startsWith("panel:") ? targetId.slice(6) : targetId;

      if (normalized === "main") {
        if (message.type === "request") {
          wsSend({ type: "ws:rpc", message });
          return;
        }

        if (message.type === "response") {
          const response = message as RpcResponse;
          if (pendingToolCallIds.has(response.requestId)) {
            pendingToolCallIds.delete(response.requestId);
            if ("error" in response) {
              wsSend({
                type: "ws:tool-result",
                callId: response.requestId,
                result: {
                  content: [{ type: "text", text: response.error }],
                  isError: true,
                },
              });
            } else {
              const result = response.result as { content?: unknown[]; isError?: boolean; data?: unknown } | null | undefined;
              if (!result || !Array.isArray(result.content)) {
                wsSend({
                  type: "ws:tool-result",
                  callId: response.requestId,
                  result: {
                    content: [{ type: "text", text: "Tool execution failed: no valid response" }],
                    isError: true,
                  },
                });
              } else {
                wsSend({
                  type: "ws:tool-result",
                  callId: response.requestId,
                  result: result as { content: Array<{ type: "text"; text: string }>; isError?: boolean },
                });
              }
            }
          } else {
            wsSend({ type: "ws:rpc", message });
          }
          return;
        }
        return;
      }

      // Route to another caller (worker, panel, etc.) via server
      wsSend({ type: "ws:route", targetId: normalized, message });
    },

    onMessage(sourceId: string, handler: (message: RpcMessage) => void): () => void {
      if (!sourceHandlers.has(sourceId)) {
        sourceHandlers.set(sourceId, new Set());
      }
      sourceHandlers.get(sourceId)!.add(handler);
      return () => {
        const handlers = sourceHandlers.get(sourceId);
        if (handlers) {
          handlers.delete(handler);
          if (handlers.size === 0) sourceHandlers.delete(sourceId);
        }
      };
    },

    onAnyMessage(handler: AnyMessageHandler): () => void {
      anyHandlers.add(handler);
      return () => { anyHandlers.delete(handler); };
    },
  };

  return transport;
}
