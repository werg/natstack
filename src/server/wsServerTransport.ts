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

import type { IncomingMessage } from "http";
import type { WebSocket } from "ws";
import type { RpcMessage, RpcTransport } from "@natstack/rpc";
import { createHandlerRegistry } from "@natstack/rpc";

// ---------------------------------------------------------------------------
// Origin allow-list for WebSocket upgrades (audit finding #30).
//
// The RPC WebSocket is bearer-authenticated, but bearer tokens for panels
// live in panel-page sessionStorage which is reachable by any panel-XSS or
// any web page that learns the loopback port. Adding an Origin allow-list
// at handshake means a malicious cross-site page cannot piggyback an
// existing token by issuing `new WebSocket("ws://127.0.0.1:port/rpc")` —
// the browser sends the page's Origin and the server rejects it before
// auth.
//
// Allow:
//   (a) requests with no Origin header (Node clients, Electron preload,
//       native CDP libraries),
//   (b) explicit "null" Origin (sandboxed iframes, about:blank panels),
//   (c) origins whose host matches the configured public host,
//   (d) loopback origins (localhost / 127.0.0.1 / ::1) for dev,
//   (e) anything in NATSTACK_WS_ALLOWED_ORIGINS (extension origins, etc.)
//
// Returns true to allow, false to reject.
// ---------------------------------------------------------------------------

export interface WsOriginAllowList {
  exact: Set<string>;
  suffix: Set<string>;
}

export function buildWsOriginAllowList(externalHost: string): WsOriginAllowList {
  const exact = new Set<string>();
  const suffix = new Set<string>();
  exact.add(`http://${externalHost}`);
  exact.add(`https://${externalHost}`);
  for (const h of ["localhost", "127.0.0.1", "[::1]"]) {
    exact.add(`http://${h}`);
    exact.add(`https://${h}`);
  }
  const extra = process.env["NATSTACK_WS_ALLOWED_ORIGINS"];
  if (extra) {
    for (const raw of extra.split(",")) {
      const v = raw.trim();
      if (v) exact.add(v);
    }
  }
  return { exact, suffix };
}

export function isWsOriginAllowed(
  origin: string | string[] | undefined,
  allowed: WsOriginAllowList,
): boolean {
  if (origin === undefined) return true;
  const value = Array.isArray(origin) ? origin[0] : origin;
  if (value === undefined || value === "") return true;
  if (value === "null") return true;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  const originBase = `${parsed.protocol}//${parsed.host}`;
  const originNoPort = `${parsed.protocol}//${parsed.hostname}`;
  if (allowed.exact.has(originBase)) return true;
  if (allowed.exact.has(originNoPort)) return true;
  for (const suffix of allowed.suffix) {
    if (parsed.hostname === suffix) return true;
    if (parsed.hostname.endsWith(`.${suffix}`)) return true;
  }
  return false;
}

/**
 * Convenience wrapper for a Node IncomingMessage. Returns true when the
 * Origin header is acceptable.
 *
 * TODO(security-audit-agent-3): rpcServer.ts creates two WebSocketServer
 * instances (`noServer: true` for the gateway path, `{ server }` for
 * standalone) — both must call this helper and reject on false. The fix
 * lives in `src/server/rpcServer.ts:186` and `:213`, which is outside the
 * file scope of this agent's transport-hardening pass.
 */
export function checkWsRequestOrigin(
  req: Pick<IncomingMessage, "headers">,
  allowed: WsOriginAllowList,
): boolean {
  return isWsOriginAllowed(req.headers["origin"], allowed);
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
