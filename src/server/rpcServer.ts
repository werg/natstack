/**
 * RPC WebSocket Server — handles all panel, shell, and worker communication.
 *
 * Replaces Electron IPC with a single WebSocket transport.
 * Auth is unified through TokenManager. Events use a Subscriber interface.
 */

import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "crypto";
import {
  createRpcBridge,
  type RpcBridge,
  type RpcMessage,
  type RpcRequest,
  type RpcResponse,
} from "@natstack/rpc";
import { createWsServerTransport, type WsServerTransportInternal } from "./wsServerTransport.js";
import type { WsClientMessage, WsServerMessage } from "@natstack/shared/ws/protocol";
import type { ToolExecutionResult } from "@natstack/shared/types";
import { createDevLogger } from "@natstack/dev-log";
import {
  parseServiceMethod,
  ServiceDispatcher,
  type CallerKind,
  type ServiceContext,
  type WsClientInfo,
} from "@natstack/shared/serviceDispatcher";
import { checkServiceAccess } from "@natstack/shared/servicePolicy";
import type { TokenManager } from "@natstack/shared/tokenManager";
import { WsEventSession, type EventService } from "@natstack/shared/eventsService";

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
  authenticatedAt: number;
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

class ConnectionRegistry {
  private clients = new Map<WebSocket, WsClientState>();
  private callerConnections = new Map<string, Map<string, WsClientState>>();
  private bridges = new Map<string, Map<string, RpcBridge>>();
  private transports = new Map<string, Map<string, WsServerTransportInternal>>();

  getBySocket(ws: WebSocket): WsClientState | undefined {
    return this.clients.get(ws);
  }

  getConnection(callerId: string, connectionId: string): WsClientState | undefined {
    const client = this.callerConnections.get(callerId)?.get(connectionId);
    return client?.ws.readyState === WebSocket.OPEN ? client : undefined;
  }

  isActiveClient(client: WsClientState): boolean {
    return this.callerConnections.get(client.callerId)?.get(client.connectionId) === client;
  }

  getCallerConnections(callerId: string): WsClientState[] {
    return [...(this.callerConnections.get(callerId)?.values() ?? [])].filter(
      (client) => client.ws.readyState === WebSocket.OPEN
    );
  }

  pickPrimary(callerId: string): WsClientState | undefined {
    return this.getCallerConnections(callerId).sort(
      (a, b) =>
        a.authenticatedAt - b.authenticatedAt || a.connectionId.localeCompare(b.connectionId)
    )[0];
  }

  addClient(client: WsClientState): void {
    this.clients.set(client.ws, client);
    let callerClients = this.callerConnections.get(client.callerId);
    if (!callerClients) {
      callerClients = new Map();
      this.callerConnections.set(client.callerId, callerClients);
    }
    callerClients.set(client.connectionId, client);
  }

  removeClient(client: WsClientState): boolean {
    const current = this.callerConnections.get(client.callerId)?.get(client.connectionId);
    const removedActive = current === client;
    if (removedActive) {
      const callerClients = this.callerConnections.get(client.callerId);
      callerClients?.delete(client.connectionId);
      if (callerClients?.size === 0) {
        this.callerConnections.delete(client.callerId);
      }
      this.removeBridge(client.callerId, client.connectionId);
    }
    this.clients.delete(client.ws);
    return removedActive;
  }

  setBridge(
    callerId: string,
    connectionId: string,
    bridge: RpcBridge,
    transport: WsServerTransportInternal
  ): void {
    let bridges = this.bridges.get(callerId);
    if (!bridges) {
      bridges = new Map();
      this.bridges.set(callerId, bridges);
    }
    bridges.set(connectionId, bridge);

    let transports = this.transports.get(callerId);
    if (!transports) {
      transports = new Map();
      this.transports.set(callerId, transports);
    }
    transports.set(connectionId, transport);
  }

  getBridge(callerId: string, connectionId: string): RpcBridge | undefined {
    return this.bridges.get(callerId)?.get(connectionId);
  }

