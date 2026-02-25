/**
 * PanelHttpServer — Serves panel content over HTTP for browser access.
 *
 * Two routing modes:
 *
 * 1. **Subdomain routing** (primary): Each panel gets its own *.localhost
 *    subdomain and is served at `/`. Auth uses HttpOnly session cookies so
 *    the URL stays clean after the initial token-bearing redirect.
 *
 * 2. **Legacy path routing** (fallback): Panels at `/panels/{encodedId}/`
 *    with `?token=` query params. Works on bare 127.0.0.1 without subdomains.
 *
 * Management API:
 * - `GET /api/panels`  — JSON list of active panels (Bearer token auth)
 * - `GET /api/events`  — SSE stream of lifecycle events (Bearer token auth)
 * - `GET  /__init__`   — Pre-warming init page (for extension, per-subdomain)
 *
 * The HTML is augmented with:
 * 1. Injected globals (replacing Electron's preload/contextBridge)
 * 2. A pre-compiled browser transport IIFE
 * 3. Context bootstrap script (for init page pre-warming)
 * 4. Panel title + favicon
 */

import { createServer, type Server as HttpServer } from "http";
import * as fs from "fs";
import * as path from "path";
import { randomBytes } from "crypto";
import { createDevLogger } from "../main/devLog.js";
import type { BuildResult } from "./buildV2/buildStore.js";

const log = createDevLogger("PanelHttpServer");

// ---------------------------------------------------------------------------
// Pre-compiled browser transport + context bootstrap
// ---------------------------------------------------------------------------

function loadBrowserTransport(): string {
  const transportPath = path.join(__dirname, "browserTransport.js");
  try {
    return fs.readFileSync(transportPath, "utf-8");
  } catch {
    log.info(`[PanelHttpServer] Browser transport not found at ${transportPath}, using inline stub`);
    return `console.warn("[NatStack] Browser transport not available — panel RPC will not work.");`;
  }
}

function loadOpfsBootstrap(): string {
  const bootstrapPath = path.join(__dirname, "opfsBootstrap.js");
  try {
    return fs.readFileSync(bootstrapPath, "utf-8");
  } catch {
    log.info(`[PanelHttpServer] Context bootstrap not found at ${bootstrapPath}, using inline stub`);
    return `console.warn("[NatStack] Context bootstrap not available.");`;
  }
}

const BROWSER_TRANSPORT_JS = loadBrowserTransport();
const OPFS_BOOTSTRAP_JS = loadOpfsBootstrap();

// ---------------------------------------------------------------------------
// Embedded favicon (SVG)
// ---------------------------------------------------------------------------

const DEFAULT_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#1a1a2e"/><text x="16" y="23" text-anchor="middle" font-size="20" font-family="system-ui" fill="#e94560">N</text></svg>`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PanelConfig {
  panelId: string;
  contextId: string;
  /** Short DNS-safe label used as the *.localhost subdomain */
  subdomain: string;
  parentId: string | null;
  rpcPort: number;
  rpcToken: string;
  /** Server-process RPC port for direct AI/DB/build calls (Electron only) */
  serverRpcPort?: number;
  /** Auth token for the server-process RPC server (Electron only) */
  serverRpcToken?: string;
  gitBaseUrl: string;
  gitToken: string;
  pubsubPort: number;
  /** Auth token for PubSub (server-process token, distinct from main rpcToken) */
  pubsubToken: string;
  stateArgs: Record<string, unknown>;
  sourceRepo: string;
  resolvedRepoArgs: Record<string, unknown>;
  env: Record<string, string>;
  theme: "light" | "dark";
  /** Human-friendly title for the HTML <title> tag (manifest title or page name) */
  title?: string;
}

export interface PanelLifecycleEvent {
  type: "panel:created" | "panel:built" | "panel:closed" | "panel:build-error";
  panelId: string;
  title: string;
  subdomain: string;
  contextId?: string;
  /** Init token for pre-warming (only on panel:created) */
  initToken?: string;
  url?: string;
  error?: string;
  parentId?: string | null;
  source?: string;
}

interface StoredPanel {
  config: PanelConfig;
  html: string;
  bundle: string;
  css?: string;
  assets?: Record<string, { content: string; encoding?: string }>;
  title: string;
  /** Per-panel access token for HTTP resources */
  httpToken: string;
}

/**
 * A panel registered before its build completes. Only serves /__init__
 * for context pre-warming — not the full panel HTML/bundle.
 */
interface PendingPanel {
  panelId: string;
  subdomain: string;
  contextId: string;
  /** Short-lived token for authenticating the /__init__ pre-warming page */
  initToken: string;
  /** Partial config with just enough for the bootstrap script */
  config: PanelConfig;
}

interface PanelSession {
  panelId: string;
  subdomain: string;
  createdAt: number;
}

