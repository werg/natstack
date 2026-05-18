/**
 * CdpBridge — Server-side relay between Playwright CDP clients and the
 * browser extension's chrome.debugger API.
 *
 * Architecture:
 *   Panel (Playwright) → Server CDP WebSocket → Extension WebSocket → chrome.debugger → Tab
 *
 * Two WebSocket paths:
 * - `/api/cdp-bridge` — single extension connection
 * - `/cdp/{browserId}` — per-browser Playwright client connections
 *
 * Both paths authenticate with a first WebSocket message:
 * `{ "type": "natstack:cdp-auth", "token": "..." }`.
 *
 * The client ↔ server protocol is standard CDP (same as Electron's CdpServer),
 * so Playwright connects identically regardless of backend.
 */

import { WebSocket, type WebSocketServer } from "ws";
import type { IncomingMessage } from "http";
import type { Duplex } from "stream";
import { constantTimeStringEqual } from "@natstack/shared/tokenManager";
import { CdpGrantService } from "@natstack/shared/cdpGrants";
import { createDevLogger } from "@natstack/dev-log";
import { assertPresent } from "../lintHelpers";

const log = createDevLogger("CdpBridge");

const NAV_COMMAND_TIMEOUT_MS = 30_000;

interface CdpBridgeOptions {
  adminToken: string;
  cdpGrants?: CdpGrantService;
  canAccessBrowser: (requestingPanelId: string, browserId: string) => boolean;
  panelOwnsBrowser: (requestingPanelId: string, browserId: string) => boolean;
  /** Check if a browserId corresponds to a known panel in the registry. */
  isPanelKnown?: (browserId: string) => boolean;
  port: number;
}

export interface CdpEndpoint {
  wsEndpoint: string;
  token: string;
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

interface ExtensionBridgeMessage {
  type?: string;
  browserId?: string;
  tabId?: number;
  requestId?: string;
  result?: unknown;
  error?: string;
  method?: string;
  params?: unknown;
  sessionId?: string;
}

export class CdpBridge {
  private adminToken: string;
  private cdpGrants: CdpGrantService;
  private canAccessBrowser: (requestingPanelId: string, browserId: string) => boolean;
  private panelOwnsBrowser: (requestingPanelId: string, browserId: string) => boolean;
  private isPanelKnown: (browserId: string) => boolean;
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

  /** Pending browser tab creations: browserId → {resolve, reject} */
  private pendingBrowserCreations = new Map<
    string,
    { resolve: () => void; reject: (e: Error) => void }
  >();

  /** Counter for unique bridge request IDs (shared across CDP and nav) */
  private nextRequestId = 1;

  constructor(options: CdpBridgeOptions) {
    this.adminToken = options.adminToken;
    this.cdpGrants = options.cdpGrants ?? new CdpGrantService();
    this.canAccessBrowser = options.canAccessBrowser;
    this.panelOwnsBrowser = options.panelOwnsBrowser;
    this.isPanelKnown = options.isPanelKnown ?? (() => true);
    this.port = options.port;
  }

  // =========================================================================
  // Public API
  // =========================================================================

