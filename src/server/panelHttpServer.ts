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
 *
 * Context Template API (per-subdomain, session-authed):
 * - `GET  /api/context/template`  — Template spec for OPFS bootstrap
 * - `POST /api/context/snapshot`  — Store OPFS snapshot (context transfer export)
 * - `GET  /api/context/snapshot`  — Retrieve OPFS snapshot (context transfer import)
 * - `GET  /__init__`              — Pre-warming init page (for extension)
 *
 * The HTML is augmented with:
 * 1. Injected globals (replacing Electron's preload/contextBridge)
 * 2. A pre-compiled browser transport IIFE
 * 3. OPFS bootstrap script (for template-based contexts)
 * 4. Panel title + favicon
 */

import { createServer, type Server as HttpServer } from "http";
import * as fs from "fs";
import * as path from "path";
import { randomBytes } from "crypto";
import { createDevLogger } from "../main/devLog.js";
import type { BuildResult } from "./buildV2/buildStore.js";
import {
  getSerializableSpec,
} from "./contextTemplate/headlessResolver.js";
import {
  storeSnapshot,
  getSnapshot,
  getSnapshotMetadata,
  type ContextSnapshot,
} from "./contextTemplate/contextTransfer.js";

const log = createDevLogger("PanelHttpServer");

// ---------------------------------------------------------------------------
// Pre-compiled browser transport
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

const BROWSER_TRANSPORT_JS = loadBrowserTransport();

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
  gitBaseUrl: string;
  gitToken: string;
  pubsubPort: number;
  stateArgs: Record<string, unknown>;
  sourceRepo: string;
  resolvedRepoArgs: Record<string, unknown>;
  env: Record<string, string>;
  theme: "light" | "dark";
  /** Template spec hash (full), if resolved from template */
  specHash?: string;
  /** Template spec hash (first 12 chars), if resolved from template */
  specHashShort?: string;
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
 * localStorage, IndexedDB, OPFS, cookies, and service workers — matching
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

  constructor(host = "127.0.0.1", managementToken?: string) {
    this.host = host;
    this.managementToken = managementToken ?? null;
  }

  async start(port = 0): Promise<number> {
    this.httpServer = createServer((req, res) => this.handleRequest(req, res));

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
   * The init page runs the OPFS bootstrap so storage is warm when the
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
      title: buildResult.metadata.name,
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

  private handleRequest(
    req: import("http").IncomingMessage,
    res: import("http").ServerResponse,
  ): void {
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
      const panel = this.subdomainToPanel.get(subdomain);
      if (panel) {
        // Per-subdomain context API (session-authed)
        if (pathname.startsWith("/api/context/")) {
          this.handleContextApiRequest(req, res, url, pathname, panel);
          return;
        }
        // Pre-warming init page (for extension hidden-tab approach)
        if (pathname === "/__init__") {
          this.serveInitPage(req, res, panel);
          return;
        }
        this.handleSubdomainRequest(req, res, url, pathname, panel);
        return;
      }

      // Check pending panels (pre-build: only serve /__init__ for pre-warming)
      const pending = this.subdomainToPending.get(subdomain);
      if (pending) {
        if (pathname === "/__init__") {
          this.servePendingInitPage(req, res, pending);
          return;
        }
        if (pathname.startsWith("/api/context/")) {
          this.handlePendingContextApi(req, res, url, pathname, pending);
          return;
        }
        // Panel still building — show a loading page
        this.serveBuildingPage(res, subdomain);
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
  // Context Template API (per-subdomain, session-authed)
  // =========================================================================

  /**
   * Handle context API requests on a panel's subdomain.
   *
   * These endpoints are authenticated via the same session cookie as the
   * panel itself — they run on the panel's subdomain so the browser's
   * Same-Origin Policy keeps them isolated.
   *
   * Endpoints:
   * - GET  /api/context/template  → template spec for OPFS bootstrap
   * - GET  /api/context/snapshot  → retrieve stored snapshot (import)
   * - POST /api/context/snapshot  → store snapshot (export)
   */
  private async handleContextApiRequest(
    req: import("http").IncomingMessage,
    res: import("http").ServerResponse,
    url: URL,
    pathname: string,
    panel: StoredPanel,
  ): Promise<void> {
    // CORS for panel-origin requests
    res.setHeader("Access-Control-Allow-Origin", this.getPanelOrigin(panel.config.subdomain));
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Credentials", "true");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Session cookie auth (same as panel resource serving)
    const cookies = parseCookies(req.headers.cookie);
    const sid = cookies["_ns_session"];
    let authed = false;
    if (sid) {
      const session = this.sessions.get(sid);
      if (session && session.panelId === panel.config.panelId) {
        authed = true;
      }
    }

    // Also accept the panel's HTTP token as a query param (for init page)
    const token = url.searchParams.get("token");
    if (token === panel.httpToken) {
      authed = true;
    }

    if (!authed) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    try {
      switch (pathname) {
        case "/api/context/template":
          this.serveContextTemplate(res, panel);
          break;
        case "/api/context/snapshot":
          if (req.method === "POST") {
            await this.handleSnapshotStore(req, res, panel);
          } else {
            this.handleSnapshotRetrieve(res, panel);
          }
          break;
        default:
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Not found" }));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: message }));
    }
  }

  /**
   * GET /api/context/template
   *
   * Returns the resolved template spec for this panel's context.
   * The browser bootstrap uses this to populate OPFS.
   */
  private serveContextTemplate(
    res: import("http").ServerResponse,
    panel: StoredPanel,
  ): void {
    const { specHash } = panel.config;

    if (!specHash) {
      // No template — panel was created without template resolution
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        hasTemplate: false,
        contextId: panel.config.contextId,
      }));
      return;
    }

    const spec = getSerializableSpec(specHash);
    if (!spec) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        hasTemplate: true,
        contextId: panel.config.contextId,
        specHash,
        error: "Template spec not in cache (server may have restarted)",
      }));
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      hasTemplate: true,
      contextId: panel.config.contextId,
      ...spec,
    }));
  }

  /**
   * POST /api/context/snapshot
   *
   * Store an OPFS snapshot for context transfer.
   * The panel serializes its OPFS to JSON and POSTs it here.
   */
  private async handleSnapshotStore(
    req: import("http").IncomingMessage,
    res: import("http").ServerResponse,
    panel: StoredPanel,
  ): Promise<void> {
    const body = await readBody(req);
    const snapshot: ContextSnapshot = JSON.parse(body);

    // Validate basic shape
    if (!snapshot.sourceContextId || !Array.isArray(snapshot.opfsFiles)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid snapshot: missing sourceContextId or opfsFiles" }));
      return;
    }

    storeSnapshot(panel.config.contextId, snapshot);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      stored: true,
      contextId: panel.config.contextId,
      fileCount: snapshot.opfsFiles.length,
      totalSize: snapshot.totalSize,
    }));
  }

  /**
   * GET /api/context/snapshot
   *
   * Retrieve a stored OPFS snapshot for import.
   * The destination panel fetches this and writes to its own OPFS.
   */
  private handleSnapshotRetrieve(
    res: import("http").ServerResponse,
    panel: StoredPanel,
  ): void {
    const snapshot = getSnapshot(panel.config.contextId);

    if (!snapshot) {
      // Check if metadata exists (expired)
      const meta = getSnapshotMetadata(panel.config.contextId);
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: meta ? "Snapshot expired" : "No snapshot available",
        contextId: panel.config.contextId,
      }));
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(snapshot));
  }

  // =========================================================================
  // Pre-warming init page
  // =========================================================================

  /**
   * GET /__init__
   *
   * Serves a lightweight page that runs the OPFS bootstrap and signals
   * completion. Used by the browser extension's pre-warming flow:
   *
   * 1. Extension opens a hidden tab to `{subdomain}.localhost/__init__?token=...`
   * 2. Init page runs the bootstrap, populates OPFS from template
   * 3. Page posts a message to the extension when done
   * 4. Extension closes the hidden tab
   * 5. When the real panel tab opens, OPFS is already warm
   */
  private serveInitPage(
    req: import("http").IncomingMessage,
    res: import("http").ServerResponse,
    panel: StoredPanel,
  ): void {
    // Accept token auth for init page (extension provides this)
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const token = url.searchParams.get("token");
    const cookies = parseCookies(req.headers.cookie);
    const sid = cookies["_ns_session"];

    let authed = false;
    if (token === panel.httpToken) {
      authed = true;
    } else if (sid) {
      const session = this.sessions.get(sid);
      if (session && session.panelId === panel.config.panelId) {
        authed = true;
      }
    }

    if (!authed) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Unauthorized");
      return;
    }

    const { config } = panel;
    const initHtml = this.buildInitPageHtml(config);

    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(initHtml);
  }

  /**
   * Build the init page HTML with the OPFS bootstrap.
   *
   * This page:
   * 1. Checks if OPFS is already initialized (marker in IndexedDB)
   * 2. If not, fetches template spec from /api/context/template
   * 3. For each entry, fetches repo archive from git server
   * 4. Writes files to OPFS
   * 5. Writes initialization marker
   * 6. Posts completion message to extension
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

  // =========================================================================
  // Pending panel routing (pre-build, init-token auth)
  // =========================================================================

  /**
   * Serve /__init__ for a pending (not yet built) panel.
   * Auth via initToken in query string (extension provides this).
   */
  private servePendingInitPage(
    req: import("http").IncomingMessage,
    res: import("http").ServerResponse,
    pending: PendingPanel,
  ): void {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const token = url.searchParams.get("token");

    if (token !== pending.initToken) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Unauthorized");
      return;
    }

    // Create a session cookie so subsequent API calls (from the bootstrap
    // script) are authenticated without the token in the URL
    const sid = randomBytes(16).toString("hex");
    this.sessions.set(sid, {
      panelId: pending.panelId,
      subdomain: pending.subdomain,
      createdAt: Date.now(),
    });

    const initHtml = this.buildInitPageHtml(pending.config);

    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Set-Cookie": `_ns_session=${sid}; HttpOnly; SameSite=Strict; Path=/`,
    });
    res.end(initHtml);
  }

  /**
   * Handle context API requests for a pending panel.
   * Only serves /api/context/template (needed by the bootstrap script).
   */
  private handlePendingContextApi(
    req: import("http").IncomingMessage,
    res: import("http").ServerResponse,
    _url: URL,
    pathname: string,
    pending: PendingPanel,
  ): void {
    // CORS
    res.setHeader("Access-Control-Allow-Origin", this.getPanelOrigin(pending.subdomain));
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Credentials", "true");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Session cookie auth
    const cookies = parseCookies(req.headers.cookie);
    const sid = cookies["_ns_session"];
    if (!sid) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    const session = this.sessions.get(sid);
    if (!session || session.panelId !== pending.panelId) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    if (pathname === "/api/context/template") {
      // Serve the template spec using the pending panel's config
      const { specHash } = pending.config;
      if (!specHash) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ hasTemplate: false, contextId: pending.contextId }));
        return;
      }
      const spec = getSerializableSpec(specHash);
      if (!spec) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ hasTemplate: true, contextId: pending.contextId, specHash, error: "Template spec not in cache" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ hasTemplate: true, contextId: pending.contextId, ...spec }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }

  /**
   * Serve a "building" placeholder page for a pending panel.
   */
  private serveBuildingPage(res: import("http").ServerResponse, subdomain: string): void {
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

    res.writeHead(202, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
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

    // ── Globals + transport + OPFS bootstrap injection ──
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
      token: config.rpcToken,
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
        token: config.rpcToken,
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
      `globalThis.process = { env: ${env} };`,
    ].join("\n");
  }

  private buildTransportScript(_config: PanelConfig): string {
    return BROWSER_TRANSPORT_JS;
  }

  /**
   * Generate the OPFS bootstrap script.
   *
   * This script runs before the panel JS and:
   * 1. Checks IndexedDB for a ".template-initialized" marker
   * 2. If not initialized, fetches template spec from /api/context/template
   * 3. For each entry in the template structure, fetches files from the git server
   * 4. Writes files to OPFS using the File System Access API
   * 5. Writes the initialization marker to IndexedDB
   *
   * On subsequent loads the marker check is instant (< 1ms) so there's no
   * performance penalty for already-initialized contexts.
   *
   * When isInitPage=true, the script also posts a message to the extension
   * background when initialization is complete (for pre-warming flow).
   */
  private buildOpfsBootstrapScript(config: PanelConfig, isInitPage: boolean): string {
    const { specHash, contextId, gitBaseUrl, gitToken } = config;

    // If no template spec, emit a no-op
    if (!specHash) {
      if (isInitPage) {
        return [
          `// No template — nothing to bootstrap`,
          `(function() {`,
          `  var msg = document.getElementById("message");`,
          `  var spinner = document.getElementById("spinner");`,
          `  if (msg) { msg.textContent = "No template — context ready."; msg.className = "done"; }`,
          `  if (spinner) spinner.style.display = "none";`,
          `  try { chrome.runtime.sendMessage({ type: "contextInitComplete", contextId: ${JSON.stringify(contextId)}, status: "skipped" }); } catch(e) {}`,
          `})();`,
        ].join("\n");
      }
      return `// No template spec — OPFS bootstrap skipped`;
    }

    // The actual bootstrap IIFE
    return [
      `// OPFS Bootstrap — populates Origin Private File System from context template`,
      `(function() {`,
      `  var CONTEXT_ID = ${JSON.stringify(contextId)};`,
      `  var SPEC_HASH = ${JSON.stringify(specHash)};`,
      `  var GIT_BASE = ${JSON.stringify(gitBaseUrl)};`,
      `  var GIT_TOKEN = ${JSON.stringify(gitToken)};`,
      `  var IS_INIT_PAGE = ${isInitPage ? "true" : "false"};`,
      `  var DB_NAME = "__natstack_context";`,
      `  var STORE_NAME = "markers";`,
      `  var MARKER_KEY = "template-initialized";`,
      ``,
      `  function updateStatus(msg, isDone, isError) {`,
      `    if (!IS_INIT_PAGE) return;`,
      `    var el = document.getElementById("message");`,
      `    var spinner = document.getElementById("spinner");`,
      `    if (el) { el.textContent = msg; if (isDone) el.className = "done"; if (isError) el.className = "error"; }`,
      `    if (spinner && (isDone || isError)) spinner.style.display = "none";`,
      `  }`,
      ``,
      `  function signalComplete(status, error) {`,
      `    if (!IS_INIT_PAGE) return;`,
      `    // Signal to extension via runtime message (if extension context available)`,
      `    try {`,
      `      if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {`,
      `        chrome.runtime.sendMessage({ type: "contextInitComplete", contextId: CONTEXT_ID, status: status, error: error || null });`,
      `      }`,
      `    } catch(e) { /* extension not available */ }`,
      `    // Also post to opener (for iframe-based pre-warming)`,
      `    try {`,
      `      if (window.opener) window.opener.postMessage({ type: "contextInitComplete", contextId: CONTEXT_ID, status: status }, "*");`,
      `    } catch(e) {}`,
      `  }`,
      ``,
      `  // Open or create IndexedDB for marker storage`,
      `  function openDB() {`,
      `    return new Promise(function(resolve, reject) {`,
      `      var req = indexedDB.open(DB_NAME, 1);`,
      `      req.onupgradeneeded = function(e) { e.target.result.createObjectStore(STORE_NAME); };`,
      `      req.onsuccess = function(e) { resolve(e.target.result); };`,
      `      req.onerror = function(e) { reject(e.target.error); };`,
      `    });`,
      `  }`,
      ``,
      `  // Check if context is already initialized`,
      `  function checkMarker(db) {`,
      `    return new Promise(function(resolve, reject) {`,
      `      var tx = db.transaction(STORE_NAME, "readonly");`,
      `      var store = tx.objectStore(STORE_NAME);`,
      `      var req = store.get(MARKER_KEY);`,
      `      req.onsuccess = function() { resolve(req.result || null); };`,
      `      req.onerror = function() { resolve(null); };`,
      `    });`,
      `  }`,
      ``,
      `  // Write initialization marker`,
      `  function writeMarker(db) {`,
      `    return new Promise(function(resolve, reject) {`,
      `      var tx = db.transaction(STORE_NAME, "readwrite");`,
      `      var store = tx.objectStore(STORE_NAME);`,
      `      store.put({ specHash: SPEC_HASH, initializedAt: Date.now() }, MARKER_KEY);`,
      `      tx.oncomplete = function() { resolve(); };`,
      `      tx.onerror = function(e) { reject(e.target.error); };`,
      `    });`,
      `  }`,
      ``,
      `  // Create a directory in OPFS (recursive)`,
      `  async function ensureDir(root, pathParts) {`,
      `    var current = root;`,
      `    for (var i = 0; i < pathParts.length; i++) {`,
      `      current = await current.getDirectoryHandle(pathParts[i], { create: true });`,
      `    }`,
      `    return current;`,
      `  }`,
      ``,
      `  // Write a file to OPFS`,
      `  async function writeFile(root, filePath, content) {`,
      `    var parts = filePath.split("/").filter(Boolean);`,
      `    var fileName = parts.pop();`,
      `    var dir = await ensureDir(root, parts);`,
      `    var fileHandle = await dir.getFileHandle(fileName, { create: true });`,
      `    var writable = await fileHandle.createWritable();`,
      `    await writable.write(content);`,
      `    await writable.close();`,
      `  }`,
      ``,
      `  // Fetch a file from the git server`,
      `  async function fetchGitFile(repo, commit, filePath) {`,
      `    var url = GIT_BASE + "/" + repo + "/raw/" + commit + "/" + encodeURIComponent(filePath);`,
      `    var resp = await fetch(url, { headers: { "Authorization": "Bearer " + GIT_TOKEN } });`,
      `    if (!resp.ok) throw new Error("Git fetch failed: " + resp.status + " " + url);`,
      `    return resp;`,
      `  }`,
      ``,
      `  // Fetch directory listing from git server`,
      `  async function fetchGitTree(repo, commit, dirPath) {`,
      `    var url = GIT_BASE + "/" + repo + "/tree/" + commit;`,
      `    if (dirPath) url += "/" + encodeURIComponent(dirPath);`,
      `    var resp = await fetch(url, { headers: { "Authorization": "Bearer " + GIT_TOKEN } });`,
      `    if (!resp.ok) return [];`,
      `    return resp.json();`,
      `  }`,
      ``,
      `  // Recursively clone a repo subtree into OPFS`,
      `  async function cloneToOpfs(root, targetPath, repo, commit) {`,
      `    var targetParts = targetPath.split("/").filter(Boolean);`,
      `    var targetDir = await ensureDir(root, targetParts);`,
      ``,
      `    // Fetch the tree listing`,
      `    var entries = await fetchGitTree(repo, commit, "");`,
      `    if (!Array.isArray(entries)) return;`,
      ``,
      `    for (var i = 0; i < entries.length; i++) {`,
      `      var entry = entries[i];`,
      `      if (entry.type === "blob") {`,
      `        updateStatus("Cloning: " + repo + "/" + entry.path + "...");`,
      `        var resp = await fetchGitFile(repo, commit, entry.path);`,
      `        var blob = await resp.blob();`,
      `        await writeFile(targetDir, entry.path, blob);`,
      `      }`,
      `    }`,
      `  }`,
      ``,
      `  // Main bootstrap logic`,
      `  async function bootstrap() {`,
      `    try {`,
      `      var db = await openDB();`,
      `      var marker = await checkMarker(db);`,
      ``,
      `      // Already initialized with matching spec hash — skip`,
      `      if (marker && marker.specHash === SPEC_HASH) {`,
      `        updateStatus("Context already initialized.", true);`,
      `        signalComplete("already-initialized");`,
      `        globalThis.__natstackContextReady = true;`,
      `        return;`,
      `      }`,
      ``,
      `      updateStatus("Fetching template spec...");`,
      ``,
      `      // Fetch template spec from server`,
      `      var specResp = await fetch("/api/context/template", { credentials: "include" });`,
      `      var spec = await specResp.json();`,
      ``,
      `      if (!spec.hasTemplate || !spec.structure) {`,
      `        updateStatus("No template structure — context ready.", true);`,
      `        signalComplete("no-template");`,
      `        globalThis.__natstackContextReady = true;`,
      `        return;`,
      `      }`,
      ``,
      `      // Get OPFS root`,
      `      var opfsRoot = await navigator.storage.getDirectory();`,
      ``,
      `      // Clone each entry in the template structure`,
      `      var paths = Object.keys(spec.structure);`,
      `      for (var i = 0; i < paths.length; i++) {`,
      `        var targetPath = paths[i];`,
      `        var entry = spec.structure[targetPath];`,
      `        updateStatus("Cloning " + (i + 1) + "/" + paths.length + ": " + entry.repo + "...");`,
      `        await cloneToOpfs(opfsRoot, targetPath, entry.repo, entry.commit);`,
      `      }`,
      ``,
      `      // Write marker`,
      `      await writeMarker(db);`,
      ``,
      `      updateStatus("Context initialized (" + paths.length + " repos cloned).", true);`,
      `      signalComplete("initialized");`,
      `      globalThis.__natstackContextReady = true;`,
      ``,
      `    } catch (err) {`,
      `      console.error("[NatStack OPFS Bootstrap] Error:", err);`,
      `      updateStatus("Bootstrap error: " + err.message, false, true);`,
      `      signalComplete("error", err.message);`,
      `      // Don't block panel load on bootstrap failure`,
      `      globalThis.__natstackContextReady = true;`,
      `    }`,
      `  }`,
      ``,
      `  // Fire and forget — don't block panel rendering`,
      `  globalThis.__natstackContextBootstrap = bootstrap();`,
      `})();`,
    ].join("\n");
  }

  // =========================================================================
  // Static pages
  // =========================================================================

  private serveIndex(res: import("http").ServerResponse): void {
    const panelEntries = Array.from(this.panels.entries()).map(([id, panel]) => {
      const origin = this.getPanelOrigin(panel.config.subdomain);
      const url = `${origin}/?token=${encodeURIComponent(panel.httpToken)}`;
      return `<li>
  <a href="${url}">${escapeHtml(panel.title)}</a>
  <code>${escapeHtml(id)}</code>
  <small class="sub">${escapeHtml(panel.config.subdomain)}.localhost</small>
</li>`;
    });

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
  </style>
</head>
<body>
  <h1>NatStack Panels</h1>
  ${panelEntries.length > 0
    ? `<ul>${panelEntries.join("\n")}</ul>`
    : `<p class="empty">No panels are currently running. Create a panel via the RPC API.</p>`
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