  getPrimaryBridge(callerId: string): RpcBridge | undefined {
    const primary = this.pickPrimary(callerId);
    return primary ? this.getBridge(callerId, primary.connectionId) : undefined;
  }

  getTransport(callerId: string, connectionId: string): WsServerTransportInternal | undefined {
    return this.transports.get(callerId)?.get(connectionId);
  }

  removeBridge(callerId: string, connectionId: string): void {
    const transports = this.transports.get(callerId);
    const transport = transports?.get(connectionId);
    if (transport) {
      transport.close();
      transports?.delete(connectionId);
      if (transports?.size === 0) this.transports.delete(callerId);
    }

    const bridges = this.bridges.get(callerId);
    bridges?.delete(connectionId);
    if (bridges?.size === 0) this.bridges.delete(callerId);
  }

  forEachControlPlane(fn: (client: WsClientState) => void): void {
    for (const callerClients of this.callerConnections.values()) {
      for (const client of callerClients.values()) {
        if (
          (client.callerKind === "server" || client.callerKind === "shell") &&
          client.ws.readyState === WebSocket.OPEN
        ) {
          fn(client);
        }
      }
    }
  }

  closeAll(code: number, reason: string): void {
    for (const transports of this.transports.values()) {
      for (const transport of transports.values()) {
        transport.close();
      }
    }
    for (const ws of this.clients.keys()) {
      ws.close(code, reason);
    }
    this.clients.clear();
    this.callerConnections.clear();
    this.bridges.clear();
    this.transports.clear();
  }
}

function getErrorCode(error: unknown): string | undefined {
  return error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
}

function createRelayError(message: string, code: RelayErrorCode): Error {
  return Object.assign(new Error(message), { code });
}

export class RpcServer {
  private wss: WebSocketServer | null = null;
  private workerdUrl: string | null = null;
  private workerdGatewayToken: string | null = null;

  private connections = new ConnectionRegistry();
  private pendingToolCalls = new Map<string, PendingToolCall>();
  private disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private lastDisconnectAt = new Map<string, number>();
  /**
   * Promises that resolve when a caller (currently in the disconnect grace
   * window) reconnects, or reject when the grace timer expires. Lets relays
   * targeting a mid-reconnect client wait briefly instead of failing fast
   * with "Target not reachable" — see relayCall.
   */
  private reconnectWaiters = new Map<
    string,
    {
      promise: Promise<void>;
      resolve: () => void;
      reject: (err: Error) => void;
    }
  >();
  private connectionReconnectWaiters = new Map<
    string,
    {
      promise: Promise<void>;
      resolve: () => void;
      reject: (err: Error) => void;
    }
  >();
  private routedRequestOrigins = new Map<string, { callerId: string; connectionId: string }>();

  private readonly bootId = randomUUID();

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
       * WS connection is registered as an event session so
       * `eventService.emitToCaller(callerId, ...)` can deliver events to the
       * caller even before they've issued any explicit `events.subscribe` call.
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

  private connectionKey(callerId: string, connectionId: string): string {
    return `${callerId}:${connectionId}`;
  }

  private getCallerConnections(callerId: string): WsClientState[] {
    return this.connections.getCallerConnections(callerId);
  }

  private pickPrimary(callerId: string): WsClientState | undefined {
    return this.connections.pickPrimary(callerId);
  }

  private getConnection(callerId: string, connectionId: string): WsClientState | undefined {
    return this.connections.getConnection(callerId, connectionId);
  }

