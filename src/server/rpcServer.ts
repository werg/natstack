/**
 * RPC WebSocket Server — handles all panel, shell, and worker communication.
 *
 * Replaces Electron IPC with a single WebSocket transport.
 * Auth is unified through TokenManager. Events use a Subscriber interface.
 */

import { WebSocketServer, WebSocket } from "ws";
import { createServer, type Server as HttpServer } from "http";
import { randomUUID } from "crypto";
import { createRpcBridge, type RpcBridge, type RpcMessage, type RpcRequest } from "@natstack/rpc";
import { createWsServerTransport, type WsServerTransportInternal } from "./wsServerTransport.js";
import type {
  WsClientMessage,
  WsServerMessage,
} from "@natstack/shared/ws/protocol";
import type { StreamTextEvent } from "@natstack/shared/types";
import type { StreamTarget } from "@natstack/shared/ai/aiHandler";
import type { ToolExecutionResult } from "@natstack/shared/ai/claudeAgentToolProxy";
import { TOOL_EXECUTION_TIMEOUT_MS } from "@natstack/shared/constants";
import type { WsClientInfo } from "@natstack/shared/serviceDispatcher";
import { findServicePort } from "@natstack/port-utils";
import {
  parseServiceMethod,

  ServiceDispatcher,
  type CallerKind,
  type ServiceContext,
} from "@natstack/shared/serviceDispatcher";
import { checkServiceAccess } from "@natstack/shared/servicePolicy";
import type { TokenManager } from "@natstack/shared/tokenManager";

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

export class RpcServer {
  private wss: WebSocketServer | null = null;
  private httpServer: HttpServer | null = null;
  private port: number | null = null;
  private workerdUrl: string | null = null;

