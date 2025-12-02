import { WebSocketServer, WebSocket } from "ws";
import { webContents } from "electron";
import * as http from "http";
import { URL } from "url";
import { findAvailablePortForService } from "./portUtils.js";
import { getTokenManager, type TokenManager } from "./tokenManager.js";

/**
 * CDP WebSocket server for browser panel automation.
 * Uses the global TokenManager for authentication.
 *
 * This server allows panels/workers to connect via WebSocket and send CDP commands
 * to browser panels they own. The server forwards commands to Electron's
 * webContents.debugger API.
 *
 * Security model:
 * - Each panel/worker gets a unique token (shared via global TokenManager)
 * - Only the parent that created a browser can get its CDP endpoint
 * - Token is validated on WebSocket connection
 * - Multiple connections to the same browser are supported (e.g., reconnects)
 */
export class CdpServer {
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private actualPort: number | null = null;

  // Global token manager for authentication
  private tokenManager: TokenManager;

  // browserId -> webContentsId
  private browserRegistry = new Map<string, number>();
  // panelId -> Set<browserId> (which browser children this panel owns)
  private panelBrowsers = new Map<string, Set<string>>();
  // browserId -> Set<WebSocket> (active connections, supports multiple per browser)
  private activeConnections = new Map<string, Set<WebSocket>>();
  // browserId -> debugger attached flag
  private debuggerAttached = new Map<string, boolean>();
  // browserId -> debugger attach in progress (prevents race condition)
  private debuggerAttaching = new Map<string, Promise<void>>();

  constructor() {
    this.tokenManager = getTokenManager();
  }

  /**
   * Register a browser panel for CDP access.
   * This is idempotent - multiple calls with the same browserId will update the webContentsId.
   * @param browserId - The browser panel's ID
   * @param webContentsId - The webContents ID for the browser's webview
   * @param parentPanelId - The parent panel that created this browser
   */
  registerBrowser(browserId: string, webContentsId: number, parentPanelId: string): void {
    const existingWebContentsId = this.browserRegistry.get(browserId);

    // Skip if already registered with same webContentsId
    if (existingWebContentsId === webContentsId) {
      return;
    }

    // Log only on first registration or if webContentsId changed
    if (existingWebContentsId !== undefined) {
      console.log(
        `[CdpServer] Browser ${browserId} webContents changed: ${existingWebContentsId} -> ${webContentsId}`
      );
    } else {
      console.log(
        `[CdpServer] Registered browser ${browserId} (webContents ${webContentsId}) for parent ${parentPanelId}`
      );
    }

    this.browserRegistry.set(browserId, webContentsId);

    // Track which panel owns this browser
    if (!this.panelBrowsers.has(parentPanelId)) {
      this.panelBrowsers.set(parentPanelId, new Set());
    }
    this.panelBrowsers.get(parentPanelId)!.add(browserId);
  }

  /**
   * Unregister a browser panel when it's destroyed.
   */
  unregisterBrowser(browserId: string): void {
    this.browserRegistry.delete(browserId);

    // Remove from parent's browser set
    for (const [panelId, browsers] of this.panelBrowsers) {
      if (browsers.has(browserId)) {
        browsers.delete(browserId);
        if (browsers.size === 0) {
          this.panelBrowsers.delete(panelId);
        }
        break;
      }
    }

    // Close all active connections to this browser
    const connections = this.activeConnections.get(browserId);
    if (connections) {
      for (const ws of connections) {
        ws.close(1000, "Browser closed");
      }
      this.activeConnections.delete(browserId);
    }

    // Detach debugger if attached
    this.debuggerAttached.delete(browserId);

    console.log(`[CdpServer] Unregistered browser ${browserId}`);
  }

  /**
   * Revoke access when a panel is destroyed.
   * Cleans up browser ownership tracking.
   */
  revokeTokenForPanel(panelId: string): void {
    // Clean up browser ownership (tokens are managed by GitAuthManager)
    this.panelBrowsers.delete(panelId);
  }

