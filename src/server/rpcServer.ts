/**
 * RPC WebSocket Server — handles caller-scoped app, panel, worker, extension,
 * shell-host and server communication.
 *
 * Replaces Electron IPC with a single WebSocket transport.
 * Auth is unified through TokenManager. Events use a Subscriber interface.
 */

import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "crypto";
import type { ExtensionInvocation } from "@natstack/extension";
import {
  createRpcClient,
  envelopeFromMessage,
  responseEnvelopeFor,
  type EnvelopeRpcTransport,
  type RpcClient,
  type RpcEnvelope,
  type RpcEvent,
  type RpcMessage,
  type RpcRequest,
  type RpcResponse,
  type RpcStreamRequest,
} from "@natstack/rpc";
import { createWsServerTransport, type WsServerTransportInternal } from "./wsServerTransport.js";
import type { WsClientMessage, WsServerMessage } from "@natstack/shared/ws/protocol";
import type { ToolExecutionResult } from "@natstack/shared/types";
import { createDevLogger } from "@natstack/dev-log";
import {
  parseServiceMethod,
  createVerifiedCaller,
  isDeferredResult,
  ServiceDispatcher,
  type CallerKind,
  type ServiceContext,
  type WsClientInfo,
  type VerifiedCaller,
} from "@natstack/shared/serviceDispatcher";
import { DeferralRegistry } from "./services/deferralRegistry.js";
import { checkServiceAccess } from "@natstack/shared/servicePolicy";
import type { TokenManager } from "@natstack/shared/tokenManager";
import { WsEventSession, type EventService } from "@natstack/shared/eventsService";
import type { ConnectionGrantService } from "@natstack/shared/connectionGrants";
import type { EntityCache } from "@natstack/shared/runtime/entityCache";
import { callerKindForPrincipalKind } from "@natstack/shared/principalKinds";
import { resolveCodeIdentity } from "./services/principalIdentity.js";
import { SessionRegistry, type SessionRegistryOptions } from "./rpcServer/sessionRegistry.js";
import type { ClientPlatform } from "@natstack/shared/panel/panelLease";
import type { PanelRuntimeCoordinator } from "./panelRuntimeCoordinator.js";

const log = createDevLogger("RpcServer");
const RPC_RUNTIME_ID_HEADER = "x-natstack-runtime-id";
const ADMIN_RPC_AUTH_ERROR =
  "Admin token cannot authenticate RPC; use a caller-scoped token or connection grant.";

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

/** The server's identity stamped onto response envelopes it returns over /rpc. */
const SERVER_RESPONDER = { callerId: "main", callerKind: "server" as const };

function envelopeForWsDelivery(
  fromId: string,
  fromKind: CallerKind | "unknown",
  targetId: string,
  message: RpcMessage
): RpcEnvelope {
  return envelopeFromMessage({
    selfId: fromId,
    from: fromId,
    target: targetId,
    callerKind: fromKind,
    message,
  });
}

function envelopeTransportFromWsServer(transport: WsServerTransportInternal): EnvelopeRpcTransport {
  return {
    async send(envelope) {
      await transport.sendEnvelope(envelope);
    },
    onMessage(handler) {
      return transport.onAnyMessage((sourceId, message, callerKind) => {
        handler(
          envelopeFromMessage({
            selfId: "server",
            from: sourceId,
            target: "server",
            message,
            callerKind: callerKind ?? "unknown",
          })
        );
      });
    },
  };
}

/** Server-side state for a connected WS client */
export interface WsClientState extends WsClientInfo {
  ws: WebSocket;
  authenticatedAt: number;
  authorizedBy?: string;
  clientLabel?: string;
  clientSessionId?: string;
  clientPlatform?: ClientPlatform;
}

interface PendingToolCall {
  resolve: (result: ToolExecutionResult) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  clientWs: WebSocket;
}

type RelayAuthCheck = { ok: true } | { ok: false; reason: string };

type RelayCallMeta = {
  requestId?: string;
  idempotencyKey?: string;
  readOnly?: boolean;
};

function relayCallOptions(
  meta?: RelayCallMeta
): { idempotencyKey?: string; readOnly?: boolean } | undefined {
  if (!meta?.idempotencyKey && !meta?.readOnly) return undefined;
  return {
    ...(meta.idempotencyKey ? { idempotencyKey: meta.idempotencyKey } : {}),
    ...(meta.readOnly ? { readOnly: true } : {}),
  };
}