  // Connection tracking
  private clients = new Map<WebSocket, WsClientState>();
  private callerToClient = new Map<string, WsClientState>();
  private pendingToolCalls = new Map<string, PendingToolCall>();
  private disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // Per-client RPC bridges for server→client calls
  private clientBridges = new Map<string, RpcBridge>();
  private clientTransports = new Map<string, WsServerTransportInternal>();

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
    return port;
  }

  /** Set the port (used when gateway owns the socket). */
  setPort(port: number): void {
    this.port = port;
  }

  getPort(): number | null {
    return this.port;
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

    // Notify auth callback (e.g., for HarnessManager bridge resolution)
    this.deps.onClientAuthenticate?.(callerId, callerKind);

    // Set up message handling
    ws.on("message", (data) => this.handleMessage(client, data));
    ws.on("close", () => this.handleClose(client));
  }

  private handleMessage(client: WsClientState, data: Buffer | ArrayBuffer | Buffer[]): void {
    let msg: WsClientMessage;
    try {
      msg = JSON.parse(data.toString()) as WsClientMessage;
    } catch {
      return; // Ignore malformed messages
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

  /**
   * Route a message from one caller to another.
   *
   * Shell-owned panel trees are no longer persisted on the server, so the
   * server acts purely as a relay for non-service target IDs.
   */
  private handleRoute(client: WsClientState, targetId: string, message: RpcMessage): void {
    this.checkRelayAuth(client.callerId, client.callerKind, targetId);

    const targetClient = this.callerToClient.get(targetId);
    if (!targetClient || targetClient.ws.readyState !== WebSocket.OPEN) {
      // Target not connected via WS — try HTTP relay for workers/DOs
      if (this.workerdUrl && (targetId.startsWith("do:") || targetId.startsWith("worker:"))) {
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
              this.sendToWs(client.ws, {
                type: "ws:routed",
                fromId: targetId,
                message: {
                  type: "response",
                  requestId,
                  error: err instanceof Error ? err.message : String(err),
                },
              });
            },
          );
        } else if (message.type === "event") {
          const { fromId: eventFromId, event, payload } = message;
          void this.relayEvent(eventFromId ?? client.callerId, targetId, event, payload);
        }
      }
      return;
    }

    this.sendToWs(targetClient.ws, {
      type: "ws:routed",
      fromId: client.callerId,
      message,
    });
  }

  private handleClose(client: WsClientState): void {
    // Only remove from callerToClient if this client is still the current one
    // (a replacement connection may have already overwritten it — code 4002)
    const current = this.callerToClient.get(client.callerId);
    const wasReplaced = current !== client;
    if (current === client) {
      this.callerToClient.delete(client.callerId);
    }
    this.clients.delete(client.ws);

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

    const timer = setTimeout(() => {
      this.disconnectTimers.delete(client.callerId);
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
  // StreamTarget factory
  // ===========================================================================

  /** Create a StreamTarget that sends AI stream data over WebSocket */
  createWsStreamTarget(client: WsClientState, streamId: string): StreamTarget {
    const ws = client.ws;

    const sendChunk = (event: StreamTextEvent): void => {
      if (ws.readyState === WebSocket.OPEN) {
        this.sendToWs(ws, { type: "ws:stream-chunk", streamId, chunk: event });
      }
    };

    const sendEnd = (): void => {
      if (ws.readyState === WebSocket.OPEN) {
        this.sendToWs(ws, { type: "ws:stream-end", streamId });
      }
    };

    const executeTool = (
      toolName: string,
      args: Record<string, unknown>
    ): Promise<ToolExecutionResult> => {
      if (ws.readyState !== WebSocket.OPEN) {
        return Promise.reject(new Error("Client is not available"));
      }

      const callId = randomUUID();

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.pendingToolCalls.delete(callId);
          reject(new Error(`Tool execution timed out: ${toolName}`));
        }, TOOL_EXECUTION_TIMEOUT_MS);

        this.pendingToolCalls.set(callId, { resolve, reject, timeout, clientWs: ws });

        this.sendToWs(ws, {
          type: "ws:tool-exec",
          callId,
          streamId,
          toolName,
          args,
        });
      });
    };

    return {
      targetId: client.callerId,
      isAvailable: () => ws.readyState === WebSocket.OPEN,
      sendChunk,
      sendEnd,
      executeTool,
      onUnavailable: (listener) => {
        ws.on("close", listener);
        return () => ws.off("close", listener);
      },
    };
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
      this.checkRelayAuth(callerId, callerKind, targetId);
      return await this.relayCall(callerId, targetId, method, args);
    }

    // Relay event to a target
    if (type === "emit") {
      const event = body["event"] as string;
      const payload = body["payload"];
      const fromId = (body["fromId"] as string) ?? callerId;
      if (!targetId) throw new Error("Missing targetId for emit");
      this.checkRelayAuth(callerId, callerKind, targetId);
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
  private checkRelayAuth(callerId: string, callerKind: CallerKind, targetId: string): void {
    if (callerKind !== "panel") return;
    if (targetId === callerId) return;
    if (targetId.startsWith("do:") || targetId.startsWith("worker:")) return;

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
      throw new Error(`Panel ${callerId} cannot relay to unrelated panel ${targetId}`);
    }
  }

  private async relayCall(callerId: string, targetId: string, method: string, args: unknown[]): Promise<unknown> {
    // Target is a connected WS client? Send via WebSocket bridge.
    const wsClient = this.callerToClient.get(targetId);
    if (wsClient?.ws.readyState === WebSocket.OPEN) {
      const bridge = this.clientBridges.get(targetId);
      if (bridge) {
        return await bridge.call(targetId, method, ...args);
      }
    }

    // Target is a DO? Relay via postToDOWithToken.
    if (targetId.startsWith("do:")) {
      return await this.relayToDO(callerId, targetId, method, args);
    }

    // Target is a worker? POST to /{workerName}/__rpc
    if (targetId.startsWith("worker:")) {
      return await this.relayToWorker(targetId, method, args);
    }

    throw new Error(`Target not reachable: ${targetId}`);
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
      const text = await res.text().catch(() => "");
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
    // WS client?
    const wsClient = this.callerToClient.get(targetId);
    if (wsClient?.ws.readyState === WebSocket.OPEN) {
      this.sendToWs(wsClient.ws, {
        type: "ws:routed",
        fromId,
        message: { type: "event", fromId, event, payload },
      });
      return;
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

      try {
        const res = await fetch(`${this.workerdUrl}/${workerName}/__rpc`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "emit", event, payload, fromId }),
        });
        if (!res.ok) {
          console.warn(`Event relay to ${targetId} failed (${res.status})`);
        }
      } catch (err) {
        console.warn(`Event relay to ${targetId} failed:`, err);
      }
      return;
    }

    // Silent drop for unreachable targets (matches WS routing behavior)
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