  /**
   * Check if a panel can access a browser (direct parent or tree ancestor).
   * Panel hierarchy format: tree/root, tree/root/child1, tree/root/child1/child2, etc.
   * A panel can access a browser if:
   * - It directly owns the browser, OR
   * - It's a tree ancestor of the browser's owner
   */
  private canAccessBrowser(panelId: string, browserId: string): boolean {
    // Check direct ownership first
    const ownedBrowsers = this.panelBrowsers.get(panelId);
    if (ownedBrowsers?.has(browserId)) {
      console.log(`[CDP Access] Direct ownership: panel ${panelId} owns ${browserId}`);
      return true;
    }

    // Check if panelId is a tree ancestor of any owner of this browser
    // (i.e., if an owner's panel ID starts with panelId/)
    for (const [ownerId, browsers] of this.panelBrowsers) {
      if (browsers.has(browserId)) {
        // Found the owner, check if requesting panel is an ancestor
        console.log(`[CDP Access] Browser ${browserId} owned by ${ownerId}, checking ancestor ${panelId}`);
        if (ownerId.startsWith(panelId + "/")) {
          console.log(`[CDP Access] Granted: ${panelId} is ancestor of ${ownerId}`);
          return true;
        }
      }
    }

    console.log(`[CDP Access] Denied: ${panelId} has no access to ${browserId}. panelBrowsers:`, Array.from(this.panelBrowsers.entries()).map(([id, set]) => `${id}->[${Array.from(set).join(",")}]`));
    return false;
  }

  getCdpEndpoint(browserId: string, requestingPanelId: string): string | null {
    // Verify the requesting panel can access this browser (direct parent or tree ancestor)
    if (!this.canAccessBrowser(requestingPanelId, browserId)) {
      return null; // Access denied
    }

    // Get or create token via global token manager
    const token = this.tokenManager.getOrCreateToken(requestingPanelId);
    return `ws://localhost:${this.getPort()}/${browserId}?token=${token}`;
  }

  /**
   * Get the webContents for a browser panel (for navigation control).
   * Returns null if the browser is not registered.
   */
  getBrowserWebContents(browserId: string): Electron.WebContents | null {
    const webContentsId = this.browserRegistry.get(browserId);
    if (webContentsId === undefined) {
      return null;
    }
    return webContents.fromId(webContentsId) ?? null;
  }

  /**
   * Check if a panel owns a specific browser.
   * Used for authorization checks in IPC handlers.
   */
  panelOwnsBrowser(panelId: string, browserId: string): boolean {
    const ownedBrowsers = this.panelBrowsers.get(panelId);
    return ownedBrowsers?.has(browserId) ?? false;
  }

  async start(): Promise<number> {
    // Find and reserve port atomically (avoids TOCTOU race)
    const { port, server: tempServer } = await findAvailablePortForService("cdp");

    // Close temp server and immediately bind our real server to the same port
    await new Promise<void>((resolve) => tempServer.close(() => resolve()));

    this.server = http.createServer();
    this.wss = new WebSocketServer({ server: this.server });

    this.wss.on("connection", (ws: WebSocket, req: http.IncomingMessage) => {
      void this.handleConnection(ws, req);
    });

    return new Promise((resolve, reject) => {
      this.server!.on("error", reject);
      this.server!.listen(port, () => {
        this.actualPort = port;
        console.log(`[CdpServer] Started on ws://localhost:${port}`);
        resolve(port);
      });
    });
  }