function relayMetaFromEnvelope(envelope?: RpcEnvelope): RelayCallMeta | undefined {
  if (!envelope) return undefined;
  const message = envelope.message;
  const requestId =
    message.type === "request" || message.type === "stream-request" ? message.requestId : undefined;
  const idempotencyKey = envelope.delivery.idempotencyKey;
  const readOnly = envelope.delivery.readOnly === true;
  if (!requestId && !idempotencyKey && !readOnly) return undefined;
  return {
    ...(requestId ? { requestId } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(readOnly ? { readOnly: true } : {}),
  };
}

type ReconnectOutcome =
  | { kind: "reconnected"; client: WsClientState }
  | { kind: "server-shutdown" }
  | { kind: "grace-expired" }
  | { kind: "no-waiter" };

type RelayErrorCode =
  | "RECONNECT_GRACE_EXPIRED"
  | "SERVER_SHUTTING_DOWN"
  | "DO_CONTEXT_MISMATCH"
  | "DO_NOT_CREATED"
  | "RPC_PROTOCOL_ERROR"
  | "TARGET_NOT_REACHABLE"
  | "UNKNOWN_TARGET_KIND";

class ConnectionRegistry {
  private clients = new Map<WebSocket, WsClientState>();
  private callerConnections = new Map<string, Map<string, WsClientState>>();
  private bridges = new Map<string, Map<string, RpcClient>>();
  private transports = new Map<string, Map<string, WsServerTransportInternal>>();

  getBySocket(ws: WebSocket): WsClientState | undefined {
    return this.clients.get(ws);
  }

  getConnection(callerId: string, connectionId: string): WsClientState | undefined {
    const client = this.callerConnections.get(callerId)?.get(connectionId);
    return client?.ws.readyState === WebSocket.OPEN ? client : undefined;
  }

  isActiveClient(client: WsClientState): boolean {
    return (
      this.callerConnections.get(client.caller.runtime.id)?.get(client.connectionId) === client
    );
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
    let callerClients = this.callerConnections.get(client.caller.runtime.id);
    if (!callerClients) {
      callerClients = new Map();
      this.callerConnections.set(client.caller.runtime.id, callerClients);
    }
    callerClients.set(client.connectionId, client);
  }

  removeClient(client: WsClientState): boolean {
    const current = this.callerConnections.get(client.caller.runtime.id)?.get(client.connectionId);
    const removedActive = current === client;
    if (removedActive) {
      const callerClients = this.callerConnections.get(client.caller.runtime.id);
      callerClients?.delete(client.connectionId);
      if (callerClients?.size === 0) {
        this.callerConnections.delete(client.caller.runtime.id);
      }
      this.removeBridge(client.caller.runtime.id, client.connectionId);
    }
    this.clients.delete(client.ws);
    return removedActive;
  }

  setBridge(
    callerId: string,
    connectionId: string,
    bridge: RpcClient,
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

  getBridge(callerId: string, connectionId: string): RpcClient | undefined {
    return this.bridges.get(callerId)?.get(connectionId);
  }

  getPrimaryBridge(callerId: string): RpcClient | undefined {
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

  closeConnection(callerId: string, connectionId: string, code: number, reason: string): void {
    this.callerConnections.get(callerId)?.get(connectionId)?.ws.close(code, reason);
  }

  forEachControlPlane(fn: (client: WsClientState) => void): void {
    for (const callerClients of this.callerConnections.values()) {
      for (const client of callerClients.values()) {
        if (
          (client.caller.runtime.kind === "server" || client.caller.runtime.kind === "shell") &&
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

const DEFAULT_RPC_MAX_BODY_BYTES = 256 * 1024 * 1024;

/** Max HTTP RPC body size; NATSTACK_RPC_MAX_BODY_BYTES overrides (0 = uncapped). */
function resolveRpcMaxBodyBytes(): number {
  const raw = process.env["NATSTACK_RPC_MAX_BODY_BYTES"];
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
  }
  return DEFAULT_RPC_MAX_BODY_BYTES;
}

function getErrorCode(error: unknown): string | undefined {
  return error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
}

function createRelayError(message: string, code: RelayErrorCode): Error {
  return Object.assign(new Error(message), { code });
}

function isRetryableDORelayError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("No such module") ||
    msg.includes("No such Durable Object") ||
    msg.includes("class not found") ||
    msg.includes("ECONNREFUSED") ||
    msg.includes("fetch failed") ||
    msg.includes("workerd not running")
  );
}

function isRuntimeIdForServiceToken(
  authenticatedCallerId: string,
  runtimeId: string | undefined
): boolean {
  if (!runtimeId || !authenticatedCallerId.startsWith("do-service:")) return false;
  const serviceTargetPrefix = `do:${authenticatedCallerId.slice("do-service:".length)}:`;
  return runtimeId.startsWith(serviceTargetPrefix);
}

function resolveHttpRuntimeCaller(
  authenticatedCallerId: string,
  callerKind: CallerKind,
  runtimeIdHeader: string | string[] | undefined
): string {
  const runtimeId = Array.isArray(runtimeIdHeader) ? runtimeIdHeader[0] : runtimeIdHeader;
  if (runtimeId == null || runtimeId === "") return authenticatedCallerId;
  if (typeof runtimeId !== "string") {
    throw new Error("Invalid RPC runtime identity");
  }
  if (runtimeId === authenticatedCallerId) return authenticatedCallerId;
  if (isRuntimeIdForServiceToken(authenticatedCallerId, runtimeId)) {
    return runtimeId;
  }
  throw new Error(
    `RPC runtime identity denied: ${authenticatedCallerId} cannot act as ${runtimeId}`
  );
}

export class RpcServer {
  private wss: WebSocketServer | null = null;
  private workerdUrl: string | null = null;
  private workerdGatewayToken: string | null = null;
  private workerdDispatchSecret: string | null = null;
  private ensureDOFn:
    | ((source: string, className: string, objectKey: string) => Promise<void>)
    | null = null;

  /**
   * Tracks DO/worker-initiated service calls that complete out-of-band. Settled
   * results are delivered back via `callTarget(..., "onDeferredResult", ...)`.
   */
  private readonly deferrals = new DeferralRegistry({
    deliver: (callerId, requestId, result, isError) =>
      this.callTarget(callerId, "onDeferredResult", { requestId, result, isError }).then(
        () => undefined
      ),
    logger: console,
  });
  private connections = new ConnectionRegistry();
  private pendingToolCalls = new Map<string, PendingToolCall>();
  private disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private lastDisconnectAt = new Map<string, number>();
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
  private sessions: SessionRegistry;

  private readonly bootId = randomUUID();

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
      /**
       * Optional: the EgressProxy. When provided, `POST /rpc/stream`
       * can serve the `credentials.proxyFetch` fast path with a
       * credentialed upstream response body. Other streaming service
       * methods are dispatched through the normal service dispatcher and
       * do not require this dependency.
       */
      egressProxy?: Pick<
        import("./services/egressProxy.js").EgressProxy,
        "forwardProxyFetchStream"
      >;
      fsService?: Pick<import("@natstack/shared/fsService").FsService, "closeHandlesForCaller">;
      entityCache?: EntityCache;
      connectionGrants?: ConnectionGrantService;
      resolveExtensionInvocation?: (
        extensionName: string,
        invocationToken: string
      ) => Pick<ExtensionInvocation, "caller" | "chainCaller"> | null;
      sessionInboxCapacity?: SessionRegistryOptions["inboxCapacity"];
      sessionTtlMs?: SessionRegistryOptions["ttlMs"];
      runtimeCoordinator?: PanelRuntimeCoordinator;
    }
  ) {
    this.dispatcher = deps.dispatcher;
    deps.runtimeCoordinator?.setCloseConnection((panelId, connectionId, code, reason) => {
      this.connections.closeConnection(panelId, connectionId, code, reason);
    });
    this.sessions = new SessionRegistry({
      inboxCapacity: deps.sessionInboxCapacity,
      ttlMs: deps.sessionTtlMs,
      onSessionExpire: (callerId, callerKind) => {
        this.deps.onClientDisconnect?.(callerId, callerKind);
      },
    });
  }

  private verifiedCallerFor(callerId: string, callerKind: CallerKind): VerifiedCaller {
    const code = this.deps.entityCache
      ? resolveCodeIdentity(this.deps.entityCache, callerId)
      : null;
    return createVerifiedCaller(callerId, callerKind, code);
  }

  private serviceContextFor(
    callerId: string,
    callerKind: CallerKind,
    extras: Omit<ServiceContext, "caller"> = {}
  ): ServiceContext {
    return {
      caller: this.verifiedCallerFor(callerId, callerKind),
      ...extras,
    };
  }

  private serviceContextForRpcMessage(
    client: WsClientState,
    message: Pick<RpcRequest | import("@natstack/rpc").RpcStreamRequest, "parentInvocationToken">,
    extras: Omit<ServiceContext, "caller" | "connectionId" | "wsClient" | "chainCaller"> = {}
  ): ServiceContext {
    const ctx: ServiceContext = {
      caller: client.caller,
      connectionId: client.connectionId,
      wsClient: client,
      ...extras,
    };
    if (client.caller.runtime.kind !== "extension" || !message.parentInvocationToken) {
      return ctx;
    }
    const invocation = this.deps.resolveExtensionInvocation?.(
      client.caller.runtime.id,
      message.parentInvocationToken
    );
    if (invocation?.chainCaller) {
      ctx.chainCaller = invocation.chainCaller;
    } else {
      const caller = invocation?.caller;
      if (
        caller?.callerKind !== "panel" &&
        caller?.callerKind !== "app" &&
        caller?.callerKind !== "worker" &&
        caller?.callerKind !== "do"
      ) {
        return ctx;
      }
      ctx.chainCaller = {
        callerId: caller.callerId,
        callerKind: caller.callerKind,
        repoPath: "",
        effectiveVersion: "",
      };
    }
    return ctx;
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

  private resolveRoutableTargetId(targetId: string): string {
    return this.deps.runtimeCoordinator?.resolveRouteRuntimeEntityId(targetId) ?? targetId;
  }

  private pickRoutableTarget(targetId: string, connectionId?: string): WsClientState | undefined {
    const routedTargetId = this.resolveRoutableTargetId(targetId);
    if (connectionId) {
      return (
        this.getConnection(routedTargetId, connectionId) ??
        this.getConnection(targetId, connectionId)
      );
    }
    const routeConnectionId = this.deps.runtimeCoordinator?.resolveRouteConnection(targetId);
    if (routeConnectionId) return this.getConnection(routedTargetId, routeConnectionId);
    return this.pickPrimary(targetId);
  }

  private setBridge(
    callerId: string,
    connectionId: string,
    bridge: RpcClient,
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

  setWorkerdDispatchSecret(secret: string): void {
    this.workerdDispatchSecret = secret;
  }

  setEnsureDO(fn: (source: string, className: string, objectKey: string) => Promise<void>): void {
    this.ensureDOFn = fn;
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

      this.handleAuth(
        ws,
        msg.token,
        msg.connectionId,
        msg.clientLabel,
        msg.clientSessionId,
        msg.clientPlatform
      );
    };

    ws.on("message", onFirstMessage);
    ws.on("close", () => {
      if (authTimeout) {
        clearTimeout(authTimeout);
        authTimeout = null;
      }
    });
  }

  private handleAuth(
    ws: WebSocket,
    token: string,
    requestedConnectionId?: string,
    clientLabel?: string,
    clientSessionId?: string,
    clientPlatform?: ClientPlatform
  ): void {
    // Admin tokens are management-only. RPC clients must use caller tokens.
    if (this.deps.tokenManager.validateAdminToken(token)) {
      const msg: WsServerMessage = {
        type: "ws:auth-result",
        success: false,
        error: ADMIN_RPC_AUTH_ERROR,
      };
      ws.send(JSON.stringify(msg));
      ws.close(4006, "Admin token cannot authenticate RPC");
      return;
    }

    const grant = this.deps.connectionGrants?.redeem(token);
    let entry: { callerId: string; callerKind: CallerKind } | null;
    try {
      entry = grant
        ? {
            callerId: grant.principalId,
            callerKind: this.callerKindForRuntimePrincipal(grant.principalId),
          }
        : this.deps.tokenManager.validateToken(token);
    } catch {
      entry = null;
    }
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
    // The literal caller id "shell" is reserved for in-process dispatch.
    // Host clients that authenticate over WS use kind:"shell" with concrete
    // caller ids such as "electron-main", headless-host, or paired devices.
    if (entry.callerKind === "shell" && entry.callerId === "shell") {
      const msg: WsServerMessage = {
        type: "ws:auth-result",
        success: false,
        error: 'callerId:"shell" cannot authenticate over WebSocket',
      };
      ws.send(JSON.stringify(msg));
      ws.close(4006, 'callerId:"shell" cannot authenticate over WebSocket');
      return;
    }
    const callerKind: CallerKind = entry.callerKind;
    const callerId = entry.callerId;
    const connectionId = requestedConnectionId || randomUUID();
    const connectionKey = this.connectionKey(callerId, connectionId);

    const pendingTimer = this.disconnectTimers.get(connectionKey);
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      this.disconnectTimers.delete(connectionKey);
    }

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

    if (callerKind === "panel") {
      const auth = this.deps.runtimeCoordinator?.authorizePanelConnection(callerId, connectionId);
      if (!auth?.ok) {
        const msg: WsServerMessage = {
          type: "ws:auth-result",
          success: false,
          error: auth?.reason ?? "Panel runtime coordinator is unavailable",
        };
        ws.send(JSON.stringify(msg));
        ws.close(4090, "Panel runtime lease denied");
        return;
      }
    }

    const existing = this.connections.getConnection(callerId, connectionId);
    if (existing) {
      existing.ws.close(4002, "Replaced by new connection");
      this.sessions.markDisconnected(existing.caller.runtime.id, existing.caller.runtime.kind);
      this.cleanupClient(existing);
    }
    const { sessionDirty } = this.sessions.markConnected(callerId, callerKind);
    const caller = this.verifiedCallerFor(callerId, callerKind);

    const client: WsClientState = {
      ws,
      caller,
      connectionId,
      authenticated: true,
      authenticatedAt: Date.now(),
      authorizedBy: grant?.issuedBy,
      clientLabel,
      clientSessionId,
      clientPlatform,
    };

    this.connections.addClient(client);

    if (callerKind === "panel") {
      this.deps.runtimeCoordinator?.markConnected(callerId, connectionId);
      const previousDisconnectAt = this.lastDisconnectAt.get(callerId);
      log.info("panel connected", {
        callerId,
        sinceLastDisconnectMs:
          previousDisconnectAt === undefined ? null : Date.now() - previousDisconnectAt,
      });
    }

    // Create per-client RPC client for server→client calls
    const transport = createWsServerTransport({ ws, clientId: `${callerId}:${connectionId}` });
    const bridge = createRpcClient({
      selfId: "server",
      callerKind: "server",
      transport: envelopeTransportFromWsServer(transport),
    });
    this.setBridge(callerId, connectionId, bridge, transport);

    // Send auth result
    const authResult: WsServerMessage = {
      type: "ws:auth-result",
      success: true,
      callerId,
      callerKind,
      connectionId,
      serverBootId: this.bootId,
      sessionDirty,
    };
    ws.send(JSON.stringify(authResult));

    if (sessionDirty) {
      this.sessions.clearInbox(callerId);
    } else {
      for (const queued of this.sessions.takeInbox(callerId)) {
        this.sendToWs(ws, {
          type: "ws:routed",
          envelope: queued.envelope,
        });
      }
    }

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

  getConnectionForPrincipal(principalId: string): WsClientState | null {
    return this.pickPrimary(principalId) ?? null;
  }

  getAuthorizingShell(principalId: string): WsClientState | null {
    const panelConnection = this.getConnectionForPrincipal(principalId);
    const authorizingPrincipal = panelConnection?.authorizedBy;
    if (!authorizingPrincipal) return null;
    return this.getConnectionForPrincipal(authorizingPrincipal);
  }

  private callerKindForRuntimePrincipal(principalId: string): CallerKind {
    const kind = this.deps.entityCache?.resolve(principalId)?.kind;
    return callerKindForPrincipalKind(kind);
  }

  private handleMessage(client: WsClientState, data: Buffer | ArrayBuffer | Buffer[]): void {
    if (!this.connections.isActiveClient(client)) return;

    let msg: WsClientMessage;
    try {
      msg = JSON.parse(data.toString()) as WsClientMessage;
    } catch (error) {
      log.warn("malformed ws frame", {
        callerId: client.caller.runtime.id,
        callerKind: client.caller.runtime.kind,
        cause: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    switch (msg.type) {
      case "ws:rpc": {
        const envelope = (msg as { envelope?: RpcEnvelope }).envelope;
        if (!envelope?.message) {
          log.warn("malformed ws:rpc frame without envelope", {
            callerId: client.caller.runtime.id,
            callerKind: client.caller.runtime.kind,
          });
          return;
        }
        const rpcMessage = envelope.message;
        // If the message belongs to a server-initiated call via the client's RPC bridge,
        // route it to the client transport. Streaming responses use `stream-frame`; without
        // this branch, server -> extension stream callers wait forever for HEAD.
        if (
          rpcMessage.type === "response" ||
          rpcMessage.type === "event" ||
          rpcMessage.type === "stream-frame"
        ) {
          const transport = this.connections.getTransport(
            client.caller.runtime.id,
            client.connectionId
          );
          if (transport) {
            transport.deliver(client.caller.runtime.id, rpcMessage);
            // Bridge-delivered messages are not new service requests.
            return;
          }
        }
        void this.handleRpc(client, rpcMessage, envelope);
        break;
      }
      case "ws:tool-result":
        this.handleToolResult(msg.callId, msg.result as ToolExecutionResult);
        break;
      case "ws:route":
        if (!msg.envelope?.message) {
          log.warn("malformed ws:route frame without envelope", {
            callerId: client.caller.runtime.id,
            callerKind: client.caller.runtime.kind,
          });
          return;
        }
        this.handleRoute(
          client,
          msg.envelope.target,
          msg.envelope.message,
          msg.targetConnectionId,
          msg.envelope
        );
        break;
      case "ws:auth":
        // Ignore duplicate auth messages
        break;
    }
  }

  /**
   * In-flight streaming WS RPC handlers. Keyed by
   * `${callerId}\0${connectionId}\0${requestId}` — NOT by
   * `requestId` alone — because two clients can reuse the same
   * `requestId` and we'd otherwise let one cancel the other's
   * stream. The triple uniquely identifies a stream within the
   * server.
   */
  private wsStreamAborts = new Map<string, AbortController>();

  private wsStreamKey(callerId: string, connectionId: string, requestId: string): string {
    return `${callerId}\x00${connectionId}\x00${requestId}`;
  }

  private async handleRpc(
    client: WsClientState,
    message: RpcMessage,
    envelope: RpcEnvelope
  ): Promise<void> {
    if (message.type === "stream-request") {
      await this.handleWsStreamRequest(client, message, envelope);
      return;
    }
    if (message.type === "stream-cancel") {
      // Look up by the full {callerId, connectionId, requestId}
      // triple — a peer can only cancel streams it owns.
      const controller = this.wsStreamAborts.get(
        this.wsStreamKey(client.caller.runtime.id, client.connectionId, message.requestId)
      );
      if (controller) controller.abort();
      return;
    }
    if (message.type === "stream-frame") {
      // Stream frames flow server→client during a streaming response.
      // A client sending one is malformed; ignore.
      return;
    }
    if (message.type !== "request") return;

    const request = message as RpcRequest;
    const parsed = parseServiceMethod(request.method);

    if (!parsed) {
      this.sendToWs(client.ws, {
        type: "ws:rpc",
        envelope: responseEnvelopeFor(envelope, SERVER_RESPONDER, {
          type: "response",
          requestId: request.requestId,
          error: `Invalid method format: "${request.method}". Expected "service.method"`,
        }),
      });
      return;
    }

    const { service, method } = parsed;

    try {
      checkServiceAccess(service, client.caller.runtime.kind, this.dispatcher, method);
    } catch (error) {
      this.sendToWs(client.ws, {
        type: "ws:rpc",
        envelope: responseEnvelopeFor(envelope, SERVER_RESPONDER, {
          type: "response",
          requestId: request.requestId,
          error: error instanceof Error ? error.message : String(error),
        }),
      });
      return;
    }

    const idempotencyKey = envelope.delivery.idempotencyKey;
    const readOnly = envelope.delivery.readOnly === true;
    const ctx = this.serviceContextForRpcMessage(client, request, {
      ...(request.requestId ? { requestId: request.requestId } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(readOnly ? { readOnly: true } : {}),
    });

    const dispatcher = this.dispatcher;

    try {
      const result = await dispatcher.dispatch(ctx, service, method, request.args);
      this.sendToWs(client.ws, {
        type: "ws:rpc",
        envelope: responseEnvelopeFor(envelope, SERVER_RESPONDER, {
          type: "response",
          requestId: request.requestId,
          result,
        }),
      });
    } catch (error) {
      const errorCode = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
      this.sendToWs(client.ws, {
        type: "ws:rpc",
        envelope: responseEnvelopeFor(envelope, SERVER_RESPONDER, {
          type: "response",
          requestId: request.requestId,
          error: error instanceof Error ? error.message : String(error),
          ...(errorCode ? { errorCode } : {}),
        }),
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
    targetConnectionId: string | undefined,
    routeEnvelope: RpcEnvelope
  ): void {
    const auth = this.checkRelayAuth(
      client.caller.runtime.id,
      client.caller.runtime.kind,
      targetId
    );
    if (!auth.ok) {
      this.sendRouteError(client, targetId, message, new Error(auth.reason));
      return;
    }

    if (message.type === "response") {
      if (targetId === "server") {
        this.failServerBoundRoutedResponse(client, message);
        return;
      }

      // MED-7: route the response back to the ORIGIN CONNECTION that issued the
      // request, not merely to the origin caller's primary connection. A
      // multi-connection origin would otherwise misroute the reply to the wrong
      // socket. If the origin is unknown (never recorded, or evicted by the
      // count cap on `routedRequestOrigins`) there is no correct destination —
      // reject the responder's relay rather than best-effort delivering to the
      // primary connection (which is the silent-misroute being fixed here).
      const origin = this.routedRequestOrigins.get(message.requestId);
      if (!origin || origin.callerId !== targetId) {
        // No correct destination is known — reject the responder's relay
        // instead of best-effort delivering to the target's primary connection
        // (the silent misroute). Surfaces the same TARGET_NOT_REACHABLE shape an
        // unreachable target produced before this connection-keyed routing.
        this.sendRouteError(
          client,
          targetId,
          message,
          createRelayError(`Target not reachable: ${targetId}`, "TARGET_NOT_REACHABLE")
        );
        return;
      }
      this.routedRequestOrigins.delete(message.requestId);
      void this.resolveWsRelayTarget(origin.callerId, origin.connectionId).then(
        (originClient) => {
          this.sendToWs(originClient.ws, {
            type: "ws:routed",
            envelope: routeEnvelope,
          });
        },
        (err) => this.sendRouteError(client, targetId, message, err)
      );
      return;
    }

    // FIX 1 (unification): events ALWAYS flow through the single canonical
    // `relayEvent` path — whether or not the target currently looks connected,
    // and across every target kind (panel/shell fan-out, DO, worker). Collapsing
    // delivery here is what prevents an event path from being silently
    // re-implemented inline (and a target kind, e.g. connectionless DOs,
    // forgotten). `relayEvent` is fire-and-forget; an undeliverable event
    // rejects and surfaces as a logged `ws:routed-event-error` rather than being
    // dropped or stalling behind a reconnect grace window.
    if (message.type === "event") {
      void this.relayEvent(
        client.caller.runtime.id,
        client.caller.runtime.kind,
        targetId,
        message.event,
        message.payload,
        targetConnectionId
      ).catch((err) => {
        this.sendRouteError(client, targetId, message, err);
      });
      return;
    }

    const targetClient = this.pickRoutableTarget(targetId, targetConnectionId);
    if (!targetClient || targetClient.ws.readyState !== WebSocket.OPEN) {
      // Target not connected via WS — try HTTP relay for workers/DOs; panel
      // and shell targets fail fast when unreachable.
      if (message.type === "request") {
        const { requestId, method: reqMethod, args: reqArgs } = message;
        this.recordRoutedRequestOrigin(requestId, client);
        void this.relayCall(
          client.caller.runtime.id,
          client.caller.runtime.kind,
          targetId,
          reqMethod,
          reqArgs ?? [],
          targetConnectionId,
          relayMetaFromEnvelope(routeEnvelope)
        ).then(
          (result) => {
            void this.sendRoutedResponseToOrigin(
              { callerId: client.caller.runtime.id, connectionId: client.connectionId },
              targetId,
              {
                type: "response",
                requestId,
                result,
              }
            ).catch((sendErr) => this.sendRouteError(client, targetId, message, sendErr));
          },
          (err) => {
            const errorCode = getErrorCode(err);
            void this.sendRoutedResponseToOrigin(
              { callerId: client.caller.runtime.id, connectionId: client.connectionId },
              targetId,
              {
                type: "response",
                requestId,
                error: err instanceof Error ? err.message : String(err),
                ...(errorCode ? { errorCode } : {}),
              }
            ).catch((sendErr) => this.sendRouteError(client, targetId, message, sendErr));
          }
        );
      }
      // `response` and `event` messages are fully handled (and returned) above,
      // so only `request`/stream messages reach this not-connected block.
      return;
    }

    // Events and responses were already dispatched and returned above; only
    // `request`/stream messages reach here. Record the origin connection for
    // routed requests so the eventual response is delivered back to the exact
    // connection that issued it (see MED-7 response handling above).
    if (message.type === "request") {
      this.recordRoutedRequestOrigin(message.requestId, client);
    }

    this.sendToWs(targetClient.ws, {
      type: "ws:routed",
      envelope: routeEnvelope,
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
        envelope: envelopeForWsDelivery(targetId, "unknown", client.caller.runtime.id, {
          type: "response",
          requestId: message.requestId,
          error: errorMessage,
          ...(errorCode ? { errorCode } : {}),
        }),
      });
      return;
    }

    if (message.type === "response") {
      log.warn("relay response drop", {
        callerId: client.caller.runtime.id,
        callerKind: client.caller.runtime.kind,
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
        callerId: client.caller.runtime.id,
        callerKind: client.caller.runtime.kind,
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

  private failServerBoundRoutedResponse(client: WsClientState, message: RpcResponse): void {
    const err = createRelayError(
      `Protocol error: response for server request ${message.requestId} was sent via ws:route; use ws:rpc for server-bound responses`,
      "RPC_PROTOCOL_ERROR"
    );
    const errorMessage = err.message;
    const errorCode = getErrorCode(err);

    log.warn("server-bound routed response", {
      callerId: client.caller.runtime.id,
      callerKind: client.caller.runtime.kind,
      requestId: message.requestId,
      error: errorMessage,
      errorCode,
    });

    const transport = this.connections.getTransport(client.caller.runtime.id, client.connectionId);
    if (transport) {
      transport.deliver(client.caller.runtime.id, {
        type: "response",
        requestId: message.requestId,
        error: errorMessage,
        ...(errorCode ? { errorCode } : {}),
      });
    }

    this.sendToWs(client.ws, {
      type: "ws:routed-response-error",
      targetId: "server",
      requestId: message.requestId,
      error: errorMessage,
      ...(errorCode ? { errorCode } : {}),
    });
  }

  private recordRoutedRequestOrigin(requestId: string, client: WsClientState): void {
    this.routedRequestOrigins.set(requestId, {
      callerId: client.caller.runtime.id,
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
    origin: { callerId: string; connectionId: string },
    fromId: string,
    message: RpcResponse
  ): Promise<void> {
    const originClient = await this.resolveWsRelayTarget(origin.callerId, origin.connectionId);
    this.sendToWs(originClient.ws, {
      type: "ws:routed",
      envelope: envelopeForWsDelivery(fromId, "unknown", origin.callerId, message),
    });
  }

  private handleClose(client: WsClientState, code?: number, reason?: string): void {
    const callerId = client.caller.runtime.id;
    const callerKind = client.caller.runtime.kind;
    const connectionKey = this.connectionKey(callerId, client.connectionId);
    const removedActive = this.connections.removeClient(client);
    const wasReplaced = !removedActive;

    // Abort any in-flight streaming RPCs owned by this connection.
    // Without this, the upstream fetch keeps draining bytes that
    // nobody can read — `sendToWs` would silently drop the frames.
    const streamKeyPrefix = this.wsStreamKey(callerId, client.connectionId, "");
    for (const [key, controller] of this.wsStreamAborts) {
      if (key.startsWith(streamKeyPrefix)) {
        controller.abort();
        this.wsStreamAborts.delete(key);
      }
    }

    if (!wasReplaced && callerKind === "panel") {
      this.deps.runtimeCoordinator?.markDisconnected(callerId, client.connectionId);
      this.lastDisconnectAt.set(callerId, Date.now());
      log.info("panel disconnected", {
        callerId,
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
    if (!wasReplaced) {
      this.sessions.markDisconnected(callerId, callerKind);
    }

    // Reject pending tool calls for this client
    for (const [callId, pending] of this.pendingToolCalls) {
      if (pending.clientWs === client.ws) {
        clearTimeout(pending.timeout);
        this.pendingToolCalls.delete(callId);
        pending.reject(new Error("Client disconnected"));
      }
    }

    // If this socket was replaced, the replacement is already connected under the
    // same caller/connection id. Do not arm reconnect waiters or expire the live lease.
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
        if (code === "RECONNECT_GRACE_EXPIRED" || code === "SERVER_SHUTTING_DOWN") return;
        log.error("unexpected connection reconnect waiter rejection", {
          callerId,
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

    const callerHasOtherConnections = this.getCallerConnections(callerId).length > 0;
    const existing = this.disconnectTimers.get(connectionKey);
    if (existing) clearTimeout(existing);

    if (!callerHasOtherConnections && !this.reconnectWaiters.has(callerId)) {
      let resolveWaiter!: () => void;
      let rejectWaiter!: (err: Error) => void;
      const promise = new Promise<void>((res, rej) => {
        resolveWaiter = res;
        rejectWaiter = rej;
      });
      void promise.catch((error) => {
        const code = getErrorCode(error);
        if (code === "RECONNECT_GRACE_EXPIRED" || code === "SERVER_SHUTTING_DOWN") return;
        log.error("unexpected reconnect waiter rejection", {
          callerId,
          cause: error instanceof Error ? error.message : String(error),
          errorCode: code,
        });
      });
      this.reconnectWaiters.set(callerId, {
        promise,
        resolve: resolveWaiter,
        reject: rejectWaiter,
      });
    }

    const timer = setTimeout(() => {
      this.disconnectTimers.delete(connectionKey);
      const waiter = this.reconnectWaiters.get(callerId);
      if (waiter) {
        this.reconnectWaiters.delete(callerId);
        waiter.reject(
          createRelayError(
            "Client did not reconnect within grace window",
            "RECONNECT_GRACE_EXPIRED"
          )
        );
      }
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
      this.cleanupRoutedOriginsForConnection(callerId, client.connectionId);
      if (this.getCallerConnections(callerId).length === 0) {
        this.deps.onClientDisconnect?.(callerId, callerKind);
      }
    }, RpcServer.DISCONNECT_GRACE_MS);

    this.disconnectTimers.set(connectionKey, timer);
  }

  private cleanupClient(client: WsClientState): void {
    const callerId = client.caller.runtime.id;
    const connectionKey = this.connectionKey(callerId, client.connectionId);
    const pendingTimer = this.disconnectTimers.get(connectionKey);
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      this.disconnectTimers.delete(connectionKey);
    }
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
   * Get the RPC client for a connected client.
   * Returns undefined if the client is not connected.
   *
   * The server can use this client to call methods exposed by the client.
   */
  getClientBridge(callerId: string): RpcClient | undefined {
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
    // Streaming proxy-fetch endpoint — separate route because it uses
    // chunked transfer with a binary frame format, not the JSON
    // request/response of the regular RPC.
    if (req.method === "POST" && req.url === "/rpc/stream") {
      await this.handleStreamingProxyFetch(req, res);
      return;
    }

    // Only handle POST /rpc
    if (req.method !== "POST" || req.url !== "/rpc") {
      res.writeHead(404);
      res.end();
      return;
    }

    // Read body, bounded. The cap is deliberately generous (large file writes
    // ride this path) but finite, so a runaway or malicious client can't
    // buffer unbounded memory server-side. Override via
    // NATSTACK_RPC_MAX_BODY_BYTES (0 disables the cap).
    const maxBodyBytes = resolveRpcMaxBodyBytes();
    const chunks: Buffer[] = [];
    let bodyBytes = 0;
    for await (const chunk of req) {
      bodyBytes += (chunk as Buffer).length;
      if (maxBodyBytes > 0 && bodyBytes > maxBodyBytes) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: `RPC body exceeds ${maxBodyBytes} bytes (set NATSTACK_RPC_MAX_BODY_BYTES to raise)`,
          })
        );
        req.destroy();
        return;
      }
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

    // Auth: validate Bearer token
    const authHeader = req.headers["authorization"];
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing authorization" }));
      return;
    }

    if (this.deps.tokenManager.validateAdminToken(token)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: ADMIN_RPC_AUTH_ERROR,
        })
      );
      return;
    }

    const entry = this.deps.tokenManager.validateToken(token);
    if (!entry) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid token" }));
      return;
    }
    if (entry.callerKind === "shell" && entry.callerId === "shell") {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: 'callerId:"shell" cannot authenticate over HTTP RPC' }));
      return;
    }
    let callerKind = entry.callerKind;
    let callerId: string;
    try {
      callerId = resolveHttpRuntimeCaller(
        entry.callerId,
        callerKind,
        req.headers[RPC_RUNTIME_ID_HEADER]
      );
      if (callerId !== entry.callerId) {
        callerKind = this.callerKindForRuntimePrincipal(callerId);
      }
    } catch (err) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      return;
    }

    // The body is an `RpcEnvelope`; `from`/`delivery.caller` are self-reported
    // and NOT trusted — the authenticated (callerId, callerKind) above are the
    // authority. We dispatch `envelope.message` and reply with a response
    // envelope, mirroring the WS `ws:route` path.
    const envelope = body as unknown as RpcEnvelope;
    const message = envelope.message;
    if (!message || typeof message !== "object" || typeof message.type !== "string") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Expected an RpcEnvelope body with a message" }));
      return;
    }

    if (message.type === "event") {
      try {
        await this.handleEnvelopeEvent(callerId, callerKind, envelope, message);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({}));
      } catch (err) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }

    if (message.type !== "request") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Unsupported /rpc message type: ${message.type}` }));
      return;
    }

    const requestId = message.requestId;
    try {
      const result = await this.handleEnvelopeRequest(callerId, callerKind, envelope, message);
      res.writeHead(200, { "Content-Type": "application/json" });
      if (isDeferredResult(result)) {
        // Handler parked the call; ack now and deliver later via onDeferredResult.
        res.end(JSON.stringify({ deferred: true, requestId: result.requestId }));
      } else {
        res.end(
          JSON.stringify(
            responseEnvelopeFor(envelope, SERVER_RESPONDER, {
              type: "response",
              requestId,
              result,
            })
          )
        );
      }
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      const errorCode = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
      const errorStack = err instanceof Error ? err.stack : undefined;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify(
          responseEnvelopeFor(envelope, SERVER_RESPONDER, {
            type: "response",
            requestId,
            error: errMessage,
            ...(errorCode ? { errorCode } : {}),
            ...(errorStack ? { errorStack } : {}),
          })
        )
      );
    }
  }

  /**
   * Dispatch a `request` envelope arriving over HTTP `/rpc`. `target === "main"`
   * is a direct service-dispatch (with deferral opt-in); any other target is a
   * relay. Returns the raw result, or a `DeferredResult` sentinel when parked.
   */
  private async handleEnvelopeRequest(
    callerId: string,
    callerKind: CallerKind,
    envelope: RpcEnvelope,
    message: RpcRequest
  ): Promise<unknown> {
    const targetId = envelope.target;
    const method = message.method;
    const args = message.args ?? [];
    const requestId = message.requestId;
    const idempotencyKey = envelope.delivery.idempotencyKey;
    const readOnly = envelope.delivery.readOnly === true;

    // Direct service dispatch
    if (targetId === "main") {
      const parsed = parseServiceMethod(method);
      if (!parsed) throw new Error(`Invalid method format: "${method}"`);

      checkServiceAccess(parsed.service, callerKind, this.dispatcher, parsed.method);

      // A handler may complete out-of-band only when the caller explicitly opted
      // in (via callDeferred → `deferrable`), stamped a requestId, and can receive
      // an inbound onDeferredResult (DO/worker). Plain `call` callers never defer.
      const canDefer =
        message.deferrable === true &&
        !!requestId &&
        (callerKind === "do" || callerKind === "worker");
      const deferredRequestId = canDefer ? requestId : undefined;
      const deferral = deferredRequestId
        ? this.deferrals.createApi({
            callerId,
            requestId: deferredRequestId,
            ...(idempotencyKey ? { idempotencyKey } : {}),
            service: parsed.service,
            method: parsed.method,
          })
        : undefined;
      const ctx = this.serviceContextFor(callerId, callerKind, {
        ...(requestId ? { requestId } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
        ...(deferral ? { deferral } : {}),
        ...(readOnly ? { readOnly: true } : {}),
      });
      return await this.dispatcher.dispatch(ctx, parsed.service, parsed.method, args);
    }

    // Relay to another target
    const auth = this.checkRelayAuth(callerId, callerKind, targetId);
    if (!auth.ok) throw new Error(auth.reason);
    return await this.relayCall(callerId, callerKind, targetId, method, args, undefined, {
      ...(requestId ? { requestId } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(readOnly ? { readOnly: true } : {}),
    });
  }

  /** Dispatch an `event` envelope arriving over HTTP `/rpc` (relay to a target). */
  private async handleEnvelopeEvent(
    callerId: string,
    callerKind: CallerKind,
    envelope: RpcEnvelope,
    message: RpcEvent
  ): Promise<void> {
    const targetId = envelope.target;
    const auth = this.checkRelayAuth(callerId, callerKind, targetId);
    if (!auth.ok) throw new Error(auth.reason);
    await this.relayEvent(callerId, callerKind, targetId, message.event, message.payload);
  }

  /**
   * `POST /rpc/stream` — service RPC with a streaming Response body.
   *
   * `credentials.proxyFetch` keeps its egress-proxy fast path so policy failures can still return
   * normal HTTP statuses before any frame is emitted. Other service methods dispatch through the
   * normal service-policy layer and must return a `Response`.
   */
  /**
   * Pre-flight validation for streaming proxy fetch — runs the
   * method allow-list, egress-proxy availability check, and param
   * presence/decoding. Callable BEFORE the transport commits to a
   * response (so HTTP can return a real 400/503 status code, not a
   * 200-with-error-frame). Returns either a ready-to-execute call
   * descriptor or a rejection with status + error message.
   */
  private validateStreamingProxyFetch(request: {
    method: string;
    callerKind: CallerKind;
    args: unknown[];
    readOnly?: boolean;
  }):
    | {
        ok: true;
        egress: Pick<import("./services/egressProxy.js").EgressProxy, "forwardProxyFetchStream">;
        proxyParams: {
          url: string;
          method: string;
          headers?: Record<string, string>;
          body?: string | Uint8Array;
          credentialId?: string;
        };
      }
    | { ok: false; status: number; error: string } {
    if (request.method !== "credentials.proxyFetch") {
      return {
        ok: false,
        status: 400,
        error: `Method '${request.method}' is not exposed on the streaming endpoint. Only 'credentials.proxyFetch' is allowed.`,
      };
    }
    const egress = this.deps.egressProxy;
    if (!egress) {
      return { ok: false, status: 503, error: "Streaming proxy fetch is unavailable" };
    }
    // Run the same service-policy check as `POST /rpc` /
    // non-streaming WS RPC. Without this the streaming endpoints
    // would silently allow caller-kinds that the regular path
    // denies. Service+method parse never fails here since the
    // method allow-list above already rejected anything other than
    // `credentials.proxyFetch`.
    try {
      checkServiceAccess("credentials", request.callerKind, this.dispatcher, "proxyFetch");
    } catch (err) {
      return {
        ok: false,
        status: 403,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    if (request.readOnly) {
      const methodDef = this.dispatcher.getMethodSchema?.("credentials", "proxyFetch");
      const sensitivity = methodDef?.access?.sensitivity;
      if (sensitivity !== "read") {
        return {
          ok: false,
          status: 403,
          error:
            `Blocked in read-only mode: 'credentials.proxyFetch' is not declared read-only ` +
            `(sensitivity ${sensitivity ?? "unknown"}). A read-only caller may only invoke ` +
            `methods declaring access.sensitivity === "read".`,
        };
      }
    }
    const params = (request.args?.[0] ?? {}) as {
      url?: string;
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      bodyBase64?: string;
      credentialId?: string;
    };
    if (!params.url || !params.method) {
      return { ok: false, status: 400, error: "Missing required params: url and method" };
    }
    const upstreamBody: string | Uint8Array | undefined =
      params.bodyBase64 !== undefined
        ? new Uint8Array(Buffer.from(params.bodyBase64, "base64"))
        : params.body;
    return {
      ok: true,
      egress,
      proxyParams: {
        url: params.url,
        method: params.method,
        headers: params.headers,
        body: upstreamBody,
        credentialId: params.credentialId,
      },
    };
  }

  private async handleStreamingProxyFetch(
    req: import("http").IncomingMessage,
    res: import("http").ServerResponse
  ): Promise<void> {
    // Auth — same flow as `POST /rpc`.
    const authHeader = req.headers["authorization"];
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing authorization" }));
      return;
    }
    if (this.deps.tokenManager.validateAdminToken(token)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: ADMIN_RPC_AUTH_ERROR,
        })
      );
      return;
    }
    const entry = this.deps.tokenManager.validateToken(token);
    if (!entry) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid token" }));
      return;
    }
    if (entry.callerKind === "shell" && entry.callerId === "shell") {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: 'callerId:"shell" cannot authenticate over HTTP RPC' }));
      return;
    }
    let callerKind = entry.callerKind;
    let callerId: string;
    try {
      callerId = resolveHttpRuntimeCaller(
        entry.callerId,
        callerKind,
        req.headers[RPC_RUNTIME_ID_HEADER]
      );
      if (callerId !== entry.callerId) {
        callerKind = this.callerKindForRuntimePrincipal(callerId);
      }
    } catch (err) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      return;
    }

    // Read request body (capped).
    const chunks: Buffer[] = [];
    let total = 0;
    const MAX_REQUEST_BODY = 16 * 1024 * 1024;
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      total += buf.byteLength;
      if (total > MAX_REQUEST_BODY) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Request body too large for streaming proxy fetch" }));
        return;
      }
      chunks.push(buf);
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON body" }));
      return;
    }

    // Envelope-native: the streaming request rides an RpcEnvelope whose message
    // is a `stream-request` carrying method/args; the target is the envelope's.
    const streamEnvelope = body as unknown as RpcEnvelope;
    const streamMessage = streamEnvelope.message as RpcStreamRequest | undefined;
    const method = streamMessage?.method;
    const args = streamMessage?.args ?? [];
    const targetId = streamEnvelope.target;
    const idempotencyKey = streamEnvelope.delivery?.idempotencyKey;
    const readOnly = streamEnvelope.delivery?.readOnly === true;
    const effectiveCaller = this.verifiedCallerFor(callerId, callerKind);

    if (targetId && targetId !== "main") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ error: "HTTP RPC streaming currently supports targetId 'main' only" })
      );
      return;
    }

    if (!method) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing method" }));
      return;
    }

    if (method !== "credentials.proxyFetch") {
      const parsed = parseServiceMethod(method);
      if (!parsed) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Invalid method format: "${method}"` }));
        return;
      }
      try {
        checkServiceAccess(parsed.service, callerKind, this.dispatcher, parsed.method);
      } catch (err) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        return;
      }

      let response: Response;
      try {
        const ctx = this.serviceContextFor(callerId, callerKind, {
          ...(streamMessage?.requestId ? { requestId: streamMessage.requestId } : {}),
          ...(idempotencyKey ? { idempotencyKey } : {}),
          ...(readOnly ? { readOnly: true } : {}),
        });
        const result = await this.dispatcher.dispatch(ctx, parsed.service, parsed.method, args);
        if (!(result instanceof Response)) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({ error: `Streaming service ${method} did not return a Response` })
          );
          return;
        }
        response = result;
      } catch (err) {
        const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
        res.writeHead(200, {
          "Content-Type": "application/vnd.natstack.credentialed-fetch+binary",
          "Cache-Control": "no-store",
          "X-Accel-Buffering": "no",
        });
        const codec = await import("../../packages/shared/src/credentials/streamFraming.js");
        await this.writeHttpStreamBytes(
          res,
          codec.encodeErrorFrame({
            status: 502,
            message: err instanceof Error ? err.message : String(err),
            code: typeof code === "string" ? code : undefined,
          })
        ).catch(() => {});
        res.end();
        return;
      }

      res.writeHead(200, {
        "Content-Type": "application/vnd.natstack.credentialed-fetch+binary",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
      });
      try {
        await this.pipeResponseToHttpFrames(response, res);
      } finally {
        res.end();
      }
      return;
    }

    // Run validation BEFORE committing to a 200 response, so policy
    // failures (wrong method, no egress proxy, missing params,
    // policy violation) come back as proper HTTP error statuses.
    const check = this.validateStreamingProxyFetch({
      method,
      callerKind,
      args,
      readOnly,
    });
    if (!check.ok) {
      res.writeHead(check.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: check.error }));
      return;
    }

    // Cancellation: HTTP transport close = caller went away.
    const abortController = new AbortController();
    req.on("close", () => abortController.abort());
    res.on("close", () => abortController.abort());

    const codec = await import("../../packages/shared/src/credentials/streamFraming.js");
    // HTTP encodes frames as raw binary on the chunked response —
    // no base64 overhead since the response IS a binary stream.
    const emitFrame = async (
      frame: import("./services/egressProxy.js").StreamFrame
    ): Promise<void> => {
      if (frame.kind === "head") {
        await this.writeHttpStreamBytes(
          res,
          codec.encodeHeadFrame({
            status: frame.status,
            statusText: frame.statusText,
            headerPairs: frame.headerPairs,
            finalUrl: frame.finalUrl,
          })
        );
      } else if (frame.kind === "chunk") {
        await this.writeHttpStreamBytes(res, codec.encodeDataFrame(frame.bytes));
      } else if (frame.kind === "end") {
        await this.writeHttpStreamBytes(res, codec.encodeEndFrame({ bytesIn: frame.bytesIn }));
      } else if (frame.kind === "error") {
        await this.writeHttpStreamBytes(
          res,
          codec.encodeErrorFrame({
            status: frame.status,
            message: frame.message,
            code: frame.code,
          })
        );
      }
    };

    // Headers go out before the first frame.
    res.writeHead(200, {
      "Content-Type": "application/vnd.natstack.credentialed-fetch+binary",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    });

    try {
      await check.egress.forwardProxyFetchStream(
        { caller: effectiveCaller, ...check.proxyParams },
        emitFrame,
        abortController.signal
      );
    } catch (err) {
      try {
        const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
        await emitFrame({
          kind: "error",
          status: 502,
          message: err instanceof Error ? err.message : String(err),
          code: typeof code === "string" ? code : undefined,
        });
      } catch {
        // Best-effort — connection may already be torn down.
      }
    } finally {
      res.end();
    }
  }

  private writeHttpStreamBytes(
    res: import("http").ServerResponse,
    bytes: Uint8Array
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ok = res.write(bytes, (err) => {
        if (err) reject(err);
      });
      if (ok) resolve();
      else res.once("drain", () => resolve());
    });
  }

  private async pipeResponseToHttpFrames(
    response: Response,
    res: import("http").ServerResponse
  ): Promise<void> {
    const codec = await import("../../packages/shared/src/credentials/streamFraming.js");
    await this.writeHttpStreamBytes(
      res,
      codec.encodeHeadFrame({
        status: response.status,
        statusText: response.statusText,
        headerPairs: Array.from(response.headers.entries()),
        finalUrl: response.url,
      })
    );
    let bytesIn = 0;
    if (response.body) {
      const reader = response.body.getReader();
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          bytesIn += next.value.byteLength;
          await this.writeHttpStreamBytes(res, codec.encodeDataFrame(next.value));
        }
      } catch (err) {
        const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
        await this.writeHttpStreamBytes(
          res,
          codec.encodeErrorFrame({
            status: 502,
            message: err instanceof Error ? err.message : String(err),
            code: typeof code === "string" ? code : undefined,
          })
        );
        return;
      } finally {
        reader.releaseLock();
      }
    }
    await this.writeHttpStreamBytes(res, codec.encodeEndFrame({ bytesIn }));
  }

  /**
   * Handle a WS-delivered `stream-request`. This mirrors the HTTP
   * `/rpc/stream` route's policy: generic `service.method` requests go
   * through service policy checks and must return a `Response`, while
   * `credentials.proxyFetch` keeps its dedicated egress validation and
   * forwarding path. Frames are wrapped in the `ws:rpc` envelope because
   * WS is the panel/shell transport.
   */
  private async handleWsStreamRequest(
    client: WsClientState,
    request: import("@natstack/rpc").RpcStreamRequest,
    envelope: RpcEnvelope
  ): Promise<void> {
    const idempotencyKey = envelope.delivery.idempotencyKey;
    const readOnly = envelope.delivery.readOnly === true;
    const sendFrame = (frameType: number, payload: string): void => {
      this.sendToWs(client.ws, {
        type: "ws:rpc",
        envelope: responseEnvelopeFor(envelope, SERVER_RESPONDER, {
          type: "stream-frame",
          requestId: request.requestId,
          fromId: "main",
          frameType,
          payload,
        }),
      });
    };

    // WS encodes DATA frames as base64 in JSON (the `ws:rpc`
    // envelope is JSON-serialized). The HTTP endpoint avoids this
    // overhead by writing raw bytes to the chunked response.
    const emitFrame = (frame: import("./services/egressProxy.js").StreamFrame): void => {
      if (frame.kind === "head") {
        sendFrame(
          0x01,
          JSON.stringify({
            status: frame.status,
            statusText: frame.statusText,
            headerPairs: frame.headerPairs,
            finalUrl: frame.finalUrl,
          })
        );
      } else if (frame.kind === "chunk") {
        // Buffer's native base64 encoder — the previous byte-by-byte
        // String.fromCharCode + btoa version built an O(n) intermediate
        // string one character at a time, dominating CPU on large bodies.
        sendFrame(0x02, Buffer.from(frame.bytes).toString("base64"));
      } else if (frame.kind === "end") {
        sendFrame(0x03, JSON.stringify({ bytesIn: frame.bytesIn }));
      } else if (frame.kind === "error") {
        sendFrame(
          0x04,
          JSON.stringify({
            status: frame.status,
            message: frame.message,
            code: frame.code,
          })
        );
      }
    };

    const parsed = parseServiceMethod(request.method);
    if (parsed && request.method !== "credentials.proxyFetch") {
      try {
        checkServiceAccess(
          parsed.service,
          client.caller.runtime.kind,
          this.dispatcher,
          parsed.method
        );
        const ctx = this.serviceContextForRpcMessage(client, request, {
          ...(request.requestId ? { requestId: request.requestId } : {}),
          ...(idempotencyKey ? { idempotencyKey } : {}),
          ...(readOnly ? { readOnly: true } : {}),
        });
        const result = await this.dispatcher.dispatch(
          ctx,
          parsed.service,
          parsed.method,
          request.args
        );
        if (!(result instanceof Response)) {
          emitFrame({
            kind: "error",
            status: 500,
            message: `Streaming service ${request.method} did not return a Response`,
          });
          return;
        }
        await this.pipeResponseToWsFrames(result, emitFrame);
      } catch (err) {
        emitFrame({
          kind: "error",
          status: 502,
          message: err instanceof Error ? err.message : String(err),
          code: err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined,
        });
      }
      return;
    }

    // WS has no separate-status-code path — pre-flight failures
    // become ERROR frames just like in-flight failures. The client's
    // `stream` promise rejects with the error message either way.
    const check = this.validateStreamingProxyFetch({
      method: request.method,
      callerKind: client.caller.runtime.kind,
      args: request.args,
      readOnly,
    });
    if (!check.ok) {
      emitFrame({ kind: "error", status: check.status, message: check.error });
      return;
    }

    const abortController = new AbortController();
    const streamKey = this.wsStreamKey(
      client.caller.runtime.id,
      client.connectionId,
      request.requestId
    );
    this.wsStreamAborts.set(streamKey, abortController);

    try {
      await check.egress.forwardProxyFetchStream(
        { caller: client.caller, ...check.proxyParams },
        emitFrame,
        abortController.signal
      );
    } catch (err) {
      try {
        const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
        emitFrame({
          kind: "error",
          status: 502,
          message: err instanceof Error ? err.message : String(err),
          code: typeof code === "string" ? code : undefined,
        });
      } catch {
        // Best-effort — client may already be gone.
      }
    } finally {
      this.wsStreamAborts.delete(streamKey);
    }
  }

  private async pipeResponseToWsFrames(
    response: Response,
    emitFrame: (frame: import("./services/egressProxy.js").StreamFrame) => void
  ): Promise<void> {
    emitFrame({
      kind: "head",
      status: response.status,
      statusText: response.statusText,
      headerPairs: Array.from(response.headers.entries()),
      finalUrl: response.url,
    });
    let bytesIn = 0;
    if (response.body) {
      const reader = response.body.getReader();
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          bytesIn += next.value.byteLength;
          emitFrame({ kind: "chunk", bytes: next.value });
        }
      } finally {
        reader.releaseLock();
      }
    }
    emitFrame({ kind: "end", bytesIn });
  }

  // ===========================================================================
  // Relay helpers (used by both HTTP POST /rpc and WS handleRoute)
  // ===========================================================================

  /**
   * Enforce authorization for relay calls/events.
   *
   * RPC relay authorization is intentionally open between authenticated
   * participants. Sensitive recipients must enforce their own method-level
   * gates on receipt.
   */
  private checkRelayAuth(
    _callerId: string,
    _callerKind: CallerKind,
    _targetId: string
  ): RelayAuthCheck {
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
    return this.relayCall("main", "server", targetId, method, args) as Promise<T>;
  }

  /**
   * Server→caller event push. Used by the `EventService` DO push-subscriber to
   * deliver `events.subscribe` pushes to a connectionless DO/worker: `channel`
   * is the full `event:<name>` the caller's `rpc.on(...)` listens on, so the
   * DO's `handleEvent` matches it directly. Throws if the target is unreachable
   * (the subscriber treats that as a reap signal).
   */
  async pushEventToCaller(targetId: string, channel: string, payload: unknown): Promise<void> {
    await this.relayEvent("main", "server", targetId, channel, payload);
  }

  async streamCallTarget(targetId: string, method: string, ...args: unknown[]): Promise<Response> {
    const wsClient = this.pickRoutableTarget(targetId);
    if (wsClient?.ws.readyState !== WebSocket.OPEN) {
      throw createRelayError(`Target not reachable: ${targetId}`, "TARGET_NOT_REACHABLE");
    }
    const routedTargetId = this.resolveRoutableTargetId(targetId);
    const bridge = this.connections.getBridge(routedTargetId, wsClient.connectionId);
    if (!bridge) {
      throw createRelayError(`Target bridge not reachable: ${targetId}`, "TARGET_NOT_REACHABLE");
    }
    return bridge.stream(routedTargetId, method, args);
  }

  private async relayCall(
    callerId: string,
    callerKind: CallerKind,
    targetId: string,
    method: string,
    args: unknown[],
    targetConnectionId?: string,
    meta?: RelayCallMeta
  ): Promise<unknown> {
    const isPanelOrShellTarget = !targetId.startsWith("do:") && !targetId.startsWith("worker:");
    if (isPanelOrShellTarget) {
      const options = relayCallOptions(meta);
      const routedTargetId = this.resolveRoutableTargetId(targetId);
      const wsClient = this.pickRoutableTarget(targetId, targetConnectionId);
      if (wsClient?.ws.readyState === WebSocket.OPEN) {
        const bridge = this.connections.getBridge(routedTargetId, wsClient.connectionId);
        if (bridge) {
          return await bridge.call(routedTargetId, method, args, options);
        }
      }

      if (targetConnectionId) {
        const reconnectedClient = await this.resolveWsRelayTarget(
          routedTargetId,
          targetConnectionId
        );
        const bridge = this.connections.getBridge(routedTargetId, reconnectedClient.connectionId);
        if (!bridge) {
          throw new Error(
            `Target ${targetId}:${targetConnectionId} reconnected but bridge missing`
          );
        }
        return await bridge.call(routedTargetId, method, args, options);
      }

      const outcome = await this.awaitReconnectIfPending(routedTargetId);
      switch (outcome.kind) {
        case "reconnected": {
          const bridge = this.connections.getBridge(routedTargetId, outcome.client.connectionId);
          if (!bridge) {
            throw new Error(`Target ${targetId} reconnected but bridge missing`);
          }
          return await bridge.call(routedTargetId, method, args, options);
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
      return await this.relayToDO(callerId, callerKind, targetId, method, args, meta);
    }

    if (targetId.startsWith("worker:")) {
      return await this.relayToWorker(callerId, callerKind, targetId, method, args, meta);
    }

    throw createRelayError(`Unknown target kind: ${targetId}`, "UNKNOWN_TARGET_KIND");
  }

  private async relayResponse(
    fromId: string,
    targetId: string,
    response: RpcResponse
  ): Promise<void> {
    const client = this.pickRoutableTarget(targetId);
    if (client?.ws.readyState === WebSocket.OPEN) {
      this.sendToWs(client.ws, {
        type: "ws:routed",
        envelope: envelopeForWsDelivery(fromId, "unknown", targetId, response),
      });
      return;
    }
    if (this.sessions.enqueueResponse(targetId, fromId, response)) return;
    throw createRelayError(`Target not reachable: ${targetId}`, "TARGET_NOT_REACHABLE");
  }

  private async relayToDO(
    callerId: string,
    callerKind: CallerKind,
    targetId: string,
    method: string,
    args: unknown[],
    meta?: RelayCallMeta
  ): Promise<unknown> {
    const ref = parseDOTarget(targetId);
    // Assertion-only: the concrete DO entity must exist before dispatch.
    // Method-specific context checks (e.g. subscribeChannel) belong in the
    // DO's own handler, not in the generic relay path. Cross-context calls
    // to shared singletons (panel → GadWorkspaceDO) must pass through.
    const cache = this.deps.entityCache;
    if (cache && !cache.resolveActive(targetId)) {
      throw createRelayError(
        `DO ${targetId} is not registered as an active runtime entity. Call runtime.createEntity first.`,
        "DO_NOT_CREATED"
      );
    }

    const { postToDurableObject } = await import("./workerdRpcRelay.js");

    const dispatch = async () => {
      if (!this.deps.tokenManager || !this.workerdUrl || !this.workerdGatewayToken) {
        throw new Error(
          "Cannot relay to DO: tokenManager, workerdUrl, or workerdGatewayToken not configured"
        );
      }
      const workerdUrl = this.workerdUrl;
      const workerdGatewayToken = this.workerdGatewayToken;
      const workerdDispatchSecret = this.workerdDispatchSecret;
      const callerPanelId =
        callerKind === "panel"
          ? (this.deps.runtimeCoordinator?.getLease(callerId)?.slotId ?? undefined)
          : undefined;
      const result = await postToDurableObject(ref, method, args, {
        workerdUrl,
        workerdGatewayToken,
        ...(workerdDispatchSecret ? { workerdDispatchSecret } : {}),
        callerId,
        callerKind,
        ...(callerPanelId ? { callerPanelId } : {}),
        ...(meta?.requestId ? { requestId: meta.requestId } : {}),
        ...(meta?.idempotencyKey ? { idempotencyKey: meta.idempotencyKey } : {}),
        ...(meta?.readOnly ? { readOnly: true } : {}),
      });
      return result;
    };

    try {
      return await dispatch();
    } catch (err) {
      if (!this.ensureDOFn || !isRetryableDORelayError(err)) throw err;
      console.warn(
        `[RpcServer] DO relay ${targetId}.${method} failed (${err instanceof Error ? err.message : String(err)}), ensuring DO and retrying`
      );
      await this.ensureDOFn(ref.source, ref.className, ref.objectKey);
      return await dispatch();
    }
  }

  private async relayToWorker(
    callerId: string,
    callerKind: CallerKind,
    targetId: string,
    method: string,
    args: unknown[],
    meta?: RelayCallMeta
  ): Promise<unknown> {
    // targetId format: "worker:{workerName}"
    const workerName = targetId.slice(7); // Remove "worker:"
    if (!this.workerdUrl) throw new Error("workerdUrl not configured");

    const caller = { callerId, callerKind };
    const envelope = envelopeFromMessage({
      selfId: callerId,
      from: callerId,
      target: targetId,
      caller,
      ...(meta?.idempotencyKey ? { idempotencyKey: meta.idempotencyKey } : {}),
      ...(meta?.readOnly ? { readOnly: true } : {}),
      message: {
        type: "request",
        requestId: meta?.requestId ?? randomUUID(),
        fromId: callerId,
        method,
        args,
      },
    });

    const url = `${this.workerdUrl}/${workerName}/__rpc`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.workerdGatewayToken
          ? { Authorization: `Bearer ${this.workerdGatewayToken}` }
          : {}),
      },
      body: JSON.stringify(envelope),
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

    const raw = (await res.json()) as { envelope?: RpcEnvelope; message?: RpcMessage } | undefined;
    const responseEnvelope =
      raw && "envelope" in raw ? raw.envelope : (raw as RpcEnvelope | undefined);
    const responseMessage = responseEnvelope?.message as RpcResponse | undefined;
    if (responseMessage && responseMessage.type === "response") {
      if ("error" in responseMessage) {
        const err = new Error(responseMessage.error) as Error & { code?: unknown };
        if (responseMessage.errorCode) err.code = responseMessage.errorCode;
        throw err;
      }
      return responseMessage.result;
    }
    return undefined;
  }

  /**
   * Canonical event delivery used by the `handleRoute` WS path for EVERY target
   * kind (panel/shell fan-out, DO, worker). Events are fire-and-forget: unlike
   * `relayCall`, the panel/shell branch does NOT await a reconnect grace window.
   * A connectionless target throws `TARGET_NOT_REACHABLE` immediately so the
   * drop is SURFACED (logged + `ws:routed-event-error`) rather than swallowed or
   * stalled behind a reconnect that may never come. Keeping every target kind in
   * this one function is what stops a kind (e.g. connectionless DOs) from being
   * "forgotten" by a duplicate inline delivery path.
   *
   * `targetConnectionId`, when supplied, pins delivery to a single connection
   * (e.g. a lease-resolved slot); otherwise the event fans out to every live
   * connection for the caller.
   */
  private async relayEvent(
    fromId: string,
    fromKind: CallerKind,
    targetId: string,
    event: string,
    payload: unknown,
    targetConnectionId?: string
  ): Promise<void> {
    const isPanelOrShellTarget = !targetId.startsWith("do:") && !targetId.startsWith("worker:");
    if (isPanelOrShellTarget) {
      const routedTargetId = this.resolveRoutableTargetId(targetId);
      // Pin to an explicit connection, then a lease-resolved one, else fan out.
      const pinnedConnectionId =
        targetConnectionId ?? this.deps.runtimeCoordinator?.resolveRouteConnection(targetId);
      const wsClients = pinnedConnectionId
        ? [this.getConnection(routedTargetId, pinnedConnectionId)].filter(
            (connection): connection is WsClientState => Boolean(connection)
          )
        : this.getCallerConnections(routedTargetId);
      if (wsClients.length === 0) {
        // Fire-and-forget: no live connection means the event is undeliverable
        // now. Surface it instead of stalling on a reconnect that may never
        // come (the call path keeps its reconnect behavior; events do not).
        throw createRelayError(`Target not reachable: ${targetId}`, "TARGET_NOT_REACHABLE");
      }
      for (const wsClient of wsClients) {
        this.sendToWs(wsClient.ws, {
          type: "ws:routed",
          envelope: envelopeForWsDelivery(fromId, fromKind, routedTargetId, {
            type: "event",
            fromId,
            event,
            payload,
          }),
        });
      }
      return;
    }

    // DO?
    if (targetId.startsWith("do:")) {
      const ref = parseDOTarget(targetId);

      if (!this.deps.tokenManager || !this.workerdUrl || !this.workerdGatewayToken) {
        throw new Error(
          "Cannot relay event to DO: tokenManager, workerdUrl, or workerdGatewayToken not configured"
        );
      }

      const { postEventToDurableObject } = await import("./workerdRpcRelay.js");
      // `fromId`/`fromKind` become the event envelope's caller — the DO's
      // `handleEvent` surfaces it to listeners as `event.caller`.
      await postEventToDurableObject(ref, event, payload, {
        workerdUrl: this.workerdUrl,
        workerdGatewayToken: this.workerdGatewayToken,
        ...(this.workerdDispatchSecret
          ? { workerdDispatchSecret: this.workerdDispatchSecret }
          : {}),
        callerId: fromId,
        callerKind: fromKind,
      });
      return;
    }

    // Worker?
    if (targetId.startsWith("worker:")) {
      const workerName = targetId.slice(7);
      if (!this.workerdUrl) throw new Error("workerdUrl not configured");

      const eventEnvelope = envelopeFromMessage({
        selfId: fromId,
        from: fromId,
        target: targetId,
        caller: { callerId: fromId, callerKind: fromKind },
        message: { type: "event", fromId, event, payload },
      });
      const res = await fetch(`${this.workerdUrl}/${workerName}/__rpc`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.workerdGatewayToken
            ? { Authorization: `Bearer ${this.workerdGatewayToken}` }
            : {}),
        },
        body: JSON.stringify(eventEnvelope),
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

  // Backpressure limits for slow WebSocket consumers. Below the soft limit
  // everything is sent; between soft and hard, broadcast events are dropped
  // (they're best-effort — clients resync via snapshots) while responses and
  // stream frames still go through; past the hard limit the socket is
  // terminated so an unread buffer can't grow without bound.
  private static readonly WS_BACKPRESSURE_SOFT_LIMIT = 16 * 1024 * 1024;
  private static readonly WS_BACKPRESSURE_HARD_LIMIT = 128 * 1024 * 1024;

  private sendToWs(ws: WebSocket, msg: WsServerMessage): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    const buffered = ws.bufferedAmount;
    if (buffered > RpcServer.WS_BACKPRESSURE_HARD_LIMIT) {
      log.warn(
        `WebSocket client buffer exceeded hard limit (${buffered} bytes buffered) — terminating slow consumer`
      );
      ws.terminate();
      return;
    }
    if (buffered > RpcServer.WS_BACKPRESSURE_SOFT_LIMIT && msg.type === "ws:event") {
      return;
    }
    ws.send(JSON.stringify(msg));
  }

  // ===========================================================================
  // Gateway in-process handlers
  // ===========================================================================

  /** Accept a pre-upgraded WebSocket from the gateway (no WSS needed on our side). */
  handleGatewayWsConnection(ws: WebSocket): void {
    this.handleConnection(ws);
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

    for (const timer of this.disconnectTimers.values()) {
      clearTimeout(timer);
    }
    this.disconnectTimers.clear();

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
