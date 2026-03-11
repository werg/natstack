/**
 * Server-side WebSocket transport for RPC bridges to connected clients.
 *
 * Implements the RpcTransport interface from @natstack/rpc, wrapping a
 * server-held WebSocket connection to a specific authenticated client.
 * The RpcServer creates one of these per client after authentication,
 * then wraps it in an RpcBridge so the server can call methods exposed
 * by the client.
 *
 * Message flow:
 * - send(): serializes RpcMessage into a ws:rpc envelope and calls ws.send()
 * - deliver(): called by RpcServer when an incoming message from the client
 *   is identified as an RPC response or event (to a server-initiated call)
 */

import type { WebSocket } from "ws";
import type { RpcMessage, RpcTransport } from "@natstack/rpc";
import { createHandlerRegistry } from "@natstack/rpc";

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
   * is a response/event for a server-initiated call.
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

  // Listen for WebSocket close to mark transport as closed
  const onClose = () => {
    closed = true;
  };
  ws.on("close", onClose);

  const transport: WsServerTransportInternal = {
    async send(_targetId: string, message: RpcMessage): Promise<void> {
      if (closed || ws.readyState !== ws.OPEN) {
        return;
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
      registry.deliver(sourceId, message);
    },

    close(): void {
      closed = true;
      ws.off("close", onClose);
    },
  };

  return transport;
}