  private setBridge(
    callerId: string,
    connectionId: string,
    bridge: RpcBridge,
    transport: WsServerTransportInternal
  ): void {
    this.connections.setBridge(callerId, connectionId, bridge, transport);
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

  setWorkerdGatewayToken(token: string): void {
    this.workerdGatewayToken = token;
  }

  /**
   * Initialize handlers without binding a socket.
   * Call this when the gateway owns the socket and dispatches to us.
   */
  initHandlers(): void {
    if (this.handlersInitialized) return;
    this.handlersInitialized = true;

    // WSS in noServer mode — gateway calls handleUpgrade then
    // handleGatewayWsConnection. Origin allow-listing for this path is
    // enforced by the gateway's own upgrade handler (see gateway.ts).
    this.wss = new WebSocketServer({ noServer: true });

    // Register revocation-driven disconnect
    this.deps.tokenManager.onRevoke((callerId) => {
      for (const client of this.getCallerConnections(callerId)) {
        client.ws.close(4001, "Token revoked");
      }
    });
  }
  private handlersInitialized = false;

  private attachConnection(
    ws: WebSocket,
    caller: { callerId: string; callerKind: CallerKind },
    requestedConnectionId?: string
  ): void {
    const callerKind = caller.callerKind;
    const callerId = caller.callerId;
    const connectionId = requestedConnectionId || randomUUID();
    const connectionKey = this.connectionKey(callerId, connectionId);

    // Cancel pending disconnect cleanup for this specific connection.
    const pendingTimer = this.disconnectTimers.get(connectionKey);
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      this.disconnectTimers.delete(connectionKey);
    }

    // Wake up caller-level relays waiting for any connection and response
    // steering waiters waiting for this exact connection.
    const callerWaiter = this.reconnectWaiters.get(callerId);
    if (callerWaiter) {
      this.reconnectWaiters.delete(callerId);
      callerWaiter.resolve();
    }
    const connectionWaiter = this.connectionReconnectWaiters.get(connectionKey);
    if (connectionWaiter) {
      this.connectionReconnectWaiters.delete(connectionKey);
      connectionWaiter.resolve();
    }

    const existing = this.connections.getConnection(callerId, connectionId);
    if (existing) {
      existing.ws.close(4002, "Replaced by new connection");
      this.cleanupClient(existing);
    }

    const client: WsClientState = {
      ws,
      callerId,
      connectionId,
      callerKind,
      authenticated: true,
      authenticatedAt: Date.now(),
    };

    this.connections.addClient(client);

    if (callerKind === "panel") {
      const previousDisconnectAt = this.lastDisconnectAt.get(callerId);
      log.info("panel connected", {
        callerId,
        sinceLastDisconnectMs:
          previousDisconnectAt === undefined ? null : Date.now() - previousDisconnectAt,
      });
    }

    // Create per-client RPC bridge for server→client calls
    const transport = createWsServerTransport({ ws, clientId: `${callerId}:${connectionId}` });
    const bridge = createRpcBridge({
      selfId: "server",
      transport,
    });
    this.setBridge(callerId, connectionId, bridge, transport);

    const ready: WsServerMessage = {
      type: "ws:ready",
      callerId,
      callerKind,
      connectionId,
      serverBootId: this.bootId,
    };
    ws.send(JSON.stringify(ready));

    // Register the authenticated connection as a direct-address event session.
    // Pub/sub subscriptions still opt in per event; direct delivery can target
    // either this one connection or all live connections for the caller.
    if (this.deps.eventService) {
      try {
        this.deps.eventService.registerSession(
          new WsEventSession(ws, callerKind, callerId, connectionId)
        );
      } catch (err) {
        log.warn(`Failed to register event session for ${callerId}: ${(err as Error).message}`);
      }
    }

    // Notify auth callback (e.g., for HarnessManager bridge resolution)
    this.deps.onClientAuthenticate?.(callerId, callerKind);

    // Set up message handling
    ws.on("message", (data) => this.handleMessage(client, data));
    ws.on("close", (code, reason) => this.handleClose(client, code, reason.toString()));
  }

