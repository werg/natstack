import { WebSocketServer, WebSocket } from "ws";
import { webContents } from "electron";
import * as http from "http";
import { URL } from "url";
import { findServicePort } from "@natstack/port-utils";
import type { TokenManager } from "@natstack/shared/tokenManager";
import type { ViewManager } from "./viewManager.js";
import { createDevLogger } from "@natstack/dev-log";

const log = createDevLogger("CdpServer");

/**
 * Loopback bind address (audit finding #34). The CDP debugger surface is
 * absurdly powerful (`Runtime.evaluate` is full RCE in the browser context,
 * `Page.navigate` plus `Fetch.continueRequest` is full request forgery on
 * any session the panel can drive). It must NEVER be reachable from
 * non-loopback. Previously the WS bound the http.Server's default 0.0.0.0.
 */
const CDP_BIND_HOST = "127.0.0.1";

/**
 * Extract a CDP access token from either the `Authorization: Bearer …`
 * header (preferred — keeps the token out of URLs / proxy logs) or, for
 * legacy clients that cannot set headers on a WebSocket handshake, the
 * `?token=` query string (audit finding #34). Returns the token plus
 * which path it came from so the caller can log a deprecation warning
 * when the legacy path fires.
 *
 * Wave-2 status (security-audit-agent-3): the in-tree CDP clients are
 * `BrowserImpl.connect()` (panel-context, browser-`WebSocket` global)
 * and the Chrome extension at `extension/background.js` (extension
 * service-worker, also browser-`WebSocket`). Neither environment
 * supports custom request headers on a WebSocket handshake — the
 * `Authorization: Bearer` migration cannot complete from those clients
 * without first proxying through a Node-side relay. The legacy
 * query-string path therefore stays in place; we log a `warn` whenever
 * it is exercised so any new client that lands on the header path can
 * be confirmed silently, and so an audit reader can spot if a Node-side
 * client ever regresses to the URL form.
 */
