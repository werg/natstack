/**
 * RPC WebSocket Server — handles all panel, shell, and worker communication.
 *
 * Replaces Electron IPC with a single WebSocket transport.
 * Auth is unified through TokenManager. Events use a Subscriber interface.
 */

import { WebSocketServer, WebSocket } from "ws";
import { createServer, type Server as HttpServer } from "http";
import { randomUUID } from "crypto";
import type { RpcMessage, RpcRequest } from "@natstack/rpc";
import type {
  WsClientMessage,
  WsServerMessage,
} from "../shared/ws/protocol.js";
import type { StreamTextEvent } from "../shared/types.js";
import type { StreamTarget } from "../main/ai/aiHandler.js";
import type { ToolExecutionResult } from "../main/ai/claudeCodeToolProxy.js";
import { TOOL_EXECUTION_TIMEOUT_MS } from "../shared/constants.js";
import { findAvailablePortForService } from "../main/portUtils.js";
import {
  parseServiceMethod,
  getServiceDispatcher,
  type CallerKind,
  type ServiceContext,
} from "../main/serviceDispatcher.js";
import { checkServiceAccess } from "../main/servicePolicy.js";
import type { TokenManager } from "../main/tokenManager.js";

/** Server-side state for a connected WS client */
export interface WsClientState {
  ws: WebSocket;
  callerId: string;
  callerKind: CallerKind;
  authenticated: boolean;
}

interface PendingToolCall {
  resolve: (result: ToolExecutionResult) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  clientWs: WebSocket;
}

interface PanelManagerLike {
  getPanel(panelId: string): unknown | undefined;
  findParentId(childId: string): string | null;
  isDescendantOf(childId: string, ancestorId: string): boolean;
}

export class RpcServer {
  private wss: WebSocketServer | null = null;
  private httpServer: HttpServer | null = null;
  private port: number | null = null;

  // Connection tracking
  private clients = new Map<WebSocket, WsClientState>();
  private callerToClient = new Map<string, WsClientState>();
  private pendingToolCalls = new Map<string, PendingToolCall>();

  constructor(
    private deps: {
      tokenManager: TokenManager;
      panelManager?: PanelManagerLike;
    }
  ) {}

  async start(): Promise<number> {
    const { port, server: tempServer } = await findAvailablePortForService("rpc");
    await new Promise<void>((resolve) => tempServer.close(() => resolve()));

    this.httpServer = createServer();
    this.wss = new WebSocketServer({ server: this.httpServer });

    this.wss.on("connection", (ws) => this.handleConnection(ws));

    // Register revocation-driven disconnect
    this.deps.tokenManager.onRevoke((callerId) => {
      const client = this.callerToClient.get(callerId);
      if (!client) return;
      client.ws.close(4001, "Token revoked");
    });

    await new Promise<void>((resolve, reject) => {
      this.httpServer!.on("error", reject);
      this.httpServer!.listen(port, "127.0.0.1", () => resolve());
    });

    this.port = port;
    return port;
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
      callerId = entry.callerId;
      callerKind = entry.callerKind;
    }

    // Single-active-connection enforcement for non-admin callers
    if (callerKind !== "server") {
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

    // Send auth result
    const authResult: WsServerMessage = {
      type: "ws:auth-result",
      success: true,
      callerId,
      callerKind,
    };
    ws.send(JSON.stringify(authResult));

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
        void this.handleRpc(client, msg.message);
        break;
      case "ws:tool-result":
        this.handleToolResult(msg.callId, msg.result as ToolExecutionResult);
        break;
      case "ws:panel-rpc":
        this.handlePanelRpc(client, msg.targetId, msg.message);
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
      checkServiceAccess(service, client.callerKind);
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

    const dispatcher = getServiceDispatcher();

    try {
      const result = await dispatcher.dispatch(ctx, service, method, request.args);
      this.sendToWs(client.ws, {
        type: "ws:rpc",
        message: { type: "response", requestId: request.requestId, result },
      });
    } catch (error) {
      this.sendToWs(client.ws, {
        type: "ws:rpc",
        message: {
          type: "response",
          requestId: request.requestId,
          error: error instanceof Error ? error.message : String(error),
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

  private handlePanelRpc(client: WsClientState, targetId: string, message: RpcMessage): void {
    if (!this.deps.panelManager) return;

    const pm = this.deps.panelManager;

    // Validate parent/child relationship
    const parentId = pm.findParentId(targetId);
    const isParentOfTarget = parentId === client.callerId;
    const isChildOfTarget = pm.findParentId(client.callerId) === targetId;

    if (!isParentOfTarget && !isChildOfTarget) {
      // Check ancestor relationship
      if (!pm.isDescendantOf(targetId, client.callerId) &&
          !pm.isDescendantOf(client.callerId, targetId)) {
        return; // Silently drop unauthorized panel-to-panel messages
      }
    }

    const targetClient = this.callerToClient.get(targetId);
    if (!targetClient || targetClient.ws.readyState !== WebSocket.OPEN) return;

    this.sendToWs(targetClient.ws, {
      type: "ws:panel-rpc-delivery",
      fromId: client.callerId,
      message,
    });
  }

  private handleClose(client: WsClientState): void {
    // Only remove from callerToClient if this client is still the current one
    // (a replacement connection may have already overwritten it)
    const current = this.callerToClient.get(client.callerId);
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
  }

  private cleanupClient(client: WsClientState): void {
    const current = this.callerToClient.get(client.callerId);
    if (current === client) {
      this.callerToClient.delete(client.callerId);
    }
    this.clients.delete(client.ws);
  }

  // ===========================================================================
  // Public API for server-side pushes
  // ===========================================================================

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
  // Internal helpers
  // ===========================================================================

  private sendToWs(ws: WebSocket, msg: WsServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  /** Shut down the server */
  async stop(): Promise<void> {
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