  private authenticateConnection(
    ws: WebSocket,
    validate: (token: string) => boolean
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        cleanup();
        ws.close(4001, "CDP auth required");
        resolve(false);
      }, 5_000);
      const cleanup = () => {
        clearTimeout(timer);
        ws.off("message", handleMessage);
        ws.off("close", handleClose);
        ws.off("error", handleClose);
      };
      const handleClose = () => {
        cleanup();
        resolve(false);
      };
      const handleMessage = (data: Buffer) => {
        let parsed: { type?: unknown; token?: unknown };
        try {
          parsed = JSON.parse(data.toString()) as { type?: unknown; token?: unknown };
        } catch {
          cleanup();
          ws.close(4001, "Invalid CDP auth frame");
          resolve(false);
          return;
        }
        if (
          parsed.type !== "natstack:cdp-auth" ||
          typeof parsed.token !== "string" ||
          !validate(parsed.token)
        ) {
          cleanup();
          ws.close(4001, "Invalid CDP token");
          resolve(false);
          return;
        }
        cleanup();
        resolve(true);
      };
      ws.once("message", handleMessage);
      ws.once("close", handleClose);
      ws.once("error", handleClose);
    });
  }

  /**
   * Route WebSocket upgrade requests by URL path.
   */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, wss: WebSocketServer): void {
    const url = new URL(req.url ?? "/", `http://localhost`);
    const pathname = url.pathname;

    if (pathname === "/api/cdp-bridge") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        void this.authenticateConnection(ws, (token) =>
          constantTimeStringEqual(token, this.adminToken)
        ).then((ok) => {
          if (!ok) return;
          this.handleExtensionConnection(ws);
          ws.send(JSON.stringify({ type: "natstack:cdp-auth-ok" }));
        });
      });
    } else if (pathname.startsWith("/cdp/")) {
      const browserId = pathname.slice("/cdp/".length);

      if (!this.browserRegistry.has(browserId)) {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        void this.authenticateConnection(ws, (token) => {
          const grant = this.cdpGrants.redeem(token, browserId);
          if (!grant) return false;
          return this.canAccessBrowser(grant.principalId, browserId);
        }).then((ok) => {
          if (!ok) return;
          this.handleClientConnection(ws, browserId);
          ws.send(JSON.stringify({ type: "natstack:cdp-auth-ok" }));
        });
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
  getCdpEndpoint(browserId: string, requestingPanelId: string): CdpEndpoint | null {
    if (!this.canAccessBrowser(requestingPanelId, browserId)) {
      return null;
    }

    if (!this.browserRegistry.has(browserId)) {
      return null;
    }

    const { token } = this.cdpGrants.grant(requestingPanelId, browserId);
    return {
      wsEndpoint: `ws://127.0.0.1:${this.port}/cdp/${browserId}`,
      token,
    };
  }

  /**
   * Send a navigation command to the extension for a browser tab.
   * Requires owner-only access (direct parent).
   */
  async sendBrowserCommand(
    browserId: string,
    requestingPanelId: string,
    command: string,
    args: unknown[]
  ): Promise<unknown> {
    if (!this.panelOwnsBrowser(requestingPanelId, browserId)) {
      throw new Error(
        `Access denied: only the direct parent can send navigation commands to ${browserId}`
      );
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
        assertPresent(this.extensionWs).send(JSON.stringify(msg));
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
   * Create a new browser tab via extension. Resolves when cdp:register arrives
   * (browser ready for CDP).
   */
  async openBrowserTab(browserId: string, url: string): Promise<void> {
    if (!this.extensionWs || this.extensionWs.readyState !== WebSocket.OPEN) {
      throw new Error("Browser extension not connected");
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingBrowserCreations.delete(browserId);
        reject(new Error("open-tab timed out waiting for cdp:register"));
      }, NAV_COMMAND_TIMEOUT_MS);

      this.pendingBrowserCreations.set(browserId, {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });

      const requestId = String(this.nextRequestId++);
      assertPresent(this.extensionWs).send(
        JSON.stringify({
          type: "nav:command",
          requestId,
          browserId,
          action: "open-tab",
          url,
        })
      );
    });
  }

  /**
   * Open URL in a new tab without CDP tracking (system browser equivalent
   * in headless mode).
   */
  async openExternalTab(url: string): Promise<void> {
    if (!this.extensionWs || this.extensionWs.readyState !== WebSocket.OPEN) {
      throw new Error("Browser extension not connected");
    }

    const requestId = String(this.nextRequestId++);
    const dummyBrowserId = `external-${requestId}`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingNavCommands.delete(requestId);
        reject(new Error("open-external timed out"));
      }, NAV_COMMAND_TIMEOUT_MS);

      this.pendingNavCommands.set(requestId, {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
        timer,
      });

      assertPresent(this.extensionWs).send(
        JSON.stringify({
          type: "nav:command",
          requestId,
          browserId: dummyBrowserId,
          action: "open-external",
          url,
        })
      );
    });
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

    // Reject all pending browser creations
    for (const [browserId, pending] of this.pendingBrowserCreations) {
      pending.reject(new Error("CDP bridge shutting down"));
      this.pendingBrowserCreations.delete(browserId);
    }

    // Flush pending CDP commands with errors
    for (const [requestId, pending] of this.pendingCommands) {
      this.sendErrorToClient(
        pending.ws,
        pending.clientId,
        "CDP bridge shutting down",
        pending.sessionId
      );
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
        this.sendErrorToClient(
          pending.ws,
          pending.clientId,
          "Extension reconnected",
          pending.sessionId
        );
        this.pendingCommands.delete(requestId);
      }
      // Reject pending nav commands
      for (const [requestId, pending] of this.pendingNavCommands) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Extension reconnected"));
        this.pendingNavCommands.delete(requestId);
      }
      // Reject pending browser creations
      for (const [browserId, pending] of this.pendingBrowserCreations) {
        pending.reject(new Error("Extension reconnected"));
        this.pendingBrowserCreations.delete(browserId);
      }
      this.browserRegistry.clear();
      this.extensionWs.close(1000, "Replaced by new extension connection");
    }

    this.extensionWs = ws;
    log.info("Extension connected to CDP bridge");

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString()) as ExtensionBridgeMessage;
        this.handleExtensionMessage(msg);
      } catch (err) {
        log.warn(`Failed to parse extension message: ${err}`);
      }
    });

    ws.on("close", () => {
      if (this.extensionWs === ws) {
        log.info("Extension disconnected from CDP bridge");
        this.extensionWs = null;

        // Flush all pending CDP commands with errors
        for (const [requestId, pending] of this.pendingCommands) {
          this.sendErrorToClient(
            pending.ws,
            pending.clientId,
            "Extension disconnected",
            pending.sessionId
          );
          this.pendingCommands.delete(requestId);
        }

        // Reject all pending nav commands
        for (const [requestId, pending] of this.pendingNavCommands) {
          clearTimeout(pending.timer);
          pending.reject(new Error("Extension disconnected"));
          this.pendingNavCommands.delete(requestId);
        }

        // Reject all pending browser creations
        for (const [browserId, pending] of this.pendingBrowserCreations) {
          pending.reject(new Error("Extension disconnected"));
          this.pendingBrowserCreations.delete(browserId);
        }

        // Clear browser registry (extension owns the tab tracking)
        this.browserRegistry.clear();
      }
    });

    ws.on("error", (err) => {
      log.info(`Extension WebSocket error: ${err}`);
    });
  }

  private handleExtensionMessage(msg: ExtensionBridgeMessage): void {
    switch (msg.type) {
      case "cdp:register": {
        if (typeof msg.browserId !== "string" || typeof msg.tabId !== "number") break;
        // Reject registrations for panels that don't exist (e.g. rolled back
        // after open-tab timeout, or stale mappings from a previous session)
        if (!this.isPanelKnown(msg.browserId)) {
          log.info(`Rejecting cdp:register for unknown panel: ${msg.browserId}`);
          if (this.extensionWs && this.extensionWs.readyState === WebSocket.OPEN) {
            this.extensionWs.send(
              JSON.stringify({
                type: "cdp:register-rejected",
                browserId: msg.browserId,
                tabId: msg.tabId,
              })
            );
          }
          break;
        }
        this.browserRegistry.set(msg.browserId, { tabId: msg.tabId });
        log.info(`Browser registered: ${msg.browserId} (tab ${msg.tabId})`);
        // Resolve pending browser creation if this was an open-tab request
        const pendingCreation = this.pendingBrowserCreations.get(msg.browserId);
        if (pendingCreation) {
          this.pendingBrowserCreations.delete(msg.browserId);
          pendingCreation.resolve();
        }
        break;
      }

      case "cdp:unregister": {
        if (typeof msg.browserId !== "string") break;
        this.browserRegistry.delete(msg.browserId);
        log.info(`Browser unregistered: ${msg.browserId}`);

        // Flush pending commands for this browser
        for (const [requestId, pending] of this.pendingCommands) {
          if (pending.browserId === msg.browserId) {
            this.sendErrorToClient(
              pending.ws,
              pending.clientId,
              "Browser tab closed",
              pending.sessionId
            );
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
        if (typeof msg.requestId !== "string") break;
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
        if (typeof msg.requestId !== "string") break;
        const pending = this.pendingCommands.get(msg.requestId);
        if (pending) {
          this.sendErrorToClient(
            pending.ws,
            pending.clientId,
            msg.error ?? "CDP extension error",
            pending.sessionId
          );
          this.pendingCommands.delete(msg.requestId);
        }
        break;
      }

      case "cdp:event": {
        if (typeof msg.browserId !== "string" || typeof msg.method !== "string") break;
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
        if (typeof msg.requestId !== "string") break;
        const pending = this.pendingNavCommands.get(msg.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          pending.resolve();
          this.pendingNavCommands.delete(msg.requestId);
        }
        break;
      }

      case "nav:error": {
        if (typeof msg.requestId !== "string") break;
        const pending = this.pendingNavCommands.get(msg.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          pending.reject(new Error(msg.error ?? "Navigation failed"));
          this.pendingNavCommands.delete(msg.requestId);
        }
        // Also check pending browser creations (open-tab failures)
        if (typeof msg.browserId === "string") {
          const pendingCreation = this.pendingBrowserCreations.get(msg.browserId);
          if (pendingCreation) {
            this.pendingBrowserCreations.delete(msg.browserId);
            pendingCreation.reject(new Error(msg.error ?? "Navigation failed"));
          }
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
    assertPresent(this.clientConnections.get(browserId)).add(ws);

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
          this.extensionWs.send(
            JSON.stringify({
              type: "cdp:command",
              requestId,
              browserId,
              method: msg.method,
              params: msg.params,
              sessionId: msg.sessionId,
            })
          );
        } catch {
          this.pendingCommands.delete(requestId);
          this.sendErrorToClient(ws, msg.id, "Failed to send to extension", msg.sessionId);
        }
      } catch (err) {
        log.warn(`Failed to parse client message: ${err}`);
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
            this.extensionWs.send(
              JSON.stringify({
                type: "cdp:detach",
                browserId,
              })
            );
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