  private async handleConnection(ws: WebSocket, req: http.IncomingMessage): Promise<void> {
    const url = new URL(req.url!, `http://localhost`);
    const browserId = url.pathname.slice(1); // Remove leading /
    const token = url.searchParams.get("token");

    // Validate token
    if (!token) {
      ws.close(4001, "Token required");
      return;
    }

    // Validate token and get panel ID
    const panelId = this.tokenManager.validateToken(token);
    if (!panelId) {
      ws.close(4001, "Invalid token");
      return;
    }

    // Validate this panel can access the browser (direct parent or tree ancestor)
    if (!this.canAccessBrowser(panelId, browserId)) {
      ws.close(4003, "Access denied to this browser");
      return;
    }

    // Get webContents
    const webContentsId = this.browserRegistry.get(browserId);
    if (!webContentsId) {
      ws.close(4004, "Browser not found");
      return;
    }

    const contents = webContents.fromId(webContentsId);
    if (!contents) {
      ws.close(4004, "Browser webContents not found");
      return;
    }

    console.log(`[CdpServer] Client connected for browser ${browserId} from panel ${panelId}`);

    // Track this connection (supports multiple connections per browser)
    if (!this.activeConnections.has(browserId)) {
      this.activeConnections.set(browserId, new Set());
    }
    this.activeConnections.get(browserId)!.add(ws);

    // Attach debugger if not already attached (with lock to prevent race condition)
    await this.ensureDebuggerAttached(browserId, contents);

    // Forward CDP messages bidirectionally
    ws.on("message", async (data: Buffer) => {
      let msgId: number | undefined;
      try {
        const msg = JSON.parse(data.toString()) as {
          id: number;
          method: string;
          params?: Record<string, unknown>;
        };
        msgId = msg.id;

        const result = await contents.debugger.sendCommand(msg.method, msg.params);
        ws.send(JSON.stringify({ id: msg.id, result }));
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        console.error(`[CdpServer] CDP error for browser ${browserId}:`, errorMessage);
        // Send error response if we have a message ID, otherwise send a generic error
        ws.send(
          JSON.stringify({
            id: msgId ?? -1,
            error: { message: errorMessage },
          })
        );
      }
    });

    // Forward CDP events from browser to WebSocket
    const debuggerMessageHandler = (
      _event: Electron.Event,
      method: string,
      params: Record<string, unknown>
    ) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ method, params }));
      }
    };

    contents.debugger.on("message", debuggerMessageHandler);

    ws.on("close", () => {
      console.log(`[CdpServer] Client disconnected for browser ${browserId}`);

      // Remove this connection from the set
      const connections = this.activeConnections.get(browserId);
      if (connections) {
        connections.delete(ws);

        // If no more connections, detach debugger
        if (connections.size === 0) {
          this.activeConnections.delete(browserId);
          try {
            contents.debugger.off("message", debuggerMessageHandler);
            contents.debugger.detach();
            this.debuggerAttached.delete(browserId);
          } catch {
            // Already detached
          }
        }
      }
    });

    ws.on("error", (err: Error) => {
      console.error(`[CdpServer] WebSocket error for browser ${browserId}:`, err);
    });
  }

  getPort(): number {
    return this.actualPort ?? 0;
  }

  /**
   * Ensure debugger is attached, with locking to prevent race conditions
   * when multiple connections arrive simultaneously.
   */
  private async ensureDebuggerAttached(
    browserId: string,
    contents: Electron.WebContents
  ): Promise<void> {
    // Already attached
    if (this.debuggerAttached.get(browserId)) {
      return;
    }

    // Another connection is currently attaching - wait for it
    const existingPromise = this.debuggerAttaching.get(browserId);
    if (existingPromise) {
      await existingPromise;
      return;
    }

    // We're the first - create the attach promise
    const attachPromise = (async () => {
      try {
        contents.debugger.attach("1.3");
        this.debuggerAttached.set(browserId, true);
      } catch {
        // Already attached (by another process) - that's fine
        this.debuggerAttached.set(browserId, true);
      } finally {
        this.debuggerAttaching.delete(browserId);
      }
    })();

    this.debuggerAttaching.set(browserId, attachPromise);
    await attachPromise;
  }

  async stop(): Promise<void> {
    // Close all active connections
    for (const [browserId, connections] of this.activeConnections) {
      for (const ws of connections) {
        ws.close(1000, "Server shutting down");
      }
      this.activeConnections.delete(browserId);
    }

    // Detach all debuggers
    for (const [browserId, attached] of this.debuggerAttached) {
      if (attached) {
        const webContentsId = this.browserRegistry.get(browserId);
        if (webContentsId) {
          const contents = webContents.fromId(webContentsId);
          if (contents) {
            try {
              contents.debugger.detach();
            } catch {
              // Already detached
            }
          }
        }
      }
    }
    this.debuggerAttached.clear();

    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => {
          this.actualPort = null;
          this.server = null;
          console.log("[CdpServer] Stopped");
          resolve();
        });
      });
    }
  }
}

// Singleton instance
let cdpServer: CdpServer | null = null;

export function getCdpServer(): CdpServer {
  if (!cdpServer) {
    cdpServer = new CdpServer();
  }
  return cdpServer;
}
