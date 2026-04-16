/**
 * RPC WebSocket Server — handles all panel, shell, and worker communication.
 *
 * Replaces Electron IPC with a single WebSocket transport.
 * Auth is unified through TokenManager. Events use a Subscriber interface.
 */

import { WebSocketServer, WebSocket } from "ws";
import { createServer, type Server as HttpServer } from "http";
import { randomUUID } from "crypto";
import { createRpcBridge, type RpcBridge, type RpcEvent, type RpcMessage, type RpcRequest, type RpcResponse } from "@natstack/rpc";
import { createWsServerTransport, type WsServerTransportInternal } from "./wsServerTransport.js";
import type {
  WsClientMessage,
  WsServerMessage,
} from "../../packages/shared/src/ws/protocol.js";
import type { ToolExecutionResult } from "../../packages/shared/src/types.js";
import type { WsClientInfo } from "../../packages/shared/src/serviceDispatcher.js";
import { findServicePort } from "@natstack/port-utils";
import { createDevLogger } from "@natstack/dev-log";
import {
  parseServiceMethod,

  ServiceDispatcher,
  type CallerKind,
  type ServiceContext,
} from "../../packages/shared/src/serviceDispatcher.js";
import { checkServiceAccess } from "../../packages/shared/src/servicePolicy.js";
import type { TokenManager } from "../../packages/shared/src/tokenManager.js";
import { WsSubscriber, type EventService } from "../../packages/shared/src/eventsService.js";

const log = createDevLogger("RpcServer");

/**
 * Parse a "do:source:className:objectKey" target ID.
 * Source contains "/" but no ":", so the first ":" after a "/" delimits
 * source from className. ObjectKey may contain ":" (e.g., fork keys).
 */
function parseDOTarget(targetId: string): { source: string; className: string; objectKey: string } {
  const body = targetId.slice(3); // Remove "do:"
  const slashIdx = body.indexOf("/");
  if (slashIdx === -1) throw new Error(`Invalid DO target (no source slash): ${targetId}`);
  const colonAfterSlash = body.indexOf(":", slashIdx);
  if (colonAfterSlash === -1) throw new Error(`Invalid DO target (no className): ${targetId}`);
  const source = body.slice(0, colonAfterSlash);
  const rest = body.slice(colonAfterSlash + 1);
  const nextColon = rest.indexOf(":");
  if (nextColon === -1) throw new Error(`Invalid DO target (no objectKey): ${targetId}`);
  const className = rest.slice(0, nextColon);
  const objectKey = rest.slice(nextColon + 1);
  return { source, className, objectKey };
}

/** Server-side state for a connected WS client */
export interface WsClientState extends WsClientInfo {
  ws: WebSocket;
}

interface PendingToolCall {
  resolve: (result: ToolExecutionResult) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  clientWs: WebSocket;
}

type RelayAuthCheck = { ok: true } | { ok: false; reason: string };

type ReconnectOutcome =
  | { kind: "reconnected"; client: WsClientState }
  | { kind: "server-shutdown" }
  | { kind: "grace-expired" }
  | { kind: "no-waiter" };

type RelayErrorCode =
  | "RECONNECT_GRACE_EXPIRED"
  | "SERVER_SHUTTING_DOWN"
  | "TARGET_NOT_REACHABLE"
  | "UNKNOWN_TARGET_KIND";

