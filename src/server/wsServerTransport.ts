/**
 * Server-side WebSocket transport for RPC bridges to connected clients.
 *
 * Implements the RpcTransport interface from @natstack/rpc, wrapping a
 * server-held WebSocket connection to a specific authenticated client.
 * The RpcServer creates one of these per client after authentication,
 * then wraps it in an RpcClient so the server can call methods exposed
 * by the client.
 *
 * Message flow:
 * - send(): serializes RpcMessage into a ws:rpc envelope and calls ws.send()
 * - deliver(): called by RpcServer when an incoming message from the client
 *   is identified as a response, event, or stream frame for a server-initiated call
 */

import type { WebSocket } from "ws";
import type { RpcMessage, RpcTransport } from "@natstack/rpc";
import { createHandlerRegistry } from "@natstack/rpc";

/** Error code stamped on rejections caused by the underlying WS closing. */
export const CONNECTION_LOST_CODE = "CONNECTION_LOST";

function connectionLostError(clientId: string): Error {
  return Object.assign(
    new Error(`RPC bridge connection to ${clientId} was closed before a response arrived`),
    { code: CONNECTION_LOST_CODE }
  );
}

export interface WsServerTransportOptions {
  /** The server-side WebSocket for this client */
  ws: WebSocket;
  /** Identifier for this client (used in logging) */
  clientId: string;
}

export interface WsServerTransportInternal extends RpcTransport {
  /**
   * Deliver an incoming RPC message from the client to this transport's
   * handler registry. Called by RpcServer when it determines a message
   * belongs to a server-initiated call.
   */
  deliver(sourceId: string, message: RpcMessage): void;

  /**
   * Close the transport, removing the WebSocket close listener.
   */
  close(): void;
}

export function createWsServerTransport(
  options: WsServerTransportOptions
): WsServerTransportInternal {
  const { ws, clientId } = options;
  const registry = createHandlerRegistry({ context: `server→${clientId}` });

  let closed = false;
  // A3: outstanding server→client request ids. On close we synthesize a
  // rejecting response for each so the bridge's pending promise SETTLES instead
  // of hanging forever (the silent-drop class: a relayed call to a disconnecting
  // target would otherwise never resolve nor reject).
  const inFlightRequests = new Set<string>();

  // Synthesize a rejecting `response` for every still-pending server→client
  // request and feed it back through the registry so the bridge rejects.
  const failPendingRequests = (): void => {
    if (inFlightRequests.size === 0) return;
    const ids = [...inFlightRequests];
    inFlightRequests.clear();
    const err = connectionLostError(clientId);
    for (const requestId of ids) {
      registry.deliver(clientId, {
        type: "response",
        requestId,
        error: err.message,
        errorCode: CONNECTION_LOST_CODE,
      });
    }
  };

  // Listen for WebSocket close to mark transport as closed and settle pending.
  const onClose = () => {
    closed = true;
    failPendingRequests();
  };
  ws.on("close", onClose);

  const transport: WsServerTransportInternal = {
    async send(_targetId: string, message: RpcMessage): Promise<void> {
      if (closed || ws.readyState !== ws.OPEN) {
        // A3: throw rather than silently resolve — a swallowed send leaves the
        // caller's awaiter hanging forever. Throwing rejects the pending call.
        throw connectionLostError(clientId);
      }
      if (message.type === "request" || message.type === "stream-request") {
        inFlightRequests.add(message.requestId);
      }
      // Wrap the RpcMessage in the ws:rpc envelope the client expects
      ws.send(JSON.stringify({ type: "ws:rpc", message }));
    },

    onMessage(sourceId: string, handler: (message: RpcMessage) => void): () => void {
      return registry.onMessage(sourceId, handler);
    },

    onAnyMessage(handler: (sourceId: string, message: RpcMessage) => void): () => void {
      return registry.onAnyMessage(handler);
    },

    deliver(sourceId: string, message: RpcMessage): void {
      // A genuine response from the client retires the in-flight entry so we
      // don't double-settle it during a later close.
      if (message.type === "response") inFlightRequests.delete(message.requestId);
      registry.deliver(sourceId, message);
    },

    close(): void {
      closed = true;
      // A3: settle pending requests on explicit close (removeBridge path) too,
      // not only on the WS "close" event.
      failPendingRequests();
      ws.off("close", onClose);
    },
  };

  return transport;
}
