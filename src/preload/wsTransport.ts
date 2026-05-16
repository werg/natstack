/**
 * WebSocket transport bridge for preload scripts.
 *
 * Replaces the Electron IPC transport with a direct WebSocket connection
 * to the RPC server. Used by both panel/worker preloads and the shell preload.
 */

import type { RpcMessage, RpcEvent } from "@natstack/rpc";
import type { WsClientMessage, WsServerMessage } from "@natstack/shared/ws/protocol";
import type { RecoveryKind } from "@natstack/shared/shell/recoveryCoordinator";

type AnyMessageHandler = (sourceId: string, message: unknown) => void;

export type TransportBridge = {
  send: (targetId: string, message: unknown) => Promise<void>;
  onMessage: (handler: AnyMessageHandler) => () => void;
  onRecovery: (kind: RecoveryKind, handler: () => void | Promise<void>) => () => void;
};

export interface WsTransportConfig {
  viewId: string;
  wsPort: number;
  callerKind: string;
  /** Override WebSocket URL. Default: ws://127.0.0.1:{wsPort} */
  wsUrl?: string;
}

const normalizeEndpointId = (targetId: string): string => {
  if (targetId.startsWith("panel:")) return targetId.slice(6);
  return targetId;
};

export function createWsTransport(config: WsTransportConfig): TransportBridge {
  const listeners = new Set<AnyMessageHandler>();
  const bufferedMessages: Array<{ sourceId: string; message: RpcMessage }> = [];
  const outgoingBuffer: string[] = [];
  let transportReady = false;
  let flushScheduled = false;
  let ws: WebSocket | null = null;
  let authenticated = false;
  let reconnectAttempt = 0;
  let hasConnectedBefore = false;
  let lastSeenBootId: string | null = null;
  let connectionGeneration = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const connectionId = makeConnectionId();
  const recoveryListeners = new Map<RecoveryKind, Set<() => void | Promise<void>>>();

  const deliver = (sourceId: string, message: RpcMessage) => {
    if (!transportReady) {
      bufferedMessages.push({ sourceId, message });
      if (bufferedMessages.length > 500) bufferedMessages.shift();
      return;
    }
    for (const listener of listeners) {
      try {
        listener(sourceId, message);
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
      deliver("main", { type: "event", event: "runtime:focus", payload: null });
    } else if (payload["type"] === "theme") {
      deliver("main", {
        type: "event",
        event: "runtime:theme",
        payload: payload["theme"],
      });
    } else if (payload["type"] === "child-created") {
      deliver("main", {
        type: "event",
        event: "runtime:child-created",
        payload: { childId: payload["childId"], url: payload["url"] },
      });
    } else if (payload["type"] === "child-creation-error") {
      deliver("main", {
        type: "event",
        event: "runtime:child-creation-error",
        payload: { url: payload["url"], error: payload["error"] },
      });
    }
  };

  const handleServerMessage = (msg: WsServerMessage): void => {
    switch (msg.type) {
      case "ws:ready": {
        authenticated = true;
        const previousBootId = lastSeenBootId;
        const nextBootId = msg.serverBootId ?? null;
        const isReconnect = hasConnectedBefore;
        hasConnectedBefore = true;
        lastSeenBootId = nextBootId;
        reconnectAttempt = 0;
        flushOutgoing();
        emitRecovery("resubscribe");
        if (isReconnect && previousBootId && nextBootId && previousBootId !== nextBootId) {
          emitRecovery("cold-recover");
        }
        break;
      }

      case "ws:rpc": {
        // RPC response from server
        deliver("main", msg.message);
        break;
      }

      case "ws:event": {
        if (msg.event === "panel:event") {
          translatePanelEvent(msg.payload as Record<string, unknown>);
        } else {
          deliver("main", {
            type: "event",
            event: msg.event,
            payload: msg.payload,
          } as RpcEvent);
        }
        break;
      }

      case "ws:routed": {
        deliver(msg.sourceId, msg.message);
        break;
      }

      case "ws:routed-event-error": {
        deliver("main", {
          type: "event",
          event: "runtime:routed-event-error",
          payload: {
            targetId: msg.targetId,
            event: msg.event,
            error: msg.error,
            errorCode: msg.errorCode,
          },
        } as RpcEvent);
        break;
      }

      case "ws:routed-response-error": {
        deliver("main", {
          type: "event",
          event: "runtime:routed-response-error",
          payload: {
            targetId: msg.targetId,
            requestId: msg.requestId,
            error: msg.error,
            errorCode: msg.errorCode,
          },
        } as RpcEvent);
        break;
      }
    }
  };

  const emitRecovery = (kind: RecoveryKind): void => {
    const listeners = recoveryListeners.get(kind);
    if (!listeners) return;
    for (const listener of listeners) {
      try {
        void listener();
      } catch (error) {
        console.error(`[WsTransport] Recovery listener failed for ${kind}:`, error);
      }
    }
  };

  const connect = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    const generation = ++connectionGeneration;
    const url = appendConnectionId(config.wsUrl ?? `ws://127.0.0.1:${config.wsPort}`, connectionId);
    const socket = new WebSocket(url);
    ws = socket;

    socket.onmessage = (event) => {
      if (generation !== connectionGeneration || ws !== socket) return;
      try {
        const msg = JSON.parse(event.data as string) as WsServerMessage;
        handleServerMessage(msg);
      } catch (error) {
        console.error("[WsTransport] Failed to parse server message:", error);
      }
    };

    socket.onclose = (event) => {
      if (generation !== connectionGeneration || ws !== socket) return;
      authenticated = false;
      // Terminal close code for intentional panel teardown.
      if (event.code === 4001 || event.code === 4005 || event.code === 4006) {
        if (event.code !== 4001) {
          // Auth failures on a live panel — surface to UI
          console.error(`[WsTransport] Terminal auth failure (${event.code}): ${event.reason}`);
          deliver("main", {
            type: "event",
            event: "runtime:connection-error",
            payload: { code: event.code, reason: event.reason || "Authentication failed" },
          } as RpcEvent);
        }
        return;
      }
      const jitter = Math.random() * 500;
      const delay = Math.min(1000 * Math.pow(2, reconnectAttempt) + jitter, 10000);
      reconnectAttempt++;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (generation !== connectionGeneration) return;
        connect();
      }, delay);
    };

    socket.onerror = () => {
      if (generation !== connectionGeneration || ws !== socket) return;
      // Error events are followed by close events, so reconnection is handled there
    };
  };

  // Start connection
  connect();

  const send: TransportBridge["send"] = async (targetId, message) => {
    const rpcMessage = message as RpcMessage;
    if (
      !rpcMessage ||
      typeof rpcMessage !== "object" ||
      typeof (rpcMessage as { type?: unknown }).type !== "string"
    ) {
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
        wsSend({ type: "ws:rpc", message: rpcMessage });
        return;
      }

      // Events to main — not typically sent by clients
      return;
    }

    // Message to another caller (panel, worker, etc.)
    wsSend({ type: "ws:route", targetId: normalized, message: rpcMessage });
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
                listener(buffered.sourceId, buffered.message);
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
    onRecovery(kind, handler) {
      let handlers = recoveryListeners.get(kind);
      if (!handlers) {
        handlers = new Set();
        recoveryListeners.set(kind, handlers);
      }
      handlers.add(handler);
      return () => {
        handlers?.delete(handler);
        if (handlers?.size === 0) recoveryListeners.delete(kind);
      };
    },
  };
}

function makeConnectionId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function appendConnectionId(wsUrl: string, connectionId: string): string {
  const url = new URL(wsUrl);
  url.searchParams.set("connectionId", connectionId);
  return url.toString();
}