function extractCdpToken(
  req: http.IncomingMessage,
  url: URL,
): { token: string; source: "header" | "query" } | null {
  const auth = req.headers["authorization"];
  if (typeof auth === "string") {
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m && m[1]) return { token: m[1], source: "header" };
  }
  const queryToken = url.searchParams.get("token");
  if (queryToken) return { token: queryToken, source: "query" };
  return null;
}

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

  private viewManager: ViewManager | null = null;

  constructor(tokenManager: TokenManager) {
    this.tokenManager = tokenManager;
  }

  setViewManager(viewManager: ViewManager): void {
    this.viewManager = viewManager;
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

    log.verbose(` Unregistered browser ${browserId}`);
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
      log.verbose(`[CDP Access] Direct ownership: panel ${panelId} owns ${browserId}`);
      return true;
    }

    // Check if panelId is a tree ancestor of any owner of this browser
    // (i.e., if an owner's panel ID starts with panelId/)
    for (const [ownerId, browsers] of this.panelBrowsers) {
      if (browsers.has(browserId)) {
        // Found the owner, check if requesting panel is an ancestor
        log.verbose(`[CDP Access] Browser ${browserId} owned by ${ownerId}, checking ancestor ${panelId}`);
        if (ownerId.startsWith(panelId + "/")) {
          log.verbose(`[CDP Access] Granted: ${panelId} is ancestor of ${ownerId}`);
          return true;
        }
      }
    }

    log.verbose(`[CDP Access] Denied: ${panelId} has no access to ${browserId}. panelBrowsers:`, Array.from(this.panelBrowsers.entries()).map(([id, set]) => `${id}->[${Array.from(set).join(",")}]`));
    return false;
  }

  getCdpEndpoint(browserId: string, requestingPanelId: string): string | null {
    // Verify the requesting panel can access this browser (direct parent or tree ancestor)
    if (!this.canAccessBrowser(requestingPanelId, browserId)) {
      return null; // Access denied
    }

    // Get or create token via global token manager.
    // The endpoint embeds the token in the URL because every consumer
    // of `getCdpEndpoint` is a *browser-environment* WebSocket client
    // (panel JS opening BrowserImpl.connect → BrowserWebSocketTransport
    // → `new WebSocket(url)`; the browser global has no headers option).
    // The CDP server also accepts the token via `Authorization: Bearer …`
    // — that path is the one Node-side clients (none in-tree today)
    // should take. See `extractCdpToken` for the deprecation warning.
    const token = this.tokenManager.getToken(requestingPanelId);
    return `ws://${CDP_BIND_HOST}:${this.getPort()}/${browserId}?token=${token}`;
  }

  /**
   * Get the webContents for a browser panel (for navigation control).
   */
  getBrowserWebContents(browserId: string): Electron.WebContents | null {
    if (!this.viewManager) {
      return null;
    }
    return this.viewManager.getWebContents(browserId);
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
    const port = await findServicePort("cdp");

    this.server = http.createServer();
    this.wss = new WebSocketServer({ server: this.server });

    this.wss.on("connection", (ws: WebSocket, req: http.IncomingMessage) => {
      void this.handleConnection(ws, req);
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      // Bind loopback only — never expose CDP to non-loopback (audit #34).
      this.server!.listen(port, CDP_BIND_HOST, () => resolve());
    });

    this.actualPort = port;
    log.verbose(` Started on ws://${CDP_BIND_HOST}:${port}`);
    return port;
  }

  private async handleConnection(ws: WebSocket, req: http.IncomingMessage): Promise<void> {
    const url = new URL(req.url!, `http://localhost`);
    const browserId = url.pathname.slice(1); // Remove leading /
    // Prefer Authorization header; fall back to ?token= for legacy clients.
    const extracted = extractCdpToken(req, url);

    // Validate token
    if (!extracted) {
      ws.close(4001, "Token required");
      return;
    }
    const { token, source } = extracted;
    if (source === "query") {
      // Wave-2 deprecation marker (security-audit-agent-3). Once every
      // in-tree client either uses Authorization: Bearer or has been
      // routed through a Node-side relay that can, this branch can be
      // removed and the close() switched to 4001.
      log.warn(
        `[CdpServer] Client connected with legacy ?token= query string ` +
          `(browser=${browserId}). Prefer Authorization: Bearer header. ` +
          `Note: browser-WebSocket clients (extension, panel-context Playwright) ` +
          `cannot set headers on the upgrade — legacy path remains intentional for them.`,
      );
    }

    // Validate token and get panel ID
    const entry = this.tokenManager.validateToken(token);
    const panelId = entry?.callerId ?? null;
    if (!panelId) {
      ws.close(4001, "Invalid token");
      return;
    }

    // Validate this panel can access the browser (direct parent or tree ancestor)
    if (!this.canAccessBrowser(panelId, browserId)) {
      ws.close(4003, "Access denied to this browser");
      return;
    }

    // Get webContents - try ViewManager first, then browserRegistry fallback
    const contents = this.getBrowserWebContents(browserId);
    if (!contents || contents.isDestroyed()) {
      ws.close(4004, "Browser webContents not found");
      return;
    }

    log.verbose(` Client connected for browser ${browserId} from panel ${panelId}`);

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
      let sessionId: string | undefined;
      try {
        const msg = JSON.parse(data.toString()) as {
          id: number;
          method: string;
          params?: Record<string, unknown>;
          sessionId?: string;
        };
        msgId = msg.id;
        sessionId = msg.sessionId;

        let result: unknown;

        // Intercept Page.captureScreenshot - temporarily show hidden views for capture
        if (msg.method === "Page.captureScreenshot") {
          const capture = () => contents.debugger.sendCommand(msg.method, msg.params, sessionId);
          if (this.viewManager) {
            const vm = this.viewManager;
            // withViewVisible returns null if view not found, so fallback to direct capture
            result = await vm.withViewVisible(browserId, capture) ?? await capture();
          } else {
            result = await capture();
          }
        } else {
          // Forward other CDP commands directly
          // Pass sessionId to support flattened CDP sessions (iframes, targets, etc.)
          result = await contents.debugger.sendCommand(
            msg.method,
            msg.params,
            sessionId
          );
        }

        // Include sessionId in response so client can route to correct session
        const response: { id: number; result: unknown; sessionId?: string } = {
          id: msg.id,
          result,
        };
        if (sessionId) {
          response.sessionId = sessionId;
        }
        ws.send(JSON.stringify(response));
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        console.error(`[CdpServer] CDP error for browser ${browserId}:`, errorMessage);
        // Only send error response if we have a valid message ID
        // CDP protocol requires responses to match request IDs; without an ID we can't send a valid response
        if (msgId !== undefined) {
          const errorResponse: { id: number; error: { message: string }; sessionId?: string } = {
            id: msgId,
            error: { message: errorMessage },
          };
          if (sessionId) {
            errorResponse.sessionId = sessionId;
          }
          ws.send(JSON.stringify(errorResponse));
        } else {
          // Log the error but don't send an invalid response - malformed request without ID
          console.error(`[CdpServer] Cannot send error response - no message ID in request`);
        }
      }
    });

    // Forward CDP events from browser to WebSocket
    // The message event includes sessionId for flattened CDP sessions
    const debuggerMessageHandler = (
      _event: Electron.Event,
      method: string,
      params: Record<string, unknown>,
      sessionId?: string
    ) => {
      if (ws.readyState === WebSocket.OPEN) {
        const message: { method: string; params: Record<string, unknown>; sessionId?: string } = {
          method,
          params,
        };
        if (sessionId) {
          message.sessionId = sessionId;
        }
        ws.send(JSON.stringify(message));
      }
    };

    contents.debugger.on("message", debuggerMessageHandler);

    ws.on("close", () => {
      log.verbose(` Client disconnected for browser ${browserId}`);

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
