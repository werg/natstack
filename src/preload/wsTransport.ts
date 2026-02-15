/**
 * WebSocket transport bridge for preload scripts.
 *
 * Replaces the Electron IPC transport with a direct WebSocket connection
 * to the RPC server. Used by both panel/worker preloads and the shell preload.
 */

import type { RpcMessage, RpcRequest, RpcResponse, RpcEvent } from "@natstack/rpc";
import type { WsClientMessage, WsServerMessage } from "../shared/ws/protocol.js";

type AnyMessageHandler = (fromId: string, message: unknown) => void;

export type TransportBridge = {
  send: (targetId: string, message: unknown) => Promise<void>;
  onMessage: (handler: AnyMessageHandler) => () => void;
};

export interface WsTransportConfig {
  viewId: string;
  wsPort: number;
  authToken: string;
  callerKind: string;
}

const normalizeEndpointId = (targetId: string): string => {
  if (targetId.startsWith("panel:")) return targetId.slice(6);
  return targetId;
};

export function createWsTransport(config: WsTransportConfig): TransportBridge {
  const listeners = new Set<AnyMessageHandler>();
  const bufferedMessages: Array<{ fromId: string; message: RpcMessage }> = [];
  const outgoingBuffer: string[] = [];
  // Track pending tool call IDs so we only convert matching responses to ws:tool-result
  const pendingToolCallIds = new Set<string>();
  let transportReady = false;
  let flushScheduled = false;
  let ws: WebSocket | null = null;
  let authenticated = false;
  let reconnectAttempt = 0;

  const deliver = (fromId: string, message: RpcMessage) => {
    if (!transportReady) {
      bufferedMessages.push({ fromId, message });
      if (bufferedMessages.length > 500) bufferedMessages.shift();
      return;
    }
    for (const listener of listeners) {
      try {
        listener(fromId, message);
      } catch (error) {
        console.error("Error in WS transport message handler:", error);
      }
    }
  };

  const wsSend = (msg: WsClientMessage) => {
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

  /**
   * Translate ws:event panel:event messages into runtime:* events.
   * The runtime package listens for runtime:focus, runtime:theme, runtime:child-creation-error.
   */
  const translatePanelEvent = (payload: Record<string, unknown>): void => {
    if (payload["panelId"] !== config.viewId) return;

    if (payload["type"] === "focus") {
      deliver("main", { type: "event", fromId: "main", event: "runtime:focus", payload: null });
    } else if (payload["type"] === "theme") {
      deliver("main", { type: "event", fromId: "main", event: "runtime:theme", payload: payload["theme"] });
    } else if (payload["type"] === "child-creation-error") {
      deliver("main", {
        type: "event",
        fromId: "main",
        event: "runtime:child-creation-error",
        payload: { url: payload["url"], error: payload["error"] },
      });
    }
  };

  const handleServerMessage = (msg: WsServerMessage): void => {
    switch (msg.type) {
      case "ws:auth-result": {
        if (msg.success) {
          authenticated = true;
          reconnectAttempt = 0;
          flushOutgoing();
        } else {
          console.error("[WsTransport] Auth failed:", msg.error);
        }
        break;
      }

      case "ws:rpc": {
        // RPC response from server
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
        // Server requesting tool execution — deliver as a synthetic RPC request.
        // Track the callId so we can identify the response as a tool result.
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
        if (msg.event === "panel:event") {
          translatePanelEvent(msg.payload as Record<string, unknown>);
        } else {
          deliver("main", {
            type: "event",
            fromId: "main",
            event: msg.event,
            payload: msg.payload,
          } as RpcEvent);
        }
        break;
      }

      case "ws:panel-rpc-delivery": {
        deliver(msg.fromId, msg.message);
        break;
      }
    }
  };

  const connect = () => {
    ws = new WebSocket(`ws://127.0.0.1:${config.wsPort}`);

    ws.onopen = () => {
      // Send auth message immediately — callerKind determined server-side
      ws!.send(JSON.stringify({ type: "ws:auth", token: config.authToken }));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string) as WsServerMessage;
        handleServerMessage(msg);
      } catch (error) {
        console.error("[WsTransport] Failed to parse server message:", error);
      }
    };

    ws.onclose = (event) => {
      authenticated = false;
      // Terminal close codes — don't reconnect
      // 4001 = token revoked (panel closing), 4005 = bad handshake, 4006 = invalid token
      if (event.code === 4001 || event.code === 4005 || event.code === 4006) {
        if (event.code !== 4001) {
          // Auth failures on a live panel — surface to UI
          console.error(`[WsTransport] Terminal auth failure (${event.code}): ${event.reason}`);
          deliver("main", {
            type: "event",
            fromId: "main",
            event: "runtime:connection-error",
            payload: { code: event.code, reason: event.reason || "Authentication failed" },
          } as RpcEvent);
        }
        return;
      }
      const jitter = Math.random() * 500;
      const delay = Math.min(1000 * Math.pow(2, reconnectAttempt) + jitter, 10000);
      reconnectAttempt++;
      setTimeout(connect, delay);
    };

    ws.onerror = () => {
      // Error events are followed by close events, so reconnection is handled there
    };
  };

  // Start connection
  connect();

  const send: TransportBridge["send"] = async (targetId, message) => {
    const rpcMessage = message as RpcMessage;
    if (!rpcMessage || typeof rpcMessage !== "object" || typeof (rpcMessage as { type?: unknown }).type !== "string") {
      throw new Error("Invalid RPC message");
    }
    const normalized = normalizeEndpointId(targetId);

    if (normalized === "main") {
      if (rpcMessage.type === "request") {
        // RPC request to main process
        wsSend({ type: "ws:rpc", message: rpcMessage });
        return;
      }

      if (rpcMessage.type === "response") {
        const response = rpcMessage as RpcResponse;

        if (pendingToolCallIds.has(response.requestId)) {
          // Tool execution result — convert to ws:tool-result protocol message
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
                  content: [{ type: "text", text: "Tool execution failed: no valid response from panel" }],
                  isError: true,
                },
              });
            } else {
              wsSend({
                type: "ws:tool-result",
                callId: response.requestId,
                result: result as { content: Array<{ type: "text"; text: string }>; isError?: boolean; data?: unknown },
              });
            }
          }
        } else {
          // Regular RPC response (not a tool result)
          wsSend({ type: "ws:rpc", message: rpcMessage });
        }
        return;
      }

      // Events to main — not typically sent by clients
      return;
    }

    // Message to another panel
    wsSend({ type: "ws:panel-rpc", targetId: normalized, message: rpcMessage });
  };

  return {
    send,
    onMessage(handler) {
      listeners.add(handler);
      if (!flushScheduled) {
        flushScheduled = true;
        queueMicrotask(() => {
          transportReady = true;
          for (const buffered of bufferedMessages) {
            for (const listener of listeners) {
              try {
                listener(buffered.fromId, buffered.message);
              } catch (error) {
                console.error("Error delivering buffered WS transport message:", error);
              }
            }
          }
          bufferedMessages.length = 0;
        });
      }
      return () => listeners.delete(handler);
    },
  };
}