function getErrorCode(error: unknown): string | undefined {
  return error instanceof Error
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

function createRelayError(message: string, code: RelayErrorCode): Error {
  return Object.assign(new Error(message), { code });
}

export class RpcServer {
  private wss: WebSocketServer | null = null;
  private httpServer: HttpServer | null = null;
  private port: number | null = null;
  /**
   * Loopback port bound for in-process back-channel HTTP POSTs (workerd →
   * server). In IPC/self-hosting mode this equals `port`. In standalone
   * mode it's a second, loopback-only listener so the workerd back-channel
   * doesn't have to route through the external TLS gateway — orthogonal
   * to whatever protocol the gateway speaks.
   */
  private loopbackHttpPort: number | null = null;
  private workerdUrl: string | null = null;

  // Connection tracking
  private clients = new Map<WebSocket, WsClientState>();
  private callerToClient = new Map<string, WsClientState>();
  private pendingToolCalls = new Map<string, PendingToolCall>();
  private disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private lastDisconnectAt = new Map<string, number>();
  /**
   * Promises that resolve when a caller (currently in the disconnect grace
   * window) reconnects, or reject when the grace timer expires. Lets relays
   * targeting a mid-reconnect client wait briefly instead of failing fast
   * with "Target not reachable" — see relayCall.
   */
  private reconnectWaiters = new Map<string, {
    promise: Promise<void>;
    resolve: () => void;
    reject: (err: Error) => void;
  }>();

  // Per-client RPC bridges for server→client calls
  private clientBridges = new Map<string, RpcBridge>();
  private clientTransports = new Map<string, WsServerTransportInternal>();

  // SCAFFOLD: 3-second reconnect grace window. This closes the relay race for
  // panels/shells that disconnect briefly and then reconnect, but it is not
  // considered steady-state architecture.
  //
  // Removal condition: reconnect instrumentation shows the observed churn is
  // either expected page-reload/network behavior or the root cause has been
  // fixed at the client/runtime layer. If reconnects are being caused by a
  // bug, fix that bug and delete this grace window.
  private static readonly DISCONNECT_GRACE_MS = 3000;

  private dispatcher: ServiceDispatcher;

  constructor(
    private deps: {
      tokenManager: TokenManager;
      dispatcher: ServiceDispatcher;
      /** Called when an authenticated client disconnects (e.g., for fs handle cleanup) */
      onClientDisconnect?: (callerId: string, callerKind: CallerKind) => void;
      /** Called when a client successfully authenticates */
      onClientAuthenticate?: (callerId: string, callerKind: CallerKind) => void;
      /**
       * Optional: the shared EventService. When provided, every authenticated
       * WS connection is registered as an event subscriber so
       * `eventService.emitTo(callerId, ...)` can deliver events to the caller
       * even before they've issued any explicit `events.subscribe` call.
       * Without this, emitTo returns false for admin-client and other
       * passive subscribers — which broke remote OAuth (the initiating
       * Electron client never called events.subscribe, so the login URL
       * had nowhere to go).
       */
      eventService?: EventService;
    }
  ) {
    this.dispatcher = deps.dispatcher;
  }

  /** Register a callback for client disconnect events. */
  setOnClientDisconnect(handler: (callerId: string, callerKind: CallerKind) => void): void {
    this.deps.onClientDisconnect = handler;
  }

  /** Register a callback for client authentication events. */
  setOnClientAuthenticate(handler: (callerId: string, callerKind: CallerKind) => void): void {
    this.deps.onClientAuthenticate = handler;
  }

  /** Set the base URL for the workerd process (for HTTP relay to workers/DOs). */
  setWorkerdUrl(url: string): void {
    this.workerdUrl = url;
  }

  /**
   * Initialize handlers without binding a socket.
   * Call this when the gateway owns the socket and dispatches to us.
   */
  initHandlers(): void {
    if (this.handlersInitialized) return;
    this.handlersInitialized = true;

    // WSS in noServer mode — gateway calls handleUpgrade then handleGatewayWsConnection
    this.wss = new WebSocketServer({ noServer: true });

    // Register revocation-driven disconnect
    this.deps.tokenManager.onRevoke((callerId) => {
      const client = this.callerToClient.get(callerId);
      if (!client) return;
      client.ws.close(4001, "Token revoked");
    });
  }
  private handlersInitialized = false;

  /**
   * Start with own socket (non-gateway mode, e.g. Electron local RPC).
   */
  async start(): Promise<number> {
    const port = await findServicePort("rpc");

    this.httpServer = createServer((req, res) => {
      this.handleHttpRequest(req, res).catch((err) => {
        console.error("[RpcServer] HTTP request handler error:", err);
        if (!res.headersSent) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Bad request" }));
        }
      });
    });
    // When self-hosting, WSS is attached to our own server
    this.wss = new WebSocketServer({ server: this.httpServer });
    this.wss.on("connection", (ws) => this.handleConnection(ws));
    this.handlersInitialized = true;

    // Register revocation-driven disconnect
    this.deps.tokenManager.onRevoke((callerId) => {
      const client = this.callerToClient.get(callerId);
      if (!client) return;
      client.ws.close(4001, "Token revoked");
    });

    await new Promise<void>((resolve, reject) => {
      this.httpServer!.once("error", reject);
      this.httpServer!.listen(port, "127.0.0.1", () => resolve());
    });

    this.port = port;
    this.loopbackHttpPort = port;
    return port;
  }

  /**
   * Bind a loopback-only HTTP listener for in-process back-channel POSTs
   * (workerd → server). Call this in gateway mode alongside `initHandlers()`:
   * the gateway handles panel WS upgrades, this listener handles internal
   * HTTP POST /rpc from workerd. Does NOT touch `this.port` — that stays
   * the panel-facing port set by `setPort(gatewayPort)`.
   */
  async startLoopbackHttp(): Promise<number> {
    this.initHandlers();
    if (this.httpServer) {
      throw new Error("RpcServer: loopback HTTP listener already bound");
    }
    const port = await findServicePort("rpc");
    this.httpServer = createServer((req, res) => {
      this.handleHttpRequest(req, res).catch((err) => {
        console.error("[RpcServer] HTTP request handler error:", err);
        if (!res.headersSent) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Bad request" }));
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.httpServer!.once("error", reject);
      this.httpServer!.listen(port, "127.0.0.1", () => resolve());
    });
    this.loopbackHttpPort = port;
    return port;
  }

  /** Set the port (used when gateway owns the socket). */
  setPort(port: number): void {
    this.port = port;
  }

  getPort(): number | null {
    return this.port;
  }

  /** Loopback HTTP port for in-process back-channel POSTs. Distinct from
   *  `getPort()` in standalone mode. */
  getLoopbackHttpPort(): number | null {
    return this.loopbackHttpPort;
  }

  private handleConnection(ws: WebSocket): void {
    // Expect first message to be ws:auth
    let authTimeout: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      ws.close(4003, "Auth timeout");
    }, 10000);

    const onFirstMessage = (data: Buffer | ArrayBuffer | Buffer[]) => {
      if (authTimeout) {
        clearTimeout(authTimeout);
        authTimeout = null;
      }
      ws.off("message", onFirstMessage);

      let msg: WsClientMessage;
      try {
        msg = JSON.parse(data.toString()) as WsClientMessage;
      } catch {
        ws.close(4004, "Invalid message");
        return;
      }

      if (msg.type !== "ws:auth") {
        ws.close(4005, "Expected ws:auth as first message");
        return;
      }

      this.handleAuth(ws, msg.token);
    };

    ws.on("message", onFirstMessage);
    ws.on("close", () => {
      if (authTimeout) {
        clearTimeout(authTimeout);
        authTimeout = null;
      }
    });
  }

  private handleAuth(ws: WebSocket, token: string): void {
    let callerId: string;
    let callerKind: CallerKind;

    // Priority: admin token > regular token (shell uses regular ensureToken path)
    if (this.deps.tokenManager.validateAdminToken(token)) {
      callerId = `ws:${randomUUID()}`;
      callerKind = "server";
    } else {
      const entry = this.deps.tokenManager.validateToken(token);
      if (!entry) {
        const msg: WsServerMessage = {
          type: "ws:auth-result",
          success: false,
          error: "Invalid token",
        };
        ws.send(JSON.stringify(msg));
        ws.close(4006, "Invalid token");
        return;
      }
      callerKind = entry.callerKind;
      // Shell callers get unique per-connection IDs (like admin/server callers)
      // so multiple mobile devices can connect simultaneously without
      // disconnecting each other.
      if (callerKind === "shell") {
        callerId = `${entry.callerId}:${randomUUID().slice(0, 8)}`;
      } else {
        callerId = entry.callerId;
      }
    }

    // Single-active-connection enforcement for non-admin callers
    if (callerKind !== "server") {
      // Cancel any pending disconnect timer (client reconnected within grace period)
      const pendingTimer = this.disconnectTimers.get(callerId);
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        this.disconnectTimers.delete(callerId);
      }

      // Wake up anyone waiting on this client's reconnect (relays in flight,
      // see relayCall). Must run BEFORE we install the new client into
      // callerToClient below, but the resolve()s only fire on the next tick,
      // so the waiters re-look-up after this whole block has completed.
      const waiter = this.reconnectWaiters.get(callerId);
      if (waiter) {
        this.reconnectWaiters.delete(callerId);
        waiter.resolve();
      }

      const existing = this.callerToClient.get(callerId);
      if (existing) {
        existing.ws.close(4002, "Replaced by new connection");
        this.cleanupClient(existing);
      }
    }

    const client: WsClientState = {
      ws,
      callerId,
      callerKind,
      authenticated: true,
    };

    this.clients.set(ws, client);
    this.callerToClient.set(callerId, client);

    if (callerKind === "panel") {
      const previousDisconnectAt = this.lastDisconnectAt.get(callerId);
      log.info("panel connected", {
        callerId,
        sinceLastDisconnectMs:
          previousDisconnectAt === undefined ? null : Date.now() - previousDisconnectAt,
      });
    }

    // Create per-client RPC bridge for server→client calls
    const transport = createWsServerTransport({ ws, clientId: callerId });
    const bridge = createRpcBridge({
      selfId: "server",
      transport,
    });
    this.clientTransports.set(callerId, transport);
    this.clientBridges.set(callerId, bridge);

    // Send auth result
    const authResult: WsServerMessage = {
      type: "ws:auth-result",
      success: true,
      callerId,
      callerKind,
    };
    ws.send(JSON.stringify(authResult));

    // Register the authenticated connection as an event subscriber so
    // `emitTo(callerId, ...)` can reach this client regardless of whether
    // they call `events.subscribe`. The subscriber's `onDestroyed` handler
    // (wired inside registerSubscriber) fires on ws.close and cleans itself
    // up, so we don't need to double-unregister on disconnect.
    if (this.deps.eventService) {
      try {
        const subscriber = new WsSubscriber(ws, callerKind);
        this.deps.eventService.registerSubscriber(callerId, subscriber);
      } catch (err) {
        log.warn(`Failed to register event subscriber for ${callerId}: ${(err as Error).message}`);
      }
    }

    // Notify auth callback (e.g., for HarnessManager bridge resolution)
    this.deps.onClientAuthenticate?.(callerId, callerKind);

    // Set up message handling
    ws.on("message", (data) => this.handleMessage(client, data));
    ws.on("close", (code, reason) => this.handleClose(client, code, reason.toString()));
  }

  private handleMessage(client: WsClientState, data: Buffer | ArrayBuffer | Buffer[]): void {
    let msg: WsClientMessage;
    try {
      msg = JSON.parse(data.toString()) as WsClientMessage;
    } catch (error) {
      log.warn("malformed ws frame", {
        callerId: client.callerId,
        callerKind: client.callerKind,
        cause: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    switch (msg.type) {
      case "ws:rpc":
        // If the message is a response or event, it may be for a server-initiated
        // call via the client's RPC bridge. Route it to the bridge transport.
        if (msg.message.type === "response" || msg.message.type === "event") {
          const transport = this.clientTransports.get(client.callerId);
          if (transport) {
            transport.deliver(client.callerId, msg.message);
            // For responses, we're done — don't also process as a new request.
            // For events, deliver to bridge and also fall through would be harmless,
            // but there's no server-side event handling for client events currently.
            return;
          }
        }
        void this.handleRpc(client, msg.message);
        break;
      case "ws:tool-result":
        this.handleToolResult(msg.callId, msg.result as ToolExecutionResult);
        break;
      case "ws:route":
      case "ws:panel-rpc":
        this.handleRoute(client, msg.targetId, msg.message);
        break;
      case "ws:auth":
        // Ignore duplicate auth messages
        break;
    }
  }

  private async handleRpc(client: WsClientState, message: RpcMessage): Promise<void> {
    if (message.type !== "request") return;

    const request = message as RpcRequest;
    const parsed = parseServiceMethod(request.method);

    if (!parsed) {
      this.sendToWs(client.ws, {
        type: "ws:rpc",
        message: {
          type: "response",
          requestId: request.requestId,
          error: `Invalid method format: "${request.method}". Expected "service.method"`,
        },
      });
      return;
    }

    const { service, method } = parsed;

    try {
      checkServiceAccess(service, client.callerKind, this.dispatcher, method);
    } catch (error) {
      this.sendToWs(client.ws, {
        type: "ws:rpc",
        message: {
          type: "response",
          requestId: request.requestId,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      return;
    }

    const ctx: ServiceContext = {
      callerId: client.callerId,
      callerKind: client.callerKind,
      wsClient: client,
    };

    const dispatcher = this.dispatcher;

    try {
      const result = await dispatcher.dispatch(ctx, service, method, request.args);
      this.sendToWs(client.ws, {
        type: "ws:rpc",
        message: { type: "response", requestId: request.requestId, result },
      });
    } catch (error) {
      const errorCode = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
      this.sendToWs(client.ws, {
        type: "ws:rpc",
        message: {
          type: "response",
          requestId: request.requestId,
          error: error instanceof Error ? error.message : String(error),
          ...(errorCode ? { errorCode } : {}),
        },
      });
    }
  }

  private handleToolResult(callId: string, result: ToolExecutionResult): void {
    const pending = this.pendingToolCalls.get(callId);
    if (!pending) return;

    clearTimeout(pending.timeout);
    this.pendingToolCalls.delete(callId);
    pending.resolve(result);
  }

  private handleRoute(client: WsClientState, targetId: string, message: RpcMessage): void {
    const auth = this.checkRelayAuth(client.callerId, client.callerKind, targetId);
    if (!auth.ok) {
      this.sendRouteError(client, targetId, message, new Error(auth.reason));
      return;
    }

    const targetClient = this.callerToClient.get(targetId);
    if (!targetClient || targetClient.ws.readyState !== WebSocket.OPEN) {
      // Target not connected via WS — try HTTP relay for workers/DOs, or wait
      // for a panel/shell client that's mid-reconnect (see relayCall).
      if (message.type === "request") {
        const { requestId, method: reqMethod, args: reqArgs } = message;
        void this.relayCall(client.callerId, targetId, reqMethod, reqArgs ?? []).then(
          (result) => {
            this.sendToWs(client.ws, {
              type: "ws:routed",
              fromId: targetId,
              message: { type: "response", requestId, result },
            });
          },
          (err) => {
            const errorCode = getErrorCode(err);
            this.sendToWs(client.ws, {
              type: "ws:routed",
              fromId: targetId,
              message: {
                type: "response",
                requestId,
                error: err instanceof Error ? err.message : String(err),
                ...(errorCode ? { errorCode } : {}),
              },
            });
          },
        );
      } else if (message.type === "response") {
        void this.relayResponse(client.callerId, targetId, message).catch((err) => {
          this.sendRouteError(client, targetId, message, err);
        });
      } else if (message.type === "event") {
        const { fromId: eventFromId, event, payload } = message;
        void this.relayEvent(eventFromId ?? client.callerId, targetId, event, payload).catch(
          (err) => {
            this.sendRouteError(client, targetId, message, err);
          },
        );
      }
      return;
    }

    this.sendToWs(targetClient.ws, {
      type: "ws:routed",
      fromId: client.callerId,
      message,
    });
  }

  /**
   * Convert a relay error into a routed response back to the caller.
   *
   * For request-typed messages, sends a `ws:routed` carrying a response with
   * `requestId` echoed back so the client's RPC bridge can reject the matching
   * promise. For response and event messages, surface the drop explicitly back
   * to the sender.
   */
  private sendRouteError(
    client: WsClientState,
    targetId: string,
    message: RpcMessage,
    err: unknown,
  ): void {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const errorCode = getErrorCode(err);
    if (message.type === "request") {
      this.sendToWs(client.ws, {
        type: "ws:routed",
        fromId: targetId,
        message: {
          type: "response",
          requestId: message.requestId,
          error: errorMessage,
          ...(errorCode ? { errorCode } : {}),
        },
      });
      return;
    }

    if (message.type === "response") {
      log.warn("relay response drop", {
        callerId: client.callerId,
        callerKind: client.callerKind,
        targetId,
        requestId: message.requestId,
        error: errorMessage,
        errorCode,
      });
      this.sendToWs(client.ws, {
        type: "ws:routed-response-error",
        targetId,
        requestId: message.requestId,
        error: errorMessage,
        ...(errorCode ? { errorCode } : {}),
      });
      return;
    }

    {
      const eventMessage = message as RpcEvent;
      log.warn("relay event drop", {
        callerId: client.callerId,
        callerKind: client.callerKind,
        targetId,
        event: eventMessage.event,
        fromId: eventMessage.fromId,
        error: errorMessage,
        errorCode,
      });
      this.sendToWs(client.ws, {
        type: "ws:routed-event-error",
        targetId,
        event: eventMessage.event,
        error: errorMessage,
        ...(errorCode ? { errorCode } : {}),
      });
    }
  }

  private handleClose(client: WsClientState, code?: number, reason?: string): void {
    // Only remove from callerToClient if this client is still the current one
    // (a replacement connection may have already overwritten it — code 4002)
    const current = this.callerToClient.get(client.callerId);
    const wasReplaced = current !== client;
    if (current === client) {
      this.callerToClient.delete(client.callerId);
    }
    this.clients.delete(client.ws);

    if (client.callerKind === "panel") {
      this.lastDisconnectAt.set(client.callerId, Date.now());
      log.info("panel disconnected", {
        callerId: client.callerId,
        code: code ?? null,
        reason: reason || null,
        initiator:
          code === 4001 ? "token-revoke"
            : code === 4002 ? "replaced"
              : code === 1005 || code === 1006 ? "network-or-reload"
                : "other",
      });
    }

    // Reject pending tool calls for this client
    for (const [callId, pending] of this.pendingToolCalls) {
      if (pending.clientWs === client.ws) {
        clearTimeout(pending.timeout);
        this.pendingToolCalls.delete(callId);
        pending.reject(new Error("Client disconnected"));
      }
    }

    // Clean up the old client's bridge transport (it's bound to the closed WebSocket).
    // If the client was replaced, cleanupClient already handles this; if not, do it now.
    if (!wasReplaced) {
      this.cleanupClientBridge(client.callerId);
    }

    // If this socket was replaced (code 4002), don't start cleanup timer —
    // the replacement is already connected.
    if (wasReplaced) return;

    // Grace-period cleanup: wait before firing disconnect callback.
    // Normal reloads/reconnects will cancel this timer.
    const existing = this.disconnectTimers.get(client.callerId);
    if (existing) clearTimeout(existing);

    // Set up a reconnect waiter so any in-flight relay targeting this client
    // can pause briefly instead of failing fast with "Target not reachable".
    // The waiter is resolved by handleAuth on reconnect or rejected when the
    // grace timer expires below.
    if (!this.reconnectWaiters.has(client.callerId)) {
      let resolveWaiter!: () => void;
      let rejectWaiter!: (err: Error) => void;
      const promise = new Promise<void>((res, rej) => { resolveWaiter = res; rejectWaiter = rej; });
      // Documented concurrent path: handleClose may reject the waiter before
      // relayCall/relayEvent actually attach their await, because the client
      // can fully miss the reconnect window with no in-flight relays. Known
      // grace/shutdown rejections are expected here; anything else is a bug.
      void promise.catch((error) => {
        const code = getErrorCode(error);
        if (code === "RECONNECT_GRACE_EXPIRED" || code === "SERVER_SHUTTING_DOWN") {
          return;
        }
        log.error("unexpected reconnect waiter rejection", {
          callerId: client.callerId,
          cause: error instanceof Error ? error.message : String(error),
          errorCode: code,
        });
      });
      this.reconnectWaiters.set(client.callerId, { promise, resolve: resolveWaiter, reject: rejectWaiter });
    }

    const timer = setTimeout(() => {
      this.disconnectTimers.delete(client.callerId);
      // Reject any reconnect waiter so blocked relays fall through to the
      // real "Target not reachable" path immediately.
      const waiter = this.reconnectWaiters.get(client.callerId);
      if (waiter) {
        this.reconnectWaiters.delete(client.callerId);
        waiter.reject(createRelayError(
          "Client did not reconnect within grace window",
          "RECONNECT_GRACE_EXPIRED",
        ));
      }
      // Only fire if the caller hasn't reconnected
      if (!this.callerToClient.has(client.callerId)) {
        this.deps.onClientDisconnect?.(client.callerId, client.callerKind);
      }
    }, RpcServer.DISCONNECT_GRACE_MS);

    this.disconnectTimers.set(client.callerId, timer);
  }

  private cleanupClient(client: WsClientState): void {
    const current = this.callerToClient.get(client.callerId);
    if (current === client) {
      this.callerToClient.delete(client.callerId);
    }
    this.clients.delete(client.ws);

    // Clean up the client's RPC bridge and transport
    this.cleanupClientBridge(client.callerId);
  }

  /** Close and remove the RPC bridge/transport for a client */
  private cleanupClientBridge(callerId: string): void {
    const transport = this.clientTransports.get(callerId);
    if (transport) {
      transport.close();
      this.clientTransports.delete(callerId);
    }
    this.clientBridges.delete(callerId);
  }

  // ===========================================================================
  // Public API for server-side pushes
  // ===========================================================================

  /**
   * Get the RPC bridge for a connected client.
   * Returns undefined if the client is not connected.
   *
   * The server can use this bridge to call methods exposed by the client:
   *   const bridge = rpcServer.getClientBridge(callerId);
   *   const result = await bridge.call(callerId, "someMethod", arg1, arg2);
   */
  getClientBridge(callerId: string): RpcBridge | undefined {
    return this.clientBridges.get(callerId);
  }

  /** Send a message to a specific caller by ID */
  sendToClient(callerId: string, msg: WsServerMessage): void {
    const client = this.callerToClient.get(callerId);
    if (!client || client.ws.readyState !== WebSocket.OPEN) return;
    this.sendToWs(client.ws, msg);
  }

  /** Get the WsClientState for a caller (for creating StreamTargets, etc.) */
  getClientState(callerId: string): WsClientState | undefined {
    return this.callerToClient.get(callerId);
  }

  /** Broadcast a message to control-plane clients (server and shell callers). */
  broadcastToControlPlane(msg: WsServerMessage): void {
    for (const client of this.callerToClient.values()) {
      if ((client.callerKind === "server" || client.callerKind === "shell") &&
          client.ws.readyState === WebSocket.OPEN) {
        this.sendToWs(client.ws, msg);
      }
    }
  }

  // ===========================================================================
  // HTTP POST /rpc endpoint
  // ===========================================================================

  private async handleHttpRequest(req: import("http").IncomingMessage, res: import("http").ServerResponse): Promise<void> {
    // Only handle POST /rpc
    if (req.method !== "POST" || req.url !== "/rpc") {
      res.writeHead(404);
      res.end();
      return;
    }

    // Read body (with size limit)
    const MAX_BODY_SIZE = 200 * 1024 * 1024; // 200MB
    const chunks: Buffer[] = [];
    let totalSize = 0;
    for await (const chunk of req) {
      totalSize += (chunk as Buffer).length;
      if (totalSize > MAX_BODY_SIZE) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Request body too large" }));
        return;
      }
      chunks.push(chunk as Buffer);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;

    // Auth: validate Bearer token
    const authHeader = req.headers["authorization"];
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing authorization" }));
      return;
    }

    let callerId: string;
    let callerKind: CallerKind;

    if (this.deps.tokenManager.validateAdminToken(token)) {
      callerId = "server";
      callerKind = "server";
    } else {
      const entry = this.deps.tokenManager.validateToken(token);
      if (!entry) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid token" }));
        return;
      }
      callerId = entry.callerId;
      callerKind = entry.callerKind;
    }

    try {
      const result = await this.handleHttpRpc(callerId, callerKind, body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ result }));
    } catch (err: any) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message, errorCode: err.code }));
    }
  }

  private async handleHttpRpc(
    callerId: string,
    callerKind: CallerKind,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    const type = body["type"] as string | undefined;
    const targetId = body["targetId"] as string | undefined;
    const method = body["method"] as string;
    const args = (body["args"] as unknown[]) ?? [];

    // Direct service dispatch (no type or targetId === "main")
    if (!type || targetId === "main") {
      const parsed = parseServiceMethod(method);
      if (!parsed) throw new Error(`Invalid method format: "${method}"`);

      checkServiceAccess(parsed.service, callerKind, this.dispatcher, parsed.method);

      const ctx: ServiceContext = { callerId, callerKind };
      return await this.dispatcher.dispatch(ctx, parsed.service, parsed.method, args);
    }

    // Relay call to another target
    if (type === "call") {
      if (!targetId) throw new Error("Missing targetId for relay call");
      const auth = this.checkRelayAuth(callerId, callerKind, targetId);
      if (!auth.ok) throw new Error(auth.reason);
      return await this.relayCall(callerId, targetId, method, args);
    }

    // Relay event to a target
    if (type === "emit") {
      const event = body["event"] as string;
      const payload = body["payload"];
      const fromId = (body["fromId"] as string) ?? callerId;
      if (!targetId) throw new Error("Missing targetId for emit");
      const auth = this.checkRelayAuth(callerId, callerKind, targetId);
      if (!auth.ok) throw new Error(auth.reason);
      await this.relayEvent(fromId, targetId, event, payload);
      return "ok";
    }

    throw new Error(`Unknown message type: ${type}`);
  }

  // ===========================================================================
  // Relay helpers (used by both HTTP POST /rpc and WS handleRoute)
  // ===========================================================================

  /**
   * Enforce authorization for relay calls/events.
   *
   * Shell-owned panel trees are not mirrored on the server anymore, so
   * relay authorization is now based only on caller authentication.
   */
  private checkRelayAuth(callerId: string, callerKind: CallerKind, targetId: string): RelayAuthCheck {
    if (callerKind !== "panel") return { ok: true };
    if (targetId === callerId) return { ok: true };
    if (targetId.startsWith("do:") || targetId.startsWith("worker:")) return { ok: true };

    const parentId = this.deps.tokenManager.getPanelParent(callerId);
    const targetParentId = this.deps.tokenManager.getPanelParent(targetId);
    const isDirectParent = parentId === targetId;
    const isDirectChild = targetParentId === callerId;
    const isRelated =
      isDirectParent ||
      isDirectChild ||
      this.deps.tokenManager.isPanelDescendantOf(callerId, targetId) ||
      this.deps.tokenManager.isPanelDescendantOf(targetId, callerId);

    if (!isRelated) {
      return { ok: false, reason: `Panel ${callerId} cannot relay to unrelated panel ${targetId}` };
    }

    return { ok: true };
  }

  private async awaitReconnectIfPending(targetId: string): Promise<ReconnectOutcome> {
    const waiter = this.reconnectWaiters.get(targetId);
    if (!waiter) return { kind: "no-waiter" };

    try {
      await waiter.promise;
    } catch (error) {
      const code = getErrorCode(error);
      if (code === "SERVER_SHUTTING_DOWN") return { kind: "server-shutdown" };
      if (code === "RECONNECT_GRACE_EXPIRED") return { kind: "grace-expired" };
      throw error;
    }

    const client = this.callerToClient.get(targetId);
    if (client?.ws.readyState === WebSocket.OPEN) {
      return { kind: "reconnected", client };
    }

    throw new Error(
      `Invariant violated: reconnect waiter resolved for ${targetId} but no client found`,
    );
  }

  private async relayCall(callerId: string, targetId: string, method: string, args: unknown[]): Promise<unknown> {
    const isPanelOrShellTarget = !targetId.startsWith("do:") && !targetId.startsWith("worker:");
    if (isPanelOrShellTarget) {
      const wsClient = this.callerToClient.get(targetId);
      if (wsClient?.ws.readyState === WebSocket.OPEN) {
        const bridge = this.clientBridges.get(targetId);
        if (bridge) {
          return await bridge.call(targetId, method, ...args);
        }
      }

      const outcome = await this.awaitReconnectIfPending(targetId);
      switch (outcome.kind) {
        case "reconnected": {
          const bridge = this.clientBridges.get(targetId);
          if (!bridge) {
            throw new Error(`Target ${targetId} reconnected but bridge missing`);
          }
          return await bridge.call(targetId, method, ...args);
        }
        case "server-shutdown":
          throw createRelayError("Server shutting down", "SERVER_SHUTTING_DOWN");
        case "grace-expired":
          throw createRelayError(
            `Target ${targetId} did not reconnect within grace window`,
            "RECONNECT_GRACE_EXPIRED",
          );
        case "no-waiter":
          throw createRelayError(`Target not reachable: ${targetId}`, "TARGET_NOT_REACHABLE");
      }
    }

    if (targetId.startsWith("do:")) {
      return await this.relayToDO(callerId, targetId, method, args);
    }

    if (targetId.startsWith("worker:")) {
      return await this.relayToWorker(targetId, method, args);
    }

    throw createRelayError(`Unknown target kind: ${targetId}`, "UNKNOWN_TARGET_KIND");
  }

  private async relayResponse(fromId: string, targetId: string, response: RpcResponse): Promise<void> {
    const client = await this.resolveWsRelayTarget(targetId);
    this.sendToWs(client.ws, {
      type: "ws:routed",
      fromId,
      message: response,
    });
  }

  private async relayToDO(callerId: string, targetId: string, method: string, args: unknown[]): Promise<unknown> {
    const ref = parseDOTarget(targetId);

    const { postToDOWithToken } = await import("./doDispatch.js");

    if (!this.deps.tokenManager || !this.workerdUrl) {
      throw new Error("Cannot relay to DO: tokenManager or workerdUrl not configured");
    }

    return await postToDOWithToken(ref, method, args, {
      tokenManager: this.deps.tokenManager,
      workerdUrl: this.workerdUrl,
    }, callerId);
  }

  private async relayToWorker(targetId: string, method: string, args: unknown[]): Promise<unknown> {
    // targetId format: "worker:{workerName}"
    const workerName = targetId.slice(7); // Remove "worker:"
    if (!this.workerdUrl) throw new Error("workerdUrl not configured");

    const url = `${this.workerdUrl}/${workerName}/__rpc`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "call", method, args }),
    });

    if (!res.ok) {
      let text: string;
      try {
        text = await res.text();
      } catch (error) {
        throw new Error(
          `Worker relay to ${targetId} failed (${res.status}) and response body could not be read: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      throw new Error(`Worker relay to ${targetId} failed (${res.status}): ${text}`);
    }

    const json = await res.json() as Record<string, unknown>;
    if (json["error"]) {
      const err = new Error(json["error"] as string);
      if (json["errorCode"]) (err as any).code = json["errorCode"];
      throw err;
    }
    return json["result"];
  }

  private async relayEvent(fromId: string, targetId: string, event: string, payload: unknown): Promise<void> {
    const isPanelOrShellTarget = !targetId.startsWith("do:") && !targetId.startsWith("worker:");
    if (isPanelOrShellTarget) {
      const wsClient = this.callerToClient.get(targetId);
      if (wsClient?.ws.readyState === WebSocket.OPEN) {
        this.sendToWs(wsClient.ws, {
          type: "ws:routed",
          fromId,
          message: { type: "event", fromId, event, payload },
        });
        return;
      }

      const outcome = await this.awaitReconnectIfPending(targetId);
      switch (outcome.kind) {
        case "reconnected":
          this.sendToWs(outcome.client.ws, {
            type: "ws:routed",
            fromId,
            message: { type: "event", fromId, event, payload },
          });
          return;
        case "server-shutdown":
          throw createRelayError("Server shutting down", "SERVER_SHUTTING_DOWN");
        case "grace-expired":
          throw createRelayError(
            `Target ${targetId} did not reconnect within grace window`,
            "RECONNECT_GRACE_EXPIRED",
          );
        case "no-waiter":
          throw createRelayError(`Target not reachable: ${targetId}`, "TARGET_NOT_REACHABLE");
      }
    }

    // DO?
    if (targetId.startsWith("do:")) {
      const ref = parseDOTarget(targetId);

      if (!this.deps.tokenManager || !this.workerdUrl) {
        throw new Error("Cannot relay event to DO: tokenManager or workerdUrl not configured");
      }

      const { postToDOWithToken } = await import("./doDispatch.js");
      // Don't pass fromId as callerId — callerId is for parent tracking,
      // fromId is the event source (already in the args).
      await postToDOWithToken(ref, "__event", [event, payload, fromId], {
        tokenManager: this.deps.tokenManager,
        workerdUrl: this.workerdUrl,
      });
      return;
    }

    // Worker?
    if (targetId.startsWith("worker:")) {
      const workerName = targetId.slice(7);
      if (!this.workerdUrl) throw new Error("workerdUrl not configured");

      const res = await fetch(`${this.workerdUrl}/${workerName}/__rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "emit", event, payload, fromId }),
      });
      if (!res.ok) {
        let text: string;
        try {
          text = await res.text();
        } catch (error) {
          throw new Error(
            `Event relay to ${targetId} failed (${res.status}) and response body could not be read: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        throw new Error(`Event relay to ${targetId} failed (${res.status}): ${text}`);
      }
      return;
    }

    throw createRelayError(`Unknown target kind: ${targetId}`, "UNKNOWN_TARGET_KIND");
  }

  private async resolveWsRelayTarget(targetId: string): Promise<WsClientState> {
    const wsClient = this.callerToClient.get(targetId);
    if (wsClient?.ws.readyState === WebSocket.OPEN) {
      return wsClient;
    }

    const outcome = await this.awaitReconnectIfPending(targetId);
    switch (outcome.kind) {
      case "reconnected":
        return outcome.client;
      case "server-shutdown":
        throw createRelayError("Server shutting down", "SERVER_SHUTTING_DOWN");
      case "grace-expired":
        throw createRelayError(
          `Target ${targetId} did not reconnect within grace window`,
          "RECONNECT_GRACE_EXPIRED",
        );
      case "no-waiter":
        throw createRelayError(`Target not reachable: ${targetId}`, "TARGET_NOT_REACHABLE");
    }
  }

  // ===========================================================================
  // Internal helpers
  // ===========================================================================

  private sendToWs(ws: WebSocket, msg: WsServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  // ===========================================================================
  // Gateway in-process handlers
  // ===========================================================================

  /** Accept a pre-upgraded WebSocket from the gateway (no WSS needed on our side). */
  handleGatewayWsConnection(ws: WebSocket): void {
    this.handleConnection(ws);
  }

  /** Handle an HTTP POST /rpc from the gateway (in-process dispatch). */
  async handleGatewayHttpRequest(req: import("http").IncomingMessage, res: import("http").ServerResponse): Promise<void> {
    await this.handleHttpRequest(req, res);
  }

  /** Shut down the server */
  async stop(): Promise<void> {
    // Close all client bridges and transports
    for (const [, transport] of this.clientTransports) {
      transport.close();
    }
    this.clientTransports.clear();
    this.clientBridges.clear();

    // Close all client connections
    for (const [ws] of this.clients) {
      ws.close(1001, "Server shutting down");
    }
    this.clients.clear();
    this.callerToClient.clear();

    // Clear pending tool calls
    for (const [, pending] of this.pendingToolCalls) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Server shutting down"));
    }
    this.pendingToolCalls.clear();

    // Clear disconnect timers
    for (const timer of this.disconnectTimers.values()) {
      clearTimeout(timer);
    }
    this.disconnectTimers.clear();

    // Reject any reconnect waiters so blocked relays unblock during shutdown.
    for (const waiter of this.reconnectWaiters.values()) {
      waiter.reject(createRelayError("Server shutting down", "SERVER_SHUTTING_DOWN"));
    }
    this.reconnectWaiters.clear();

    // Close WebSocket server
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    // Close HTTP server
    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => resolve());
      });
      this.httpServer = null;
    }

    this.port = null;
  }
}
