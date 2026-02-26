/**
 * CdpBridge — Server-side relay between Playwright CDP clients and the
 * browser extension's chrome.debugger API.
 *
 * Architecture:
 *   Panel (Playwright) → Server CDP WebSocket → Extension WebSocket → chrome.debugger → Tab
 *
 * Two WebSocket paths:
 * - `/api/cdp-bridge?token={adminToken}` — single extension connection
 * - `/cdp/{browserId}?token={panelToken}` — per-browser Playwright client connections
 *
 * The client ↔ server protocol is standard CDP (same as Electron's CdpServer),
 * so Playwright connects identically regardless of backend.
 */

import { WebSocket, type WebSocketServer } from "ws";
import type { IncomingMessage } from "http";
import type { Duplex } from "stream";
import type { TokenManager } from "../main/tokenManager.js";
import { createDevLogger } from "../main/devLog.js";

const log = createDevLogger("CdpBridge");

const NAV_COMMAND_TIMEOUT_MS = 30_000;

interface CdpBridgeOptions {
  tokenManager: TokenManager;
  adminToken: string;
  canAccessBrowser: (requestingPanelId: string, browserId: string) => boolean;
  panelOwnsBrowser: (requestingPanelId: string, browserId: string) => boolean;
  port: number;
}

interface PendingCommand {
  ws: WebSocket;
  clientId: number;
  browserId: string;
  sessionId?: string;
}

interface PendingNavCommand {
  resolve: (value?: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class CdpBridge {
  private tokenManager: TokenManager;
  private adminToken: string;
  private canAccessBrowser: (requestingPanelId: string, browserId: string) => boolean;
  private panelOwnsBrowser: (requestingPanelId: string, browserId: string) => boolean;
  private port: number;

  /** Extension WebSocket connection (single connection, one extension at a time) */
  private extensionWs: WebSocket | null = null;

  /** Registered browsers from extension: browserId → {tabId} */
  private browserRegistry = new Map<string, { tabId: number }>();

  /** Active client connections: browserId → Set<WebSocket> */
  private clientConnections = new Map<string, Set<WebSocket>>();

  /** Pending CDP commands: requestId → pending info */
  private pendingCommands = new Map<string, PendingCommand>();

  /** Pending navigation commands: requestId → {resolve, reject, timer} */
  private pendingNavCommands = new Map<string, PendingNavCommand>();

  /** Counter for unique bridge request IDs (shared across CDP and nav) */
  private nextRequestId = 1;

  constructor(options: CdpBridgeOptions) {
    this.tokenManager = options.tokenManager;
    this.adminToken = options.adminToken;
    this.canAccessBrowser = options.canAccessBrowser;
    this.panelOwnsBrowser = options.panelOwnsBrowser;
    this.port = options.port;
  }

  // =========================================================================
  // Public API
  // =========================================================================

  /**
   * Route WebSocket upgrade requests by URL path.
   */
  handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    wss: WebSocketServer,
  ): void {
    const url = new URL(req.url ?? "/", `http://localhost`);
    const pathname = url.pathname;

    if (pathname === "/api/cdp-bridge") {
      // Extension connection
      const token = url.searchParams.get("token");
      if (token !== this.adminToken) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        this.handleExtensionConnection(ws);
      });
    } else if (pathname.startsWith("/cdp/")) {
      // Client connection
      const browserId = pathname.slice("/cdp/".length);
      const token = url.searchParams.get("token");

      if (!token) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      const entry = this.tokenManager.validateToken(token);
      if (!entry) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      const panelId = entry.callerId;

      if (!this.canAccessBrowser(panelId, browserId)) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }

      if (!this.browserRegistry.has(browserId)) {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        this.handleClientConnection(ws, browserId);
      });
    } else {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
    }
  }

  /**
   * Get a CDP WebSocket endpoint URL for a browser.
   * Requires ancestry-based access (parent or ancestor).
   */
  getCdpEndpoint(browserId: string, requestingPanelId: string): string | null {
    if (!this.canAccessBrowser(requestingPanelId, browserId)) {
      return null;
    }

    if (!this.browserRegistry.has(browserId)) {
      return null;
    }

    const token = this.tokenManager.getToken(requestingPanelId);
    return `ws://127.0.0.1:${this.port}/cdp/${browserId}?token=${token}`;
  }

  /**
   * Send a navigation command to the extension for a browser tab.
   * Requires owner-only access (direct parent).
   */
  async sendBrowserCommand(
    browserId: string,
    requestingPanelId: string,
    command: string,
    args: unknown[],
  ): Promise<unknown> {
    if (!this.panelOwnsBrowser(requestingPanelId, browserId)) {
      throw new Error(`Access denied: only the direct parent can send navigation commands to ${browserId}`);
    }

    if (!this.extensionWs || this.extensionWs.readyState !== WebSocket.OPEN) {
      throw new Error("Browser extension not connected");
    }

    if (!this.browserRegistry.has(browserId)) {
      throw new Error(`Browser not found: ${browserId}`);
    }

    const requestId = String(this.nextRequestId++);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingNavCommands.delete(requestId);
        reject(new Error(`Navigation command timed out: ${command}`));
      }, NAV_COMMAND_TIMEOUT_MS);

      this.pendingNavCommands.set(requestId, { resolve, reject, timer });

      const msg: Record<string, unknown> = {
        type: "nav:command",
        requestId,
        browserId,
        action: command,
      };

      // navigate takes a URL argument
      if (command === "navigate" && args.length > 0) {
        msg["url"] = args[0];
      }

      try {
        this.extensionWs!.send(JSON.stringify(msg));
      } catch (err) {
        clearTimeout(timer);
        this.pendingNavCommands.delete(requestId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Check if the browser extension is currently connected.
   */
  isExtensionConnected(): boolean {
    return this.extensionWs !== null && this.extensionWs.readyState === WebSocket.OPEN;
  }

  /**
   * Shut down the CDP bridge: close all connections, reject pending commands.
   */
  async stop(): Promise<void> {
    // Reject all pending nav commands
    for (const [requestId, pending] of this.pendingNavCommands) {
      clearTimeout(pending.timer);
      pending.reject(new Error("CDP bridge shutting down"));
      this.pendingNavCommands.delete(requestId);
    }

    // Flush pending CDP commands with errors
    for (const [requestId, pending] of this.pendingCommands) {
      this.sendErrorToClient(pending.ws, pending.clientId, "CDP bridge shutting down", pending.sessionId);
      this.pendingCommands.delete(requestId);
    }

    // Close all client connections
    for (const [, connections] of this.clientConnections) {
      for (const ws of connections) {
        ws.close(1000, "CDP bridge shutting down");
      }
    }
    this.clientConnections.clear();

    // Close extension connection
    if (this.extensionWs) {
      this.extensionWs.close(1000, "CDP bridge shutting down");
      this.extensionWs = null;
    }

    this.browserRegistry.clear();
    log.info("CdpBridge stopped");
  }

  // =========================================================================
  // Extension connection handling
  // =========================================================================

  private handleExtensionConnection(ws: WebSocket): void {
    // Only one extension connection at a time — flush pending state before replacing
    if (this.extensionWs) {
      // Flush pending CDP commands (no timeout, would hang forever)
      for (const [requestId, pending] of this.pendingCommands) {
        this.sendErrorToClient(pending.ws, pending.clientId, "Extension reconnected", pending.sessionId);
        this.pendingCommands.delete(requestId);
      }
      // Reject pending nav commands
      for (const [requestId, pending] of this.pendingNavCommands) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Extension reconnected"));
        this.pendingNavCommands.delete(requestId);
      }
      this.browserRegistry.clear();
      this.extensionWs.close(1000, "Replaced by new extension connection");
    }

    this.extensionWs = ws;
    log.info("Extension connected to CDP bridge");

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        this.handleExtensionMessage(msg);
      } catch (err) {
        log.info(`Failed to parse extension message: ${err}`);
      }
    });

    ws.on("close", () => {
      if (this.extensionWs === ws) {
        log.info("Extension disconnected from CDP bridge");
        this.extensionWs = null;

        // Flush all pending CDP commands with errors
        for (const [requestId, pending] of this.pendingCommands) {
          this.sendErrorToClient(pending.ws, pending.clientId, "Extension disconnected", pending.sessionId);
          this.pendingCommands.delete(requestId);
        }

        // Reject all pending nav commands
        for (const [requestId, pending] of this.pendingNavCommands) {
          clearTimeout(pending.timer);
          pending.reject(new Error("Extension disconnected"));
          this.pendingNavCommands.delete(requestId);
        }

        // Clear browser registry (extension owns the tab tracking)
        this.browserRegistry.clear();
      }
    });

    ws.on("error", (err) => {
      log.info(`Extension WebSocket error: ${err}`);
    });
  }

  private handleExtensionMessage(msg: any): void {
    switch (msg.type) {
      case "cdp:register": {
        this.browserRegistry.set(msg.browserId, { tabId: msg.tabId });
        log.info(`Browser registered: ${msg.browserId} (tab ${msg.tabId})`);
        break;
      }

      case "cdp:unregister": {
        this.browserRegistry.delete(msg.browserId);
        log.info(`Browser unregistered: ${msg.browserId}`);

        // Flush pending commands for this browser
        for (const [requestId, pending] of this.pendingCommands) {
          if (pending.browserId === msg.browserId) {
            this.sendErrorToClient(pending.ws, pending.clientId, "Browser tab closed", pending.sessionId);
            this.pendingCommands.delete(requestId);
          }
        }

        // Close client connections for this browser
        const connections = this.clientConnections.get(msg.browserId);
        if (connections) {
          for (const ws of connections) {
            ws.close(1000, "Browser tab closed");
          }
          this.clientConnections.delete(msg.browserId);
        }
        break;
      }

      case "cdp:result": {
        const pending = this.pendingCommands.get(msg.requestId);
        if (pending) {
          const response: Record<string, unknown> = { id: pending.clientId, result: msg.result };
          if (pending.sessionId) response["sessionId"] = pending.sessionId;
          if (pending.ws.readyState === WebSocket.OPEN) {
            pending.ws.send(JSON.stringify(response));
          }
          this.pendingCommands.delete(msg.requestId);
        }
        break;
      }

      case "cdp:error": {
        const pending = this.pendingCommands.get(msg.requestId);
        if (pending) {
          this.sendErrorToClient(pending.ws, pending.clientId, msg.error, pending.sessionId);
          this.pendingCommands.delete(msg.requestId);
        }
        break;
      }

      case "cdp:event": {
        // Broadcast CDP event to ALL client connections for this browser
        const connections = this.clientConnections.get(msg.browserId);
        if (connections) {
          const event: Record<string, unknown> = { method: msg.method, params: msg.params };
          if (msg.sessionId) event["sessionId"] = msg.sessionId;
          const eventStr = JSON.stringify(event);
          for (const ws of connections) {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(eventStr);
            }
          }
        }
        break;
      }

      case "nav:result": {
        const pending = this.pendingNavCommands.get(msg.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          pending.resolve();
          this.pendingNavCommands.delete(msg.requestId);
        }
        break;
      }

      case "nav:error": {
        const pending = this.pendingNavCommands.get(msg.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          pending.reject(new Error(msg.error));
          this.pendingNavCommands.delete(msg.requestId);
        }
        break;
      }
    }
  }

  // =========================================================================
  // Client connection handling
  // =========================================================================

  private handleClientConnection(ws: WebSocket, browserId: string): void {
    // Track connection
    if (!this.clientConnections.has(browserId)) {
      this.clientConnections.set(browserId, new Set());
    }
    this.clientConnections.get(browserId)!.add(ws);

    log.info(`Client connected for browser ${browserId}`);

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString()) as {
          id: number;
          method: string;
          params?: Record<string, unknown>;
          sessionId?: string;
        };

        if (!this.extensionWs || this.extensionWs.readyState !== WebSocket.OPEN) {
          this.sendErrorToClient(ws, msg.id, "Extension not connected", msg.sessionId);
          return;
        }

        const requestId = String(this.nextRequestId++);
        this.pendingCommands.set(requestId, {
          ws,
          clientId: msg.id,
          browserId,
          sessionId: msg.sessionId,
        });

        try {
          this.extensionWs.send(JSON.stringify({
            type: "cdp:command",
            requestId,
            browserId,
            method: msg.method,
            params: msg.params,
            sessionId: msg.sessionId,
          }));
        } catch (sendErr) {
          this.pendingCommands.delete(requestId);
          this.sendErrorToClient(ws, msg.id, "Failed to send to extension", msg.sessionId);
        }
      } catch (err) {
        log.info(`Failed to parse client message: ${err}`);
      }
    });

    ws.on("close", () => {
      log.info(`Client disconnected for browser ${browserId}`);

      // Remove from tracked connections
      const connections = this.clientConnections.get(browserId);
      if (connections) {
        connections.delete(ws);
        if (connections.size === 0) {
          this.clientConnections.delete(browserId);

          // Last connection closed — tell extension to detach debugger
          if (this.extensionWs && this.extensionWs.readyState === WebSocket.OPEN) {
            this.extensionWs.send(JSON.stringify({
              type: "cdp:detach",
              browserId,
            }));
          }
        }
      }

      // Clean up pending commands for this client
      for (const [requestId, pending] of this.pendingCommands) {
        if (pending.ws === ws) {
          this.pendingCommands.delete(requestId);
        }
      }
    });

    ws.on("error", (err) => {
      log.info(`Client WebSocket error for browser ${browserId}: ${err}`);
    });
  }

  // =========================================================================
  // Helpers
  // =========================================================================

  private sendErrorToClient(ws: WebSocket, id: number, message: string, sessionId?: string): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    const response: Record<string, unknown> = { id, error: { message } };
    if (sessionId) response["sessionId"] = sessionId;
    ws.send(JSON.stringify(response));
  }
}