  private handleMessage(client: WsClientState, data: Buffer | ArrayBuffer | Buffer[]): void {
    if (!this.connections.isActiveClient(client)) return;

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
          const transport = this.connections.getTransport(client.callerId, client.connectionId);
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
        this.handleRoute(client, msg.targetId, msg.message, msg.targetConnectionId);
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
      connectionId: client.connectionId,
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

  private handleRoute(
    client: WsClientState,
    targetId: string,
    message: RpcMessage,
    targetConnectionId?: string
  ): void {
    const auth = this.checkRelayAuth(client.callerId, client.callerKind, targetId);
    if (!auth.ok) {
      this.sendRouteError(client, targetId, message, new Error(auth.reason));
      return;
    }

    if (message.type === "response") {
      const origin = this.routedRequestOrigins.get(message.requestId);
      if (origin && origin.callerId === targetId) {
        this.routedRequestOrigins.delete(message.requestId);
        void this.resolveWsRelayTarget(origin.callerId, origin.connectionId).then(
          (originClient) => {
            this.sendToWs(originClient.ws, {
              type: "ws:routed",
              sourceId: client.callerId,
              message,
            });
          },
          (err) => this.sendRouteError(client, targetId, message, err)
        );
        return;
      }
    }

    const targetClient = targetConnectionId
      ? this.getConnection(targetId, targetConnectionId)
      : this.pickPrimary(targetId);
    if (!targetClient || targetClient.ws.readyState !== WebSocket.OPEN) {
      // Target not connected via WS — try HTTP relay for workers/DOs, or wait
      // for a panel/shell client that's mid-reconnect (see relayCall).
      if (message.type === "request") {
        const { requestId, method: reqMethod, args: reqArgs } = message;
        this.recordRoutedRequestOrigin(requestId, client);
        void this.relayCall(
          client.callerId,
          targetId,
          reqMethod,
          reqArgs ?? [],
          targetConnectionId
        ).then(
          (result) => {
            void this.sendRoutedResponseToOrigin(client, targetId, {
              type: "response",
              requestId,
              result,
            }).catch((sendErr) => this.sendRouteError(client, targetId, message, sendErr));
          },
          (err) => {
            const errorCode = getErrorCode(err);
            void this.sendRoutedResponseToOrigin(client, targetId, {
              type: "response",
              requestId,
              error: err instanceof Error ? err.message : String(err),
              ...(errorCode ? { errorCode } : {}),
            }).catch((sendErr) => this.sendRouteError(client, targetId, message, sendErr));
          }
        );
      } else if (message.type === "response") {
        void this.relayResponse(client.callerId, targetId, message).catch((err) => {
          this.sendRouteError(client, targetId, message, err);
        });
      } else if (message.type === "event") {
        const { event, payload } = message;
        void this.relayEvent(client.callerId, targetId, event, payload).catch((err) => {
          this.sendRouteError(client, targetId, message, err);
        });
      }
      return;
    }

    const outboundMessage = message;
    if (outboundMessage.type === "request") {
      this.recordRoutedRequestOrigin(outboundMessage.requestId, client);
    }

    if (outboundMessage.type === "event" && !targetConnectionId) {
      for (const connection of this.getCallerConnections(targetId)) {
        this.sendToWs(connection.ws, {
          type: "ws:routed",
          sourceId: client.callerId,
          message: outboundMessage,
        });
      }
      return;
    }

    this.sendToWs(targetClient.ws, {
      type: "ws:routed",
      sourceId: client.callerId,
      message: outboundMessage,
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
    err: unknown
  ): void {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const errorCode = getErrorCode(err);
    if (message.type === "request") {
      this.sendToWs(client.ws, {
        type: "ws:routed",
        sourceId: targetId,
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
      log.warn("relay event drop", {
        callerId: client.callerId,
        callerKind: client.callerKind,
        targetId,
        event: message.event,
        error: errorMessage,
        errorCode,
      });
      this.sendToWs(client.ws, {
        type: "ws:routed-event-error",
        targetId,
        event: message.event,
        error: errorMessage,
        ...(errorCode ? { errorCode } : {}),
      });
    }
  }

  private recordRoutedRequestOrigin(requestId: string, client: WsClientState): void {
    this.routedRequestOrigins.set(requestId, {
      callerId: client.callerId,
      connectionId: client.connectionId,
    });

    // Bound memory if a responder never replies. Drop oldest entries first.
    const maxEntries = 10_000;
    while (this.routedRequestOrigins.size > maxEntries) {
      const oldest = this.routedRequestOrigins.keys().next().value as string | undefined;
      if (!oldest) break;
      this.routedRequestOrigins.delete(oldest);
    }
  }

  private async sendRoutedResponseToOrigin(
    origin: WsClientState,
    sourceId: string,
    message: RpcResponse
  ): Promise<void> {
    const originClient = await this.resolveWsRelayTarget(origin.callerId, origin.connectionId);
    this.sendToWs(originClient.ws, {
      type: "ws:routed",
      sourceId,
      message,
    });
  }

  private handleClose(client: WsClientState, code?: number, reason?: string): void {
    const connectionKey = this.connectionKey(client.callerId, client.connectionId);
    const wasReplaced =
      this.connections.getConnection(client.callerId, client.connectionId) !== client;
    this.connections.removeClient(client);

    if (client.callerKind === "panel") {
      this.lastDisconnectAt.set(client.callerId, Date.now());
      log.info("panel disconnected", {
        callerId: client.callerId,
        code: code ?? null,
        reason: reason || null,
        initiator:
          code === 4001
            ? "token-revoke"
            : code === 4002
              ? "replaced"
              : code === 1005 || code === 1006
                ? "network-or-reload"
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

    // If this socket was replaced (code 4002), don't start cleanup timer —
    // the replacement is already connected.
    if (wasReplaced) return;

    if (!this.connectionReconnectWaiters.has(connectionKey)) {
      let resolveWaiter!: () => void;
      let rejectWaiter!: (err: Error) => void;
      const promise = new Promise<void>((res, rej) => {
        resolveWaiter = res;
        rejectWaiter = rej;
      });
      void promise.catch((error) => {
        const code = getErrorCode(error);
        if (code === "RECONNECT_GRACE_EXPIRED" || code === "SERVER_SHUTTING_DOWN") {
          return;
        }
        log.error("unexpected connection reconnect waiter rejection", {
          callerId: client.callerId,
          connectionId: client.connectionId,
          cause: error instanceof Error ? error.message : String(error),
          errorCode: code,
        });
      });
      this.connectionReconnectWaiters.set(connectionKey, {
        promise,
        resolve: resolveWaiter,
        reject: rejectWaiter,
      });
    }

    const callerHasOtherConnections = this.getCallerConnections(client.callerId).length > 0;

    // Grace-period cleanup: wait before firing disconnect callback.
    // Normal reloads/reconnects will cancel this timer.
    const existing = this.disconnectTimers.get(connectionKey);
    if (existing) clearTimeout(existing);

    // Set up a reconnect waiter so any in-flight relay targeting this client
    // can pause briefly instead of failing fast with "Target not reachable".
    // The waiter is resolved by handleAuth on reconnect or rejected when the
    // grace timer expires below.
    if (!callerHasOtherConnections && !this.reconnectWaiters.has(client.callerId)) {
      let resolveWaiter!: () => void;
      let rejectWaiter!: (err: Error) => void;
      const promise = new Promise<void>((res, rej) => {
        resolveWaiter = res;
        rejectWaiter = rej;
      });
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
      this.reconnectWaiters.set(client.callerId, {
        promise,
        resolve: resolveWaiter,
        reject: rejectWaiter,
      });
    }

    const timer = setTimeout(() => {
      this.disconnectTimers.delete(connectionKey);
      // Reject any reconnect waiter so blocked relays fall through to the
      // real "Target not reachable" path immediately.
      const waiter = this.reconnectWaiters.get(client.callerId);
      if (waiter) {
        this.reconnectWaiters.delete(client.callerId);
        waiter.reject(
          createRelayError(
            "Client did not reconnect within grace window",
            "RECONNECT_GRACE_EXPIRED"
          )
        );
      }
      // Only fire if the caller hasn't reconnected
      const connectionWaiter = this.connectionReconnectWaiters.get(connectionKey);
      if (connectionWaiter) {
        this.connectionReconnectWaiters.delete(connectionKey);
        connectionWaiter.reject(
          createRelayError(
            "Client did not reconnect within grace window",
            "RECONNECT_GRACE_EXPIRED"
          )
        );
      }
      this.cleanupRoutedOriginsForConnection(client.callerId, client.connectionId);
      // Only fire if the caller hasn't reconnected
      if (this.getCallerConnections(client.callerId).length === 0) {
        this.deps.onClientDisconnect?.(client.callerId, client.callerKind);
      }
    }, RpcServer.DISCONNECT_GRACE_MS);

    this.disconnectTimers.set(connectionKey, timer);
  }

  private cleanupClient(client: WsClientState): void {
    this.connections.removeClient(client);
  }

  private cleanupRoutedOriginsForConnection(callerId: string, connectionId: string): void {
    for (const [requestId, origin] of this.routedRequestOrigins) {
      if (origin.callerId === callerId && origin.connectionId === connectionId) {
        this.routedRequestOrigins.delete(requestId);
      }
    }
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
    return this.connections.getPrimaryBridge(callerId);
  }

  /** Send a message to a specific caller by ID */
  sendToClient(callerId: string, msg: WsServerMessage): void {
    for (const client of this.getCallerConnections(callerId)) {
      this.sendToWs(client.ws, msg);
    }
  }

  /** Get the WsClientState for a caller (for creating StreamTargets, etc.) */
  getClientState(callerId: string): WsClientState | undefined {
    return this.pickPrimary(callerId);
  }

  /** Broadcast a message to control-plane clients (server and shell callers). */
  broadcastToControlPlane(msg: WsServerMessage): void {
    this.connections.forEachControlPlane((client) => this.sendToWs(client.ws, msg));
  }

  // ===========================================================================
  // HTTP POST /rpc endpoint
  // ===========================================================================

  private async handleHttpRequest(
    req: import("http").IncomingMessage,
    res: import("http").ServerResponse
  ): Promise<void> {
    // Only handle POST /rpc
    if (req.method !== "POST" || req.url !== "/rpc") {
      res.writeHead(404);
      res.end();
      return;
    }

    // Read body. Intentionally uncapped here so RPC remains compatible with
    // existing large-payload developer workflows.
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON body" }));
      return;
    }

    const caller = req.natstackCaller;
    if (!caller) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing verified caller identity" }));
      return;
    }
    const callerId = caller.callerId;
    const callerKind = caller.callerKind;

    try {
      const result = await this.handleHttpRpc(callerId, callerKind, body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ result }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const errorCode = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: message, ...(errorCode ? { errorCode } : {}) }));
    }
  }

  private async handleHttpRpc(
    callerId: string,
    callerKind: CallerKind,
    body: Record<string, unknown>
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
      if (!targetId) throw new Error("Missing targetId for emit");
      const auth = this.checkRelayAuth(callerId, callerKind, targetId);
      if (!auth.ok) throw new Error(auth.reason);
      await this.relayEvent(callerId, targetId, event, payload);
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
  private checkRelayAuth(
    _callerId: string,
    callerKind: CallerKind,
    _targetId: string
  ): RelayAuthCheck {
    void callerKind;
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

    const client = this.pickPrimary(targetId);
    if (client?.ws.readyState === WebSocket.OPEN) {
      return { kind: "reconnected", client };
    }

    throw new Error(
      `Invariant violated: reconnect waiter resolved for ${targetId} but no client found`
    );
  }

  async callTarget<T = unknown>(targetId: string, method: string, ...args: unknown[]): Promise<T> {
    return this.relayCall("main", targetId, method, args) as Promise<T>;
  }

  private async relayCall(
    callerId: string,
    targetId: string,
    method: string,
    args: unknown[],
    targetConnectionId?: string
  ): Promise<unknown> {
    const isPanelOrShellTarget = !targetId.startsWith("do:") && !targetId.startsWith("worker:");
    if (isPanelOrShellTarget) {
      const wsClient = targetConnectionId
        ? this.getConnection(targetId, targetConnectionId)
        : this.pickPrimary(targetId);
      if (wsClient?.ws.readyState === WebSocket.OPEN) {
        const bridge = this.connections.getBridge(targetId, wsClient.connectionId);
        if (bridge) {
          return await bridge.call(targetId, method, ...args);
        }
      }

      if (targetConnectionId) {
        const reconnectedClient = await this.resolveWsRelayTarget(targetId, targetConnectionId);
        const bridge = this.connections.getBridge(targetId, reconnectedClient.connectionId);
        if (!bridge) {
          throw new Error(
            `Target ${targetId}:${targetConnectionId} reconnected but bridge missing`
          );
        }
        return await bridge.call(targetId, method, ...args);
      }

      const outcome = await this.awaitReconnectIfPending(targetId);
      switch (outcome.kind) {
        case "reconnected": {
          const bridge = this.connections.getBridge(targetId, outcome.client.connectionId);
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
            "RECONNECT_GRACE_EXPIRED"
          );
        case "no-waiter":
          throw createRelayError(`Target not reachable: ${targetId}`, "TARGET_NOT_REACHABLE");
      }
    }

    if (targetId.startsWith("do:")) {
      return await this.relayToDO(callerId, targetId, method, args);
    }

    if (targetId.startsWith("worker:")) {
      return await this.relayToWorker(callerId, targetId, method, args);
    }

    throw createRelayError(`Unknown target kind: ${targetId}`, "UNKNOWN_TARGET_KIND");
  }

  private async relayResponse(
    sourceId: string,
    targetId: string,
    response: RpcResponse
  ): Promise<void> {
    const client = await this.resolveWsRelayTarget(targetId);
    this.sendToWs(client.ws, {
      type: "ws:routed",
      sourceId,
      message: response,
    });
  }

  private async relayToDO(
    callerId: string,
    targetId: string,
    method: string,
    args: unknown[]
  ): Promise<unknown> {
    const ref = parseDOTarget(targetId);

    const { postRpcToDO } = await import("./doDispatch.js");

    if (!this.workerdUrl || !this.workerdGatewayToken) {
      throw new Error("Cannot relay to DO: workerdUrl or workerdGatewayToken not configured");
    }

    return await postRpcToDO(ref, { type: "call", method, args, sourceId: callerId }, {
      workerdUrl: this.workerdUrl,
      workerdGatewayToken: this.workerdGatewayToken,
    });
  }

  private async relayToWorker(
    callerId: string,
    targetId: string,
    method: string,
    args: unknown[]
  ): Promise<unknown> {
    // targetId format: "worker:{workerName}"
    const workerName = targetId.slice(7); // Remove "worker:"
    if (!this.workerdUrl) throw new Error("workerdUrl not configured");

    const url = `${this.workerdUrl}/${workerName}/__rpc`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.workerdGatewayToken
          ? { Authorization: `Bearer ${this.workerdGatewayToken}` }
          : {}),
      },
      body: JSON.stringify({ type: "call", method, args, sourceId: callerId }),
    });

    if (!res.ok) {
      let text: string;
      try {
        text = await res.text();
      } catch (error) {
        throw new Error(
          `Worker relay to ${targetId} failed (${res.status}) and response body could not be read: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
      throw new Error(`Worker relay to ${targetId} failed (${res.status}): ${text}`);
    }

    const json = (await res.json()) as Record<string, unknown>;
    if (json["error"]) {
      const err = new Error(json["error"] as string);
      if (json["errorCode"]) {
        (err as Error & { code?: unknown }).code = json["errorCode"];
      }
      throw err;
    }
    return json["result"];
  }

  private async relayEvent(
    sourceId: string,
    targetId: string,
    event: string,
    payload: unknown
  ): Promise<void> {
    const isPanelOrShellTarget = !targetId.startsWith("do:") && !targetId.startsWith("worker:");
    if (isPanelOrShellTarget) {
      const wsClients = this.getCallerConnections(targetId);
      if (wsClients.length > 0) {
        for (const wsClient of wsClients) {
          this.sendToWs(wsClient.ws, {
            type: "ws:routed",
            sourceId,
            message: { type: "event", event, payload },
          });
        }
        return;
      }

      const outcome = await this.awaitReconnectIfPending(targetId);
      switch (outcome.kind) {
        case "reconnected":
          for (const wsClient of this.getCallerConnections(targetId)) {
            this.sendToWs(wsClient.ws, {
              type: "ws:routed",
              sourceId,
              message: { type: "event", event, payload },
            });
          }
          return;
        case "server-shutdown":
          throw createRelayError("Server shutting down", "SERVER_SHUTTING_DOWN");
        case "grace-expired":
          throw createRelayError(
            `Target ${targetId} did not reconnect within grace window`,
            "RECONNECT_GRACE_EXPIRED"
          );
        case "no-waiter":
          throw createRelayError(`Target not reachable: ${targetId}`, "TARGET_NOT_REACHABLE");
      }
    }

    // DO?
    if (targetId.startsWith("do:")) {
      const ref = parseDOTarget(targetId);

      if (!this.workerdUrl || !this.workerdGatewayToken) {
        throw new Error("Cannot relay event to DO: workerdUrl or workerdGatewayToken not configured");
      }

      const { postRpcToDO } = await import("./doDispatch.js");
      await postRpcToDO(ref, { type: "emit", event, payload, sourceId }, {
        workerdUrl: this.workerdUrl,
        workerdGatewayToken: this.workerdGatewayToken,
      });
      return;
    }

    // Worker?
    if (targetId.startsWith("worker:")) {
      const workerName = targetId.slice(7);
      if (!this.workerdUrl) throw new Error("workerdUrl not configured");

      const res = await fetch(`${this.workerdUrl}/${workerName}/__rpc`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.workerdGatewayToken
            ? { Authorization: `Bearer ${this.workerdGatewayToken}` }
            : {}),
        },
        body: JSON.stringify({ type: "emit", event, payload, sourceId }),
      });
      if (!res.ok) {
        let text: string;
        try {
          text = await res.text();
        } catch (error) {
          throw new Error(
            `Event relay to ${targetId} failed (${res.status}) and response body could not be read: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
        throw new Error(`Event relay to ${targetId} failed (${res.status}): ${text}`);
      }
      return;
    }

    throw createRelayError(`Unknown target kind: ${targetId}`, "UNKNOWN_TARGET_KIND");
  }

  private async resolveWsRelayTarget(
    targetId: string,
    connectionId?: string
  ): Promise<WsClientState> {
    const wsClient = connectionId
      ? this.getConnection(targetId, connectionId)
      : this.pickPrimary(targetId);
    if (wsClient?.ws.readyState === WebSocket.OPEN) {
      return wsClient;
    }

    if (connectionId) {
      const connectionKey = this.connectionKey(targetId, connectionId);
      const waiter = this.connectionReconnectWaiters.get(connectionKey);
      if (!waiter) {
        throw createRelayError(`Target not reachable: ${targetId}`, "TARGET_NOT_REACHABLE");
      }
      try {
        await waiter.promise;
      } catch (error) {
        const code = getErrorCode(error);
        if (code === "SERVER_SHUTTING_DOWN") {
          throw createRelayError("Server shutting down", "SERVER_SHUTTING_DOWN");
        }
        if (code === "RECONNECT_GRACE_EXPIRED") {
          throw createRelayError(
            `Target ${targetId} did not reconnect within grace window`,
            "RECONNECT_GRACE_EXPIRED"
          );
        }
        throw error;
      }

      const reconnected = this.getConnection(targetId, connectionId);
      if (reconnected) return reconnected;
      throw new Error(
        `Invariant violated: reconnect waiter resolved for ${targetId}:${connectionId} but no client found`
      );
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
          "RECONNECT_GRACE_EXPIRED"
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
  handleGatewayWsConnection(
    ws: WebSocket,
    caller: { callerId: string; callerKind: CallerKind },
    connectionId?: string
  ): void {
    this.attachConnection(ws, caller, connectionId);
  }

  /** Handle an HTTP POST /rpc from the gateway (in-process dispatch). */
  async handleGatewayHttpRequest(
    req: import("http").IncomingMessage,
    res: import("http").ServerResponse
  ): Promise<void> {
    await this.handleHttpRequest(req, res);
  }

  /** Shut down the server */
  async stop(): Promise<void> {
    this.connections.closeAll(1001, "Server shutting down");

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
    for (const waiter of this.connectionReconnectWaiters.values()) {
      waiter.reject(createRelayError("Server shutting down", "SERVER_SHUTTING_DOWN"));
    }
    this.connectionReconnectWaiters.clear();
    this.routedRequestOrigins.clear();

    // Close WebSocket server
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
  }
}
