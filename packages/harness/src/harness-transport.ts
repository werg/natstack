/**
 * WebSocket RPC transport for the harness side of the connection.
 *
 * Connects to the NatStack RPC server, authenticates with a provisioned token,
 * and provides a full {@link RpcTransport} implementation for the harness process.
 *
 * Follows the same auth envelope protocol as the worker runtime transport
 * (`workspace/packages/runtime/src/worker/transport.ts`):
 *
 * 1. Open WebSocket to `wsUrl`
 * 2. Send `{ type: "ws:auth", token }` on open
 * 3. Wait for `{ type: "ws:auth-result", success: true }` before sending RPC messages
 * 4. Wrap outgoing RPC in `{ type: "ws:rpc", message }` envelopes
 * 5. Unwrap incoming `ws:rpc` / `ws:event` / `ws:routed` envelopes into RpcMessages
 *
 * Unlike the worker transport, harnesses do NOT reconnect on disconnect. A
 * dropped connection is treated as a crash — the HarnessManager detects it
 * and handles respawn logic.
 *
 * @module
 */

import WebSocket from "ws";
import type { RpcMessage, RpcTransport, RpcEvent } from "@natstack/rpc";

type MessageHandler = (message: RpcMessage) => void;
type AnyMessageHandler = (sourceId: string, message: RpcMessage) => void;

export interface HarnessTransportResult {
  transport: RpcTransport;
  ws: WebSocket;
}

/**
 * Create a WebSocket-backed RPC transport for a harness process.
 *
 * Returns a promise that resolves after successful authentication.
 * Rejects if auth fails or the connection drops before auth completes.
 */
export function createHarnessTransport(
  wsUrl: string,
  authToken: string,
): Promise<HarnessTransportResult> {
  return new Promise((resolve, reject) => {
    const sourceHandlers = new Map<string, Set<MessageHandler>>();
    const anyHandlers = new Set<AnyMessageHandler>();
    // Phase 3D: Priority-aware split buffers — critical events never evicted
    const criticalBuffer: string[] = [];
    const streamBuffer: string[] = [];
    const MAX_STREAM_BUFFER = 2000;
    let authenticated = false;
    let settled = false;

    // Streaming delta types that can be dropped without data loss (final content is in completed message)
    const EVICTABLE_EVENT_TYPES = new Set([
      "text-delta", "thinking-delta", "action-update",
      "text-start", "text-end", "thinking-start", "thinking-end",
      "action-start", "action-end",
    ]);

    function isEvictable(msg: Record<string, unknown>): boolean {
      if (msg["type"] !== "ws:rpc") return false;
      const inner = msg["message"] as Record<string, unknown> | undefined;
      if (!inner || inner["type"] !== "request") return false;
      if (inner["method"] !== "harness.pushEvent") return false;
      const args = inner["args"] as unknown[] | undefined;
      if (!args || args.length < 2) return false;
      const event = args[1] as Record<string, unknown> | undefined;
      return event != null && EVICTABLE_EVENT_TYPES.has(event["type"] as string);
    }

    const ws = new WebSocket(wsUrl);

    const deliver = (fromId: string, message: RpcMessage) => {
      const handlers = sourceHandlers.get(fromId);
      if (handlers) {
        for (const handler of handlers) {
          try {
            handler(message);
          } catch (e) {
            console.error("[HarnessTransport] handler error:", e);
          }
        }
      }
      for (const handler of anyHandlers) {
        try {
          handler(fromId, message);
        } catch (e) {
          console.error("[HarnessTransport] handler error:", e);
        }
      }
    };

    const wsSend = (msg: object) => {
      const data = JSON.stringify(msg);
      if (ws.readyState === WebSocket.OPEN && authenticated) {
        ws.send(data);
        return;
      }
      if (isEvictable(msg as Record<string, unknown>)) {
        streamBuffer.push(data);
        if (streamBuffer.length > MAX_STREAM_BUFFER) streamBuffer.shift();
      } else {
        criticalBuffer.push(data);
      }
    };

    const flushOutgoing = () => {
      if (ws.readyState !== WebSocket.OPEN || !authenticated) return;
      // Flush critical first, then stream
      for (const data of criticalBuffer) ws.send(data);
      criticalBuffer.length = 0;
      for (const data of streamBuffer) ws.send(data);
      streamBuffer.length = 0;
    };

    const handleServerMessage = (msg: Record<string, unknown>): void => {
      switch (msg["type"]) {
        case "ws:auth-result": {
          if (msg["success"]) {
            authenticated = true;
            flushOutgoing();
            if (!settled) {
              settled = true;
              resolve({ transport, ws });
            }
          } else {
            const error = new Error(
              `Auth failed: ${(msg["error"] as string) ?? "unknown error"}`,
            );
            if (!settled) {
              settled = true;
              reject(error);
            }
          }
          break;
        }

        case "ws:rpc": {
          deliver("main", msg["message"] as RpcMessage);
          break;
        }

        case "ws:event": {
          deliver("main", {
            type: "event",
            fromId: "main",
            event: msg["event"] as string,
            payload: msg["payload"],
          } as RpcEvent);
          break;
        }

        case "ws:routed": {
          deliver(msg["fromId"] as string, msg["message"] as RpcMessage);
          break;
        }

        case "ws:routed-event-error": {
          deliver("main", {
            type: "event",
            fromId: "main",
            event: "runtime:routed-event-error",
            payload: {
              targetId: msg["targetId"],
              event: msg["event"],
              error: msg["error"],
              errorCode: msg["errorCode"],
            },
          } as RpcEvent);
          break;
        }

        case "ws:routed-response-error": {
          deliver("main", {
            type: "event",
            fromId: "main",
            event: "runtime:routed-response-error",
            payload: {
              targetId: msg["targetId"],
              requestId: msg["requestId"],
              error: msg["error"],
              errorCode: msg["errorCode"],
            },
          } as RpcEvent);
          break;
        }
      }
    };

    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "ws:auth", token: authToken }));
    });

    ws.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
      try {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        handleServerMessage(msg);
      } catch (e) {
        console.error("[HarnessTransport] Failed to parse message:", e);
      }
    });

    ws.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    ws.on("close", (code, reason) => {
      authenticated = false;
      if (!settled) {
        settled = true;
        reject(
          new Error(
            `WebSocket closed before auth (code=${code} reason=${reason.toString()})`,
          ),
        );
      }
      // No reconnect — HarnessManager detects the crash via process exit / bridge disconnect
    });

    const transport: RpcTransport = {
      async send(targetId: string, message: RpcMessage): Promise<void> {
        const normalized = targetId.startsWith("panel:")
          ? targetId.slice(6)
          : targetId;

        if (normalized === "main") {
          // Wrap as ws:rpc envelope
          wsSend({ type: "ws:rpc", message });
          return;
        }

        // Route to another caller via the server
        wsSend({ type: "ws:route", targetId: normalized, message });
      },

      onMessage(
        sourceId: string,
        handler: (message: RpcMessage) => void,
      ): () => void {
        let handlers = sourceHandlers.get(sourceId);
        if (!handlers) {
          handlers = new Set();
          sourceHandlers.set(sourceId, handlers);
        }
        handlers.add(handler);
        return () => {
          const h = sourceHandlers.get(sourceId);
          if (h) {
            h.delete(handler);
            if (h.size === 0) sourceHandlers.delete(sourceId);
          }
        };
      },

      onAnyMessage(handler: AnyMessageHandler): () => void {
        anyHandlers.add(handler);
        return () => {
          anyHandlers.delete(handler);
        };
      },
    };
  });
}