/** MIME types for serving panel assets */
const ASSET_MIME_TYPES: Record<string, string> = {
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml; charset=utf-8",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a contextId to a valid DNS subdomain label.
 *
 * Modern browsers (Chrome 73+, Firefox 84+) resolve *.localhost → 127.0.0.1
 * per the WHATWG URL Standard, giving each subdomain a distinct origin. This
 * means panels on different contexts get browser-enforced isolation of
 * localStorage, IndexedDB, cookies, and service workers — matching
 * Electron's persist:{contextId} partition behaviour.
 */
export function contextIdToSubdomain(contextId: string): string {
  const label = contextId
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 63);
  return label || "default";
}

/**
 * Extract subdomain from a Host header value.
 * Returns null for bare localhost / 127.0.0.1.
 */
function extractSubdomain(host: string): string | null {
  const match = host.match(/^([a-z0-9][a-z0-9-]*[a-z0-9])\.localhost(:\d+)?$/i);
  // Single-char subdomains also valid
  if (!match) {
    const single = host.match(/^([a-z0-9])\.localhost(:\d+)?$/i);
    return single?.[1]?.toLowerCase() ?? null;
  }
  return match[1]!.toLowerCase();
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    cookies[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return cookies;
}

/**
 * Read the full request body as a string.
 */
function readBody(req: import("http").IncomingMessage, maxSize = 100 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxSize) {
        req.destroy();
        reject(new Error(`Request body too large (max: ${maxSize} bytes)`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// PanelHttpServer
// ---------------------------------------------------------------------------

export class PanelHttpServer {
  private httpServer: HttpServer | null = null;
  private panels = new Map<string, StoredPanel>();
  /** Reverse lookup: subdomain → panel (populated in storePanel) */
  private subdomainToPanel = new Map<string, StoredPanel>();
  /** Panels registered before build completes (for pre-warming /__init__) */
  private pendingPanels = new Map<string, PendingPanel>();
  /** Reverse lookup: subdomain → pending panel */
  private subdomainToPending = new Map<string, PendingPanel>();
  /** Cookie-based sessions: sessionId → session data */
  private sessions = new Map<string, PanelSession>();
  /** Active SSE connections for /api/events */
  private sseConnections = new Set<import("http").ServerResponse>();
  private port: number | null = null;
  private host: string;
  private managementToken: string | null;

  /**
   * Source registry: deterministic subdomain → panel source info.
   * Populated at startup from the package graph. Enables on-demand panel
   * creation when a browser visits a known subdomain.
   */
  private sourceRegistry = new Map<string, { source: string; name: string }>();

  /**
   * Callback to trigger on-demand panel creation when a browser visits
   * a registered subdomain that has no running panel.
   */
  private onDemandCreate: ((source: string, subdomain: string) => Promise<string>) | null = null;

  constructor(host = "127.0.0.1", managementToken?: string) {
    this.host = host;
    this.managementToken = managementToken ?? null;
  }

  /**
   * Populate the source registry with available panels from the package graph.
   * Each entry maps a deterministic subdomain to the panel's source path.
   */
  populateSourceRegistry(entries: Array<{ subdomain: string; source: string; name: string }>): void {
    this.sourceRegistry.clear();
    for (const entry of entries) {
      this.sourceRegistry.set(entry.subdomain, { source: entry.source, name: entry.name });
    }
    log.info(`Source registry populated with ${entries.length} panels`);
  }

  /**
   * Set the callback for on-demand panel creation.
   * Called when a browser visits a registered subdomain with no running panel.
   */
  setOnDemandCreate(handler: (source: string, subdomain: string) => Promise<string>): void {
    this.onDemandCreate = handler;
  }

  async start(port = 0): Promise<number> {
    this.httpServer = createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        log.info(`Request handler error: ${err}`);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("Internal Server Error");
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.httpServer!.on("error", reject);
      this.httpServer!.listen(port, this.host, () => resolve());
    });

    const addr = this.httpServer.address();
    this.port = typeof addr === "object" && addr ? addr.port : port;
    log.info(`Panel HTTP server listening on http://${this.host}:${this.port}`);
    return this.port;
  }

  getPort(): number | null {
    return this.port;
  }

  /** Origin URL for a panel's subdomain. */
  private getPanelOrigin(subdomain: string): string {
    return `http://${subdomain}.localhost:${this.port}`;
  }

  /**
   * Get the full authenticated URL for a panel (token in query string).
   * After the browser follows this URL, the token is exchanged for a cookie
   * and the user sees a clean URL.
   */
  getPanelUrl(panelId: string): string | null {
    const panel = this.panels.get(panelId);
    if (!panel || !this.port) return null;
    const origin = this.getPanelOrigin(panel.config.subdomain);
    return `${origin}/?token=${encodeURIComponent(panel.httpToken)}`;
  }

  /**
   * Register a panel's subdomain before its build completes.
   *
   * This enables context pre-warming: the browser extension can open a
   * hidden tab to `{subdomain}.localhost/__init__?token={initToken}`
   * immediately when `panel:created` fires, before the build finishes.
   * The init page runs the context bootstrap so storage is warm when the
   * real panel tab opens.
   *
   * @returns The init token for authenticating the pre-warming request
   */
  registerPendingPanel(panelId: string, config: PanelConfig): string {
    const initToken = randomBytes(24).toString("hex");

    const pending: PendingPanel = {
      panelId,
      subdomain: config.subdomain,
      contextId: config.contextId,
      initToken,
      config,
    };

    this.pendingPanels.set(panelId, pending);
    this.subdomainToPending.set(config.subdomain, pending);

    log.info(`Registered pending panel: ${panelId} (${config.subdomain}.localhost, initToken: ${initToken.slice(0, 8)}...)`);
    return initToken;
  }

  /**
   * Store a built panel for HTTP serving.
   * Promotes a pending panel (if any) to a fully served panel.
   */
  storePanel(panelId: string, buildResult: BuildResult, config: PanelConfig): void {
    if (!buildResult.html || !buildResult.bundle) {
      throw new Error(`Build result for ${panelId} missing HTML or bundle`);
    }

    const httpToken = randomBytes(32).toString("hex");

    const stored: StoredPanel = {
      config,
      html: buildResult.html,
      bundle: buildResult.bundle,
      css: buildResult.css,
      assets: buildResult.assets,
      title: config.title || buildResult.metadata.name,
      httpToken,
    };

    this.panels.set(panelId, stored);
    this.subdomainToPanel.set(config.subdomain, stored);

    // Clean up pending entry (panel is now fully served)
    const pending = this.pendingPanels.get(panelId);
    if (pending) {
      this.pendingPanels.delete(panelId);
      this.subdomainToPending.delete(pending.subdomain);
    }

    log.info(`Stored panel: ${panelId} (${config.subdomain}.localhost, token: ${httpToken.slice(0, 8)}...)`);
  }

  /**
   * Remove a panel from HTTP serving. Invalidates sessions and cleans up
   * the subdomain mapping.
   */
  removePanel(panelId: string): void {
    const panel = this.panels.get(panelId);
    if (panel) {
      this.subdomainToPanel.delete(panel.config.subdomain);
      // Invalidate all sessions for this panel
      for (const [sid, session] of this.sessions) {
        if (session.panelId === panelId) {
          this.sessions.delete(sid);
        }
      }
    }
    this.panels.delete(panelId);

    // Also clean up any pending entry
    const pending = this.pendingPanels.get(panelId);
    if (pending) {
      this.subdomainToPending.delete(pending.subdomain);
      this.pendingPanels.delete(panelId);
    }
  }

  /**
   * Update a stored panel's config. Used when stateArgs change so that
   * a page reload picks up the latest values (the injected globals are
   * generated from the stored config at serve time).
   */
  updatePanelConfig(panelId: string, config: PanelConfig): void {
    const panel = this.panels.get(panelId);
    if (panel) {
      panel.config = config;
    }
  }

  /**
   * Push a lifecycle event to all connected SSE clients.
   */
  broadcastEvent(event: PanelLifecycleEvent): void {
    const data = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const res of this.sseConnections) {
      try {
        res.write(data);
      } catch {
        this.sseConnections.delete(res);
      }
    }
  }

  async stop(): Promise<void> {
    for (const res of this.sseConnections) {
      try { res.end(); } catch { /* already closed */ }
    }
    this.sseConnections.clear();

    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => resolve());
      });
      this.httpServer = null;
    }
    this.port = null;
  }

  // =========================================================================
  // Request routing
  // =========================================================================

  private async handleRequest(
    req: import("http").IncomingMessage,
    res: import("http").ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;
    const subdomain = extractSubdomain(req.headers.host ?? "");

    // ── Management API on bare host (no subdomain) ───────────────────────
    if (!subdomain && pathname.startsWith("/api/")) {
      this.handleManagementApiRequest(req, res, url, pathname);
      return;
    }

    // ── Favicon ─────────────────────────────────────────────────────────
    if (pathname === "/favicon.ico" || pathname === "/favicon.svg") {
      this.serveFavicon(res);
      return;
    }

    // ── Subdomain routing: serve panel at / ─────────────────────────────
    if (subdomain) {
      const stored = this.subdomainToPanel.get(subdomain);
      const pending = stored ? null : this.subdomainToPending.get(subdomain);

      if (stored || pending) {
        const config = stored ? stored.config : pending!.config;
        const panelId = config.panelId;
        const acceptedTokens = stored ? [stored.httpToken] : [pending!.initToken];

        // Pre-warming init page
        if (pathname === "/__init__") {
          this.serveInitPage(req, res, panelId, subdomain, config, acceptedTokens);
          return;
        }
        // Full panel serving (stored only)
        if (stored) {
          this.handleSubdomainRequest(req, res, url, pathname, stored);
          return;
        }
        // Panel still building — set a session cookie so auth works
        // once the build completes and the page auto-refreshes.
        this.serveBuildingPageWithSession(req, res, subdomain, pending!.panelId);
        return;
      }

      // ── On-demand panel creation from source registry ──────────────
      const registryEntry = this.sourceRegistry.get(subdomain);
      if (registryEntry && this.onDemandCreate) {
        // Await creation — this resolves as soon as the panel is registered
        // (before the build starts), so the response delay is minimal.
        // Once we have the panelId, we can set a session cookie so auth
        // works when the build completes and the page auto-refreshes.
        try {
          const panelId = await this.onDemandCreate(registryEntry.source, subdomain);
          this.serveBuildingPageWithSession(req, res, subdomain, panelId);
        } catch (err) {
          log.info(`On-demand creation failed for ${subdomain}: ${err}`);
          this.serveBuildingPage(res, subdomain);
        }
        return;
      }

      this.servePanelClosedPage(res, subdomain);
      return;
    }

    // ── No subdomain (127.0.0.1): index or legacy /panels/ ─────────────
    if (pathname === "/" || pathname === "/index.html") {
      this.serveIndex(res);
      return;
    }

    const panelMatch = pathname.match(/^\/panels\/([^/]+)(\/.*)?$/);
    if (panelMatch) {
      this.handleLegacyPanelRequest(res, url, panelMatch);
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }

  // =========================================================================
  // Subdomain panel routing (cookie-based auth)
  // =========================================================================

  private handleSubdomainRequest(
    req: import("http").IncomingMessage,
    res: import("http").ServerResponse,
    url: URL,
    pathname: string,
    panel: StoredPanel,
  ): void {
    const token = url.searchParams.get("token");

    // Valid token → create session cookie, redirect to clean URL
    if (token === panel.httpToken) {
      const sid = randomBytes(16).toString("hex");
      this.sessions.set(sid, {
        panelId: panel.config.panelId,
        subdomain: panel.config.subdomain,
        createdAt: Date.now(),
      });
      // Strip the token param
      const cleanUrl = new URL(url.toString());
      cleanUrl.searchParams.delete("token");
      const location = cleanUrl.pathname + (cleanUrl.search || "");

      res.writeHead(302, {
        "Location": location,
        "Set-Cookie": `_ns_session=${sid}; HttpOnly; SameSite=Strict; Path=/`,
      });
      res.end();
      return;
    }

    // Check session cookie
    const cookies = parseCookies(req.headers.cookie);
    const sid = cookies["_ns_session"];
    if (sid) {
      const session = this.sessions.get(sid);
      if (session && session.panelId === panel.config.panelId) {
        this.servePanelResource(res, panel, pathname, true);
        return;
      }
    }

    // No valid auth
    res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<title>Unauthorized — NatStack</title>
<style>body{font-family:system-ui,sans-serif;max-width:500px;margin:4rem auto;padding:0 1rem;text-align:center;color:#e0e0e0;background:#1a1a2e}h1{color:#e94560}a{color:#0a84ff}</style>
</head><body><h1>Unauthorized</h1>
<p>Open this panel from the <a href="http://127.0.0.1:${this.port}/">index page</a> or browser extension.</p>
</body></html>`);
  }

  // =========================================================================
  // Legacy /panels/ routing (token-based auth)
  // =========================================================================

  private handleLegacyPanelRequest(
    res: import("http").ServerResponse,
    url: URL,
    match: RegExpMatchArray,
  ): void {
    const panelId = decodeURIComponent(match[1]!);
    const resourcePath = match[2] ?? "/";

    const panel = this.panels.get(panelId);
    if (!panel) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end(`Panel not found: ${panelId}`);
      return;
    }

    const token = url.searchParams.get("token") ?? "";
    const isCorePath = resourcePath === "/" || resourcePath === "/index.html" ||
      resourcePath === "/bundle.js" || resourcePath === "/bundle.css";

    if (isCorePath && token !== panel.httpToken) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Unauthorized");
      return;
    }

    this.servePanelResource(res, panel, resourcePath, false);
  }

  // =========================================================================
  // Management API (bare host, Bearer token auth)
  // =========================================================================

  private handleManagementApiRequest(
    req: import("http").IncomingMessage,
    res: import("http").ServerResponse,
    _url: URL,
    pathname: string,
  ): void {
    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Bearer token auth
    if (!this.validateManagementAuth(req)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized — provide management token via Authorization: Bearer <token>" }));
      return;
    }

    switch (pathname) {
      case "/api/panels":
        this.serveApiPanels(res);
        break;
      case "/api/events":
        this.serveApiEvents(req, res);
        break;
      default:
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
    }
  }

  private validateManagementAuth(req: import("http").IncomingMessage): boolean {
    if (!this.managementToken) return true;
    const auth = req.headers.authorization;
    if (!auth) return false;
    const match = auth.match(/^Bearer\s+(.+)$/i);
    return match?.[1] === this.managementToken;
  }

  private serveApiPanels(res: import("http").ServerResponse): void {
    const panels = Array.from(this.panels.entries()).map(([id, panel]) => ({
      panelId: id,
      title: panel.title,
      subdomain: panel.config.subdomain,
      url: this.getPanelUrl(id),
      source: panel.config.sourceRepo,
      parentId: panel.config.parentId,
      contextId: panel.config.contextId,
    }));

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ panels }));
  }

  private serveApiEvents(
    req: import("http").IncomingMessage,
    res: import("http").ServerResponse,
  ): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });

    // Send current state as initial snapshot
    const panels = Array.from(this.panels.entries()).map(([id, panel]) => ({
      panelId: id,
      title: panel.title,
      subdomain: panel.config.subdomain,
      url: this.getPanelUrl(id),
      source: panel.config.sourceRepo,
      parentId: panel.config.parentId,
    }));
    res.write(`event: snapshot\ndata: ${JSON.stringify({ panels })}\n\n`);

    this.sseConnections.add(res);
    req.on("close", () => {
      this.sseConnections.delete(res);
    });
  }

  // =========================================================================
  // Subdomain auth helpers
  // =========================================================================

  /**
   * Authenticate a request on a panel's subdomain.
   * Checks session cookie first, then falls back to query-string token.
   *
   * @returns `authed` true if valid, `viaToken` true if matched via token
   *          (rather than session cookie).
   */
  private authenticateSubdomainRequest(
    req: import("http").IncomingMessage,
    panelId: string,
    acceptedTokens: string[],
  ): { authed: boolean; viaToken: boolean } {
    // Check session cookie first
    const cookies = parseCookies(req.headers.cookie);
    const sid = cookies["_ns_session"];
    if (sid) {
      const session = this.sessions.get(sid);
      if (session && session.panelId === panelId) {
        return { authed: true, viaToken: false };
      }
    }

    // Check token in query string
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const token = url.searchParams.get("token");
    if (token && acceptedTokens.includes(token)) {
      return { authed: true, viaToken: true };
    }

    return { authed: false, viaToken: false };
  }

  /**
   * Create a session cookie for a panel and return the session ID.
   */
  private createPanelSession(panelId: string, subdomain: string): string {
    const sid = randomBytes(16).toString("hex");
    this.sessions.set(sid, { panelId, subdomain, createdAt: Date.now() });
    return sid;
  }

  // =========================================================================
  // Context Template API (per-subdomain, unified for stored + pending)
  // =========================================================================

  // =========================================================================
  // Pre-warming init page (unified for stored + pending)
  // =========================================================================

  /**
   * GET /__init__
   *
   * Serves a lightweight page that runs the context bootstrap and signals
   * completion. Works for both stored and pending panels.
   *
   * When authenticated via token (not session cookie), creates a session
   * so the bootstrap's API calls are authenticated via cookie.
   */
  private serveInitPage(
    req: import("http").IncomingMessage,
    res: import("http").ServerResponse,
    panelId: string,
    subdomain: string,
    config: PanelConfig,
    acceptedTokens: string[],
  ): void {
    const { authed, viaToken } = this.authenticateSubdomainRequest(req, panelId, acceptedTokens);
    if (!authed) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Unauthorized");
      return;
    }

    const headers: Record<string, string> = {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    };

    // When authenticated via token (not session), create a session so the
    // bootstrap script's API calls are authenticated via cookie.
    if (viaToken) {
      const sid = this.createPanelSession(panelId, subdomain);
      headers["Set-Cookie"] = `_ns_session=${sid}; HttpOnly; SameSite=Strict; Path=/`;
    }

    const initHtml = this.buildInitPageHtml(config);
    res.writeHead(200, headers);
    res.end(initHtml);
  }

  /**
   * Build the init page HTML with the context bootstrap.
   */
  private buildInitPageHtml(config: PanelConfig): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>NatStack Context Init</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #1a1a2e; color: #e0e0e0;
           display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
    .status { text-align: center; }
    .spinner { width: 24px; height: 24px; border: 3px solid #333; border-top: 3px solid #e94560;
               border-radius: 50%; animation: spin 0.8s linear infinite; margin: 1rem auto; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .done { color: #4caf50; }
    .error { color: #e94560; }
  </style>
</head>
<body>
  <div class="status" id="status">
    <div class="spinner" id="spinner"></div>
    <p id="message">Initializing context...</p>
  </div>
  <script>
${this.buildOpfsBootstrapScript(config, true)}
  </script>
</body>
</html>`;
  }

  /**
   * Serve a "building" placeholder page for a pending panel.
   */
  private serveBuildingPage(res: import("http").ServerResponse, subdomain: string, setCookie?: string): void {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Building — NatStack</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <style>
    body { font-family: system-ui, sans-serif; max-width: 500px; margin: 4rem auto; padding: 0 1rem; text-align: center; color: #e0e0e0; background: #1a1a2e; }
    h1 { color: #e94560; font-size: 1.5rem; }
    p { color: #888; line-height: 1.6; }
    .spinner { width: 24px; height: 24px; border: 3px solid #333; border-top: 3px solid #e94560;
               border-radius: 50%; animation: spin 0.8s linear infinite; margin: 1rem auto; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
  <meta http-equiv="refresh" content="2">
</head>
<body>
  <h1>Building Panel</h1>
  <div class="spinner"></div>
  <p>The panel at <code>${escapeHtml(subdomain)}.localhost</code> is still building. This page will refresh automatically.</p>
</body>
</html>`;

    const headers: Record<string, string> = { "Content-Type": "text/html; charset=utf-8" };
    if (setCookie) {
      headers["Set-Cookie"] = setCookie;
    }
    res.writeHead(202, headers);
    res.end(html);
  }

  /**
   * Serve building page and set a session cookie for the pending panel.
   * This ensures the browser has a valid session by the time the build
   * completes and the page auto-refreshes to the real panel.
   */
  private serveBuildingPageWithSession(
    req: import("http").IncomingMessage,
    res: import("http").ServerResponse,
    subdomain: string,
    panelId: string,
  ): void {
    // Only set a cookie if the browser doesn't already have a valid session
    const cookies = parseCookies(req.headers.cookie);
    const existingSid = cookies["_ns_session"];
    const existingSession = existingSid ? this.sessions.get(existingSid) : undefined;

    if (existingSession && existingSession.panelId === panelId) {
      this.serveBuildingPage(res, subdomain);
    } else {
      const sid = this.createPanelSession(panelId, subdomain);
      this.serveBuildingPage(res, subdomain, `_ns_session=${sid}; HttpOnly; SameSite=Strict; Path=/`);
    }
  }

  // =========================================================================
  // Panel resource serving
  // =========================================================================

  private servePanelResource(
    res: import("http").ServerResponse,
    panel: StoredPanel,
    resourcePath: string,
    subdomainMode: boolean,
  ): void {
    // ── HTML ──
    if (resourcePath === "/" || resourcePath === "/index.html") {
      const html = this.buildPanelHtml(panel, subdomainMode);
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(html);
      return;
    }

    // ── JS bundle ──
    if (resourcePath === "/bundle.js") {
      res.writeHead(200, {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "public, max-age=31536000, immutable",
      });
      res.end(panel.bundle);
      return;
    }

    // ── CSS bundle ──
    if (resourcePath === "/bundle.css" && panel.css) {
      res.writeHead(200, {
        "Content-Type": "text/css; charset=utf-8",
        "Cache-Control": "public, max-age=31536000, immutable",
      });
      res.end(panel.css);
      return;
    }

    // ── Static assets ──
    if (panel.assets) {
      const normalized = resourcePath.startsWith("/") ? resourcePath : `/${resourcePath}`;
      const asset = panel.assets[normalized] ?? panel.assets[normalized.slice(1)];
      if (asset) {
        const ext = path.extname(normalized).toLowerCase();
        const contentType = ASSET_MIME_TYPES[ext] ?? "application/octet-stream";

        if (asset.encoding === "base64") {
          const buf = Buffer.from(asset.content, "base64");
          res.writeHead(200, {
            "Content-Type": contentType,
            "Content-Length": buf.length,
            "Cache-Control": "public, max-age=31536000, immutable",
          });
          res.end(buf);
        } else {
          res.writeHead(200, {
            "Content-Type": contentType,
            "Cache-Control": "public, max-age=31536000, immutable",
          });
          res.end(asset.content);
        }
        return;
      }
    }

    // ── SPA catch-all (subdomain mode only) ──
    // Unknown paths on a panel's subdomain get the panel HTML so client-side
    // routing (pushState) works.
    if (subdomainMode) {
      const html = this.buildPanelHtml(panel, true);
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(html);
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end(`Not found: ${resourcePath}`);
  }

  // =========================================================================
  // HTML generation with injected globals and inline transport
  // =========================================================================

  private buildPanelHtml(panel: StoredPanel, subdomainMode: boolean): string {
    const { config } = panel;

    const globalsScript = this.buildGlobalsScript(config);
    const transportScript = this.buildTransportScript(config);
    const bootstrapScript = this.buildOpfsBootstrapScript(config, false);

    let html = panel.html;

    // ── Title + favicon injection ──
    const titleTag = `<title>${escapeHtml(panel.title)}</title>`;
    if (html.includes("<title>")) {
      html = html.replace(/<title>[^<]*<\/title>/, titleTag);
    } else {
      html = html.replace("</head>", `${titleTag}\n</head>`);
    }
    if (!html.includes('rel="icon"')) {
      html = html.replace("</head>", `<link rel="icon" type="image/svg+xml" href="/favicon.svg">\n</head>`);
    }

    // ── Globals + transport + context bootstrap injection ──
    const injection = `<script>\n${globalsScript}\n${transportScript}\n${bootstrapScript}\n</script>`;
    const firstScriptIdx = html.indexOf("<script");
    if (firstScriptIdx !== -1) {
      html = html.slice(0, firstScriptIdx) + injection + "\n" + html.slice(firstScriptIdx);
    } else {
      html = html.replace("</head>", `${injection}\n</head>`);
    }

    // ── Bundle / CSS URL rewriting ──
    if (subdomainMode) {
      // Cookie handles auth — use simple root-relative URLs
      html = html.replace(/src="\.\/bundle\.js"/g, `src="/bundle.js"`);
      html = html.replace(/href="\.\/bundle\.css"/g, `href="/bundle.css"`);
    } else {
      // Legacy mode: full path with token
      const encodedPanelId = encodeURIComponent(config.panelId);
      const encodedToken = encodeURIComponent(panel.httpToken);
      html = html.replace(/src="\.\/bundle\.js"/g, `src="/panels/${encodedPanelId}/bundle.js?token=${encodedToken}"`);
      html = html.replace(/href="\.\/bundle\.css"/g, `href="/panels/${encodedPanelId}/bundle.css?token=${encodedToken}"`);
    }

    return html;
  }

  /**
   * Generate the globals injection script that replaces Electron's
   * preload/contextBridge.
   */
  private buildGlobalsScript(config: PanelConfig): string {
    const parentId = config.parentId !== null ? JSON.stringify(config.parentId) : "null";
    const subdomain = config.subdomain;
    const gitConfig = JSON.stringify({
      serverUrl: config.gitBaseUrl,
      token: config.gitToken,
      sourceRepo: config.sourceRepo,
      resolvedRepoArgs: config.resolvedRepoArgs,
    });
    const pubsubConfig = JSON.stringify({
      serverUrl: `ws://${subdomain}.localhost:${config.pubsubPort}`,
      token: config.pubsubToken,
    });
    const env = JSON.stringify({
      ...config.env,
      PARENT_ID: config.parentId ?? "",
      __GIT_CONFIG: JSON.stringify({
        serverUrl: config.gitBaseUrl,
        token: config.gitToken,
        sourceRepo: config.sourceRepo,
        resolvedRepoArgs: config.resolvedRepoArgs,
      }),
      __PUBSUB_CONFIG: JSON.stringify({
        serverUrl: `ws://${subdomain}.localhost:${config.pubsubPort}`,
        token: config.pubsubToken,
      }),
    });
    const stateArgs = JSON.stringify(config.stateArgs);

    return [
      `// NatStack globals — replaces Electron preload/contextBridge`,
      `globalThis.__natstackId = ${JSON.stringify(config.panelId)};`,
      `globalThis.__natstackContextId = ${JSON.stringify(config.contextId)};`,
      `globalThis.__natstackKind = "panel";`,
      `globalThis.__natstackParentId = ${parentId};`,
      `globalThis.__natstackInitialTheme = ${JSON.stringify(config.theme)};`,
      `globalThis.__natstackGitConfig = ${gitConfig};`,
      `globalThis.__natstackPubSubConfig = ${pubsubConfig};`,
      `globalThis.__natstackEnv = ${env};`,
      `globalThis.__natstackStateArgs = ${stateArgs};`,
      `globalThis.__natstackRpcPort = ${JSON.stringify(config.rpcPort)};`,
      `globalThis.__natstackRpcToken = ${JSON.stringify(config.rpcToken)};`,
      // Server-process transport for AI/DB/build (Electron dual-process only)
      ...(config.serverRpcPort ? [
        `globalThis.__natstackServerRpcPort = ${JSON.stringify(config.serverRpcPort)};`,
        `globalThis.__natstackServerRpcToken = ${JSON.stringify(config.serverRpcToken)};`,
      ] : []),
      `globalThis.process = { env: ${env} };`,
    ].join("\n");
  }

  private buildTransportScript(_config: PanelConfig): string {
    return BROWSER_TRANSPORT_JS;
  }

  /**
   * Generate the context bootstrap injection.
   *
   * Injects minimal signaling config and the bootstrap script.
   * Context filesystem is now server-side; this only handles init-page signaling.
   */
  private buildOpfsBootstrapScript(config: PanelConfig, isInitPage: boolean): string {
    if (!isInitPage) {
      return `globalThis.__natstackContextReady = true;`;
    }

    const configBlock = `globalThis.__opfsBootstrapConfig = ${JSON.stringify({
      contextId: config.contextId,
      isInitPage,
    })};`;

    return `${configBlock}\n${OPFS_BOOTSTRAP_JS}`;
  }

  // =========================================================================
  // Static pages
  // =========================================================================

  private serveIndex(res: import("http").ServerResponse): void {
    // Build a set of subdomains that are currently running (stored or pending)
    const runningSubdomains = new Set<string>();
    for (const panel of this.panels.values()) {
      runningSubdomains.add(panel.config.subdomain);
    }
    for (const pending of this.pendingPanels.values()) {
      runningSubdomains.add(pending.subdomain);
    }

    // Active panels: currently running with direct links
    const activeEntries = Array.from(this.panels.entries()).map(([id, panel]) => {
      const origin = this.getPanelOrigin(panel.config.subdomain);
      const url = `${origin}/?token=${encodeURIComponent(panel.httpToken)}`;
      return `<li>
  <a href="${url}">${escapeHtml(panel.title)}</a>
  <span class="badge running">running</span>
  <small class="sub">${escapeHtml(panel.config.subdomain)}.localhost</small>
</li>`;
    });

    // Available panels: from source registry, not currently running
    const availableEntries = Array.from(this.sourceRegistry.entries())
      .filter(([subdomain]) => !runningSubdomains.has(subdomain))
      .map(([subdomain, { name }]) => {
        const origin = this.getPanelOrigin(subdomain);
        return `<li>
  <a href="${origin}/">${escapeHtml(name)}</a>
  <small class="sub">${escapeHtml(subdomain)}.localhost</small>
</li>`;
      });

    // Building panels: currently pending
    const buildingEntries = Array.from(this.pendingPanels.values()).map((pending) => {
      const origin = this.getPanelOrigin(pending.subdomain);
      return `<li>
  <a href="${origin}/">${escapeHtml(pending.panelId)}</a>
  <span class="badge building">building</span>
  <small class="sub">${escapeHtml(pending.subdomain)}.localhost</small>
</li>`;
    });

    const allEntries = [...activeEntries, ...buildingEntries, ...availableEntries];

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>NatStack Panels</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <style>
    body { font-family: system-ui, sans-serif; max-width: 600px; margin: 2rem auto; padding: 0 1rem; color: #e0e0e0; background: #1a1a2e; }
    h1 { color: #e94560; }
    code { background: #16213e; padding: 0.1em 0.4em; border-radius: 3px; font-size: 0.8em; color: #a0a0b8; }
    ul { list-style: none; padding: 0; }
    li { margin: 0.8rem 0; }
    a { color: #0a84ff; text-decoration: none; font-weight: 500; }
    a:hover { text-decoration: underline; }
    .sub { color: #555; margin-left: 0.5em; }
    .empty { color: #888; }
    .badge { font-size: 0.7em; padding: 0.15em 0.5em; border-radius: 3px; margin-left: 0.5em; text-transform: uppercase; font-weight: 600; }
    .badge.running { background: #1b5e20; color: #81c784; }
    .badge.building { background: #4a3800; color: #ffd54f; }
  </style>
</head>
<body>
  <h1>NatStack Panels</h1>
  ${allEntries.length > 0
    ? `<ul>${allEntries.join("\n")}</ul>`
    : `<p class="empty">No panels available. Add panels to the workspace <code>panels/</code> directory.</p>`
  }
</body>
</html>`;

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  }

  private servePanelClosedPage(res: import("http").ServerResponse, subdomain: string): void {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Panel Closed — NatStack</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <style>
    body { font-family: system-ui, sans-serif; max-width: 500px; margin: 4rem auto; padding: 0 1rem; text-align: center; color: #e0e0e0; background: #1a1a2e; }
    h1 { color: #e94560; font-size: 1.5rem; }
    p { color: #888; line-height: 1.6; }
    a { color: #0a84ff; }
    code { background: #16213e; padding: 0.1em 0.4em; border-radius: 3px; }
  </style>
</head>
<body>
  <h1>Panel Closed</h1>
  <p>The panel at <code>${escapeHtml(subdomain)}.localhost</code> is no longer running.</p>
  <p><a href="http://127.0.0.1:${this.port}/">View active panels</a></p>
</body>
</html>`;

    res.writeHead(410, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  }

  private serveFavicon(res: import("http").ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "public, max-age=86400",
    });
    res.end(DEFAULT_FAVICON_SVG);
  }
}
