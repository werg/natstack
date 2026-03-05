/**
 * PanelHttpServer — Zero per-panel state HTTP server.
 *
 * **Source-based URL routing**:
 *   URL = `http://{contextSubdomain}.localhost:{port}/{source}/`
 *   - Subdomain = context (origin/storage partition)
 *   - Path = source (which panel code, e.g. `panels/my-app`)
 *
 * **Build cache keyed by source** — shared across panels with same source.
 * **Build output is 100% static** — per-panel config delivered via RPC
 *   (`bridge.getBootstrapConfig`). Auth uses subdomain-scoped session cookies;
 *   panel identity bootstrapped via nonce-keyed `_ns_boot_{bk}` cookies.
 *
 * **On-demand build** — triggered when a request arrives for a source whose
 *   build isn't cached. Serves a "building" page with auto-refresh.
 *
 * **Auth model**:
 * - Electron: PanelManager sets `_ns_session` + `_ns_boot_{bk}` cookies via
 *   Electron `session.cookies.set()`, URL includes `?_bk={bk}&pid={panelId}`.
 * - Browser (fresh tab): single redirect via `bootstrapBrowserTab` → cookies set → loader.
 * - Browser (authed tab): existing cookie + sessionStorage.
 *
 * **Zero per-panel state**: The HTTP server stores ONLY:
 * - `servingCache` + `buildInFlight` + `buildErrors` (source-keyed)
 * - `sessions` (subdomain-scoped cookie auth)
 * - `sseConnections` (SSE transport)
 * - `sourceRegistry` (static catalog from package graph)
 *
 * All panel-specific data comes via `PanelHttpCallbacks`.
 *
 * Endpoints:
 * - `GET /api/panels`       — JSON list of active panels (Bearer token auth)
 * - `GET /api/events`       — SSE stream of lifecycle events (Bearer token auth)
 * - `GET /__init__`         — Pre-warming init page (unauthenticated, contextId from query)
 * - `?_fresh` on navigation — Force re-bootstrap (missing/stale sessionStorage or cross-source nav)
 * - `GET /__loader.js`      — Config loader script (no auth)
 * - `GET /__transport.js`   — Browser RPC transport (no auth)
 */

import { createServer, type Server as HttpServer } from "http";
import * as fs from "fs";
import * as path from "path";
import { randomBytes } from "crypto";
import { WebSocketServer } from "ws";
import { createDevLogger } from "../main/devLog.js";
import type { BuildResult, BuildMetadata } from "./buildV2/buildStore.js";
import type { CdpBridge } from "./cdpBridge.js";
import { CONFIG_LOADER_JS } from "./configLoader.js";

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

const BROWSER_TRANSPORT_JS = loadBrowserTransport();

// ---------------------------------------------------------------------------
// Embedded favicon (SVG)
// ---------------------------------------------------------------------------

const DEFAULT_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#1a1a2e"/><text x="16" y="23" text-anchor="middle" font-size="20" font-family="system-ui" fill="#e94560">N</text></svg>`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PanelLifecycleEvent {
  type: "panel:created" | "panel:built" | "panel:closed" | "panel:build-error";
  panelId: string;
  title: string;
  subdomain: string;
  contextId?: string;
  url?: string;
  error?: string;
  parentId?: string | null;
  source?: string;
}

/**
 * Callback interface for panel-related data.
 * The HTTP server receives all panel data via these callbacks — no per-panel state stored.
 */
export interface PanelHttpCallbacks {
  /** Browser bootstrap: create/find panel, return bootstrap credentials */
  onDemandCreate(source: string, subdomain: string): Promise<{
    panelId: string;
    rpcPort: number;
    rpcToken: string;
    serverRpcPort?: number;
    serverRpcToken?: string;
  }>;

  /** Management API: list all panels */
  listPanels(): Array<{
    panelId: string;
    title: string;
    subdomain: string;
    source: string;
    parentId: string | null;
    contextId: string;
  }>;

  /** Build-complete notification (source-level) */
  onBuildComplete?(source: string, error?: string): void;

  /** Build trigger */
  getBuild(source: string): Promise<BuildResult>;
}

/** Build output cached by source path (shared across panels) */
interface CachedBuild {
  html: string;
  bundle: string;
  css?: string;
  assets?: Record<string, { content: string; encoding?: string }>;
  metadata: BuildMetadata;
}

interface SubdomainSession {
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
 * Extract source path (first two segments) and resource from URL pathname.
 *  /panels/my-app/bundle.js → { source: "panels/my-app", resource: "/bundle.js" }
 *  /panels/my-app/ → { source: "panels/my-app", resource: "/" }
 *  /panels/my-app → { source: "panels/my-app", resource: "/" }
 */
function extractSourcePath(pathname: string): { source: string; resource: string } | null {
  const match = pathname.match(/^\/([^/]+\/[^/]+)(\/.*)?$/);
  if (!match) return null;
  return { source: match[1]!, resource: match[2] || "/" };
}

// ---------------------------------------------------------------------------
// PanelHttpServer
// ---------------------------------------------------------------------------

export class PanelHttpServer {
  private httpServer: HttpServer | null = null;

  /** Serving cache: source → last resolved build (for fast sub-resource serving within a page load) */
  private servingCache = new Map<string, CachedBuild>();

  /** Cookie-based sessions: sessionId → session data */
  private sessions = new Map<string, SubdomainSession>();

  /** Active SSE connections for /api/events */
  private sseConnections = new Set<import("http").ServerResponse>();

  /** Builds currently in flight (dedup concurrent requests) */
  private buildInFlight = new Map<string, Promise<void>>();

  /** Build errors: source → error message (surface to next request) */
  private buildErrors = new Map<string, string>();

  private port: number | null = null;
  private host: string;
  private managementToken: string | null;

  /**
   * Source registry: deterministic subdomain → panel source info.
   * Populated at startup from the package graph. Enables on-demand panel
   * creation when a browser visits a known subdomain.
   */
  private sourceRegistry = new Map<string, { source: string; name: string }>();

  /** Callbacks for panel-related data (zero per-panel state on server) */
  private callbacks: PanelHttpCallbacks | null = null;

  private wss: WebSocketServer | null = null;
  private cdpBridge: CdpBridge | null = null;

  constructor(host = "127.0.0.1", managementToken?: string) {
    this.host = host;
    this.managementToken = managementToken ?? null;
  }

  // =========================================================================
  // Configuration
  // =========================================================================

  /**
   * Set the callback interface for panel-related queries.
   * All panel data comes through these callbacks — no per-panel state stored.
   */
  setCallbacks(callbacks: PanelHttpCallbacks): void {
    this.callbacks = callbacks;
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

  setCdpBridge(bridge: CdpBridge): void {
    this.cdpBridge = bridge;
  }

  // =========================================================================
  // Server lifecycle
  // =========================================================================

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

    // WebSocket upgrade handler for CDP bridge
    this.wss = new WebSocketServer({ noServer: true });
    this.httpServer.on("upgrade", (req, socket, head) => {
      if (this.cdpBridge) {
        this.cdpBridge.handleUpgrade(req, socket, head, this.wss!);
      } else {
        socket.destroy();
      }
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

  // =========================================================================
  // Build cache (source-keyed, inherently server)
  // =========================================================================

  /**
   * Store a build result. Keyed by source, shared across panels.
   */
  storeBuild(source: string, buildResult: BuildResult): void {
    if (!buildResult.html || !buildResult.bundle) {
      throw new Error(`Build result for ${source} missing HTML or bundle`);
    }

    this.servingCache.set(source, {
      html: buildResult.html,
      bundle: buildResult.bundle,
      css: buildResult.css,
      assets: buildResult.assets,
      metadata: buildResult.metadata,
    });

    log.info(`Stored build: ${source}`);

    // Notify callback (source-level — caller does per-panel fan-out)
    this.callbacks?.onBuildComplete?.(source);
  }

  /**
   * Invalidate cached build for a source (used by force-rebuild).
   * Also clears build errors so force-rebuild retries cleanly.
   */
  invalidateBuild(source: string): void {
    this.servingCache.delete(source);
    this.buildErrors.delete(source);
  }

  /**
   * Check if a build is cached for a source.
   */
  hasBuild(source: string): boolean {
    return this.servingCache.has(source);
  }

  // =========================================================================
  // Session management (subdomain-scoped)
  // =========================================================================

  /**
   * Ensure a subdomain session exists for auth. Returns the session ID.
   * Creates one if none exists. Used by Electron PanelManager for cookie-based auth.
   */
  ensureSubdomainSession(subdomain: string): string {
    for (const [sid, s] of this.sessions) {
      if (s.subdomain === subdomain) return sid;
    }
    const sid = randomBytes(16).toString("hex");
    this.sessions.set(sid, { subdomain, createdAt: Date.now() });
    return sid;
  }

  /**
   * Clear all sessions for a subdomain.
   * Called by panel manager when the last panel on a subdomain closes.
   */
  clearSubdomainSessions(subdomain: string): void {
    for (const [sid, s] of this.sessions) {
      if (s.subdomain === subdomain) this.sessions.delete(sid);
    }
  }

  // =========================================================================
  // SSE events
  // =========================================================================

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

    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

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

    // ── Subdomain routing ────────────────────────────────────────────────
    if (subdomain) {
      // Static scripts (no auth required)
      if (pathname === "/__loader.js") {
        res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "public, max-age=3600" });
        res.end(CONFIG_LOADER_JS);
        return;
      }
      if (pathname === "/__transport.js") {
        res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "public, max-age=3600" });
        res.end(BROWSER_TRANSPORT_JS);
        return;
      }

      // Pre-warming init page (unauthenticated, contextId from query)
      if (pathname === "/__init__") {
        const contextId = url.searchParams.get("contextId") ?? subdomain;
        this.serveInitPage(res, contextId);
        return;
      }

      const parsed = extractSourcePath(pathname);
      if (parsed) {
        // Pre-warming init page at /{source}/__init__
        if (parsed.resource === "/__init__") {
          const contextId = url.searchParams.get("contextId") ?? subdomain;
          this.serveInitPage(res, contextId);
          return;
        }

        // ── Session-cookie auth check ──
        const cookies = parseCookies(req.headers.cookie);
        const sid = cookies["_ns_session"];
        const session = sid ? this.sessions.get(sid) : null;
        const isAuthed = session && session.subdomain === subdomain;

        // ── ?_fresh forces re-bootstrap (cross-source navigation on same subdomain) ──
        const forceFresh = url.searchParams.has("_fresh");

        // ── Unauthenticated (or force-fresh) HTML/navigation → single-redirect bootstrap ──
        if (!isAuthed || forceFresh) {
          const isNavigation = parsed.resource === "/" || parsed.resource === "/index.html";
          if (isNavigation) {
            await this.bootstrapBrowserTab(res, parsed.source, subdomain);
            return;
          }
          if (!isAuthed) {
            // Non-HTML asset without auth → 403
            res.writeHead(403, { "Content-Type": "text/plain" });
            res.end("Unauthorized");
            return;
          }
        }

        // ── Authenticated: serve static resource ──
        // HTML (page load): always resolve through getBuild to ensure freshness.
        // Sub-resources (JS/CSS/assets): serve from buildCache (loaded same page).
        const isHtmlRequest = parsed.resource === "/" || parsed.resource === "/index.html";
        if (isHtmlRequest) {
          await this.resolveAndServeBuild(res, parsed.source, subdomain);
        } else {
          const build = this.servingCache.get(parsed.source);
          if (build) {
            this.servePanelResource(res, build, parsed.resource);
          } else {
            // Sub-resource arrived before HTML resolved — trigger build, don't wait
            await this.resolveAndServeBuild(res, parsed.source, subdomain, false);
          }
        }
        return;
      }

      // No valid source path on subdomain
      this.servePanelClosedPage(res, subdomain);
      return;
    }

    // ── No subdomain (127.0.0.1): index page ─────────────────────────
    if (pathname === "/" || pathname === "/index.html") {
      this.serveIndex(res);
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }

  // =========================================================================
  // Browser tab bootstrap — single redirect
  // =========================================================================

  /**
   * Bootstrap a fresh browser tab: create a panel on-demand via callback,
   * set session + nonce-keyed boot cookie, redirect.
   */
  private async bootstrapBrowserTab(
    res: import("http").ServerResponse,
    source: string,
    subdomain: string,
  ): Promise<void> {
    // Find registry entry for this subdomain
    const registryEntry = this.sourceRegistry.get(subdomain);
    const effectiveSource = registryEntry?.source ?? source;

    if (!this.callbacks?.onDemandCreate) {
      this.servePanelClosedPage(res, subdomain);
      return;
    }

    try {
      const result = await this.callbacks.onDemandCreate(effectiveSource, subdomain);
      const bk = randomBytes(8).toString("hex");
      const sid = this.ensureSubdomainSession(subdomain);
      const bootData: Record<string, unknown> = {
        pid: result.panelId, rpcPort: result.rpcPort, rpcToken: result.rpcToken,
      };
      if (result.serverRpcPort) bootData["serverRpcPort"] = result.serverRpcPort;
      if (result.serverRpcToken) bootData["serverRpcToken"] = result.serverRpcToken;
      res.writeHead(302, {
        "Location": `/${effectiveSource}/?_bk=${bk}`,
        "Set-Cookie": [
          `_ns_session=${sid}; HttpOnly; SameSite=Strict; Path=/`,
          `_ns_boot_${bk}=${encodeURIComponent(JSON.stringify(bootData))}; SameSite=Strict; Path=/; Max-Age=60`,
        ],
      });
      res.end();
    } catch (err) {
      log.info(`On-demand creation failed for ${subdomain}/${source}: ${err}`);
      this.servePanelClosedPage(res, subdomain);
    }
  }

  // =========================================================================
  // Build resolution (single source of truth)
  // =========================================================================

  /**
   * Resolve the current build for a source via getBuild callback.
   *
   * The build system (buildStore + EV recompute) is the single source of truth
   * for builds. This method always goes through it to ensure freshness, then
   * updates servingCache so sub-resource requests are served fast.
   *
   * @param waitForResult - If true, waits briefly for getBuild to resolve
   *   (used for HTML requests where a fast cached build is likely).
   *   If false, immediately shows the building page (used for sub-resource fallback).
   */
  private async resolveAndServeBuild(
    res: import("http").ServerResponse,
    source: string,
    subdomain: string,
    waitForResult = true,
  ): Promise<void> {
    // Start build if not already in flight (dedup concurrent requests).
    // Always start a fresh getBuild — errors from previous attempts are
    // cleared when the new build completes or fails again.
    if (!this.buildInFlight.has(source)) {
      if (!this.callbacks?.getBuild) {
        this.servePanelClosedPage(res, subdomain);
        return;
      }
      const promise = this.callbacks.getBuild(source).then((result) => {
        this.storeBuild(source, result);
        this.buildErrors.delete(source);
        this.buildInFlight.delete(source);
      }).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        log.info(`Build failed for ${source}: ${msg}`);
        this.buildErrors.set(source, msg);
        this.buildInFlight.delete(source);
        this.callbacks?.onBuildComplete?.(source, msg);
      });
      this.buildInFlight.set(source, promise);
    }

    if (!waitForResult) {
      this.serveBuildingPage(res, subdomain);
      return;
    }

    // Wait briefly — if build is already cached in buildStore, getBuild returns fast
    const FAST_RESOLVE_MS = 500;
    const resolved = await Promise.race([
      this.buildInFlight.get(source)!.then(() => true),
      new Promise<false>((r) => setTimeout(() => r(false), FAST_RESOLVE_MS)),
    ]);

    if (resolved) {
      const build = this.servingCache.get(source);
      if (build) {
        this.servePanelResource(res, build, "/");
      } else {
        const error = this.buildErrors.get(source);
        if (error) {
          this.serveBuildErrorPage(res, source, error);
        } else {
          this.serveBuildingPage(res, subdomain);
        }
      }
    } else {
      this.serveBuildingPage(res, subdomain);
    }
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
    const panels = (this.callbacks?.listPanels() ?? []).map(p => ({
      ...p,
      url: `http://${p.subdomain}.localhost:${this.port}/${p.source}/`,
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
    const panels = (this.callbacks?.listPanels() ?? []).map(p => ({
      panelId: p.panelId,
      title: p.title,
      subdomain: p.subdomain,
      url: `http://${p.subdomain}.localhost:${this.port}/${p.source}/`,
      source: p.source,
      parentId: p.parentId,
    }));
    res.write(`event: snapshot\ndata: ${JSON.stringify({ panels })}\n\n`);

    this.sseConnections.add(res);
    req.on("close", () => {
      this.sseConnections.delete(res);
    });
  }

  // =========================================================================
  // Pre-warming init page (unauthenticated)
  // =========================================================================

  /**
   * GET /__init__?contextId=X
   *
   * Serves a lightweight page that runs the OPFS context bootstrap.
   * Unauthenticated — only creates OPFS storage, no secrets involved.
   */
  private serveInitPage(
    res: import("http").ServerResponse,
    contextId: string,
  ): void {
    const initHtml = this.buildInitPageHtml(contextId);
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(initHtml);
  }

  /**
   * Build the init page HTML with the context bootstrap.
   */
  private buildInitPageHtml(contextId: string): string {
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
${this.buildInitBootstrapScript(contextId)}
  </script>
</body>
</html>`;
  }

  // =========================================================================
  // Building / error pages
  // =========================================================================

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

  /**
   * Serve a build error page instead of looping on a failed build.
   */
  private serveBuildErrorPage(res: import("http").ServerResponse, source: string, error: string): void {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Build Error — NatStack</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <style>
    body { font-family: system-ui, sans-serif; max-width: 600px; margin: 4rem auto; padding: 0 1rem; text-align: center; color: #e0e0e0; background: #1a1a2e; }
    h1 { color: #e94560; font-size: 1.5rem; }
    p { color: #888; line-height: 1.6; }
    pre { background: #16213e; padding: 1rem; border-radius: 6px; text-align: left; overflow-x: auto; font-size: 0.85rem; color: #ffa0a0; }
    a { color: #0a84ff; }
  </style>
</head>
<body>
  <h1>Build Failed</h1>
  <p>The panel <code>${escapeHtml(source)}</code> failed to build:</p>
  <pre>${escapeHtml(error)}</pre>
  <p><a href="http://127.0.0.1:${this.port}/">View active panels</a></p>
</body>
</html>`;

    res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  }

  // =========================================================================
  // Panel resource serving
  // =========================================================================

  private servePanelResource(
    res: import("http").ServerResponse,
    build: CachedBuild,
    resource: string,
  ): void {
    // ── HTML (static — no per-panel injection) ──
    if (resource === "/" || resource === "/index.html") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(build.html);
      return;
    }

    // ── JS bundle ──
    if (resource === "/bundle.js") {
      res.writeHead(200, {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "public, max-age=31536000, immutable",
      });
      res.end(build.bundle);
      return;
    }

    // ── CSS bundle ──
    if (resource === "/bundle.css" && build.css) {
      res.writeHead(200, {
        "Content-Type": "text/css; charset=utf-8",
        "Cache-Control": "public, max-age=31536000, immutable",
      });
      res.end(build.css);
      return;
    }

    // ── Static assets ──
    if (build.assets) {
      const normalized = resource.startsWith("/") ? resource : `/${resource}`;
      const asset = build.assets[normalized] ?? build.assets[normalized.slice(1)];
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

    // ── SPA catch-all ──
    // Unknown paths on a panel's source prefix get the panel HTML so
    // client-side routing (pushState) works.
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(build.html);
  }

  // =========================================================================
  // HTML generation (init page only — panel HTML is now static)
  // =========================================================================

  /**
   * Generate the context bootstrap injection for the init page.
   * Uses OPFS bootstrap script loaded from file.
   */
  private buildInitBootstrapScript(contextId: string): string {
    const opfsBootstrapJs = this.loadOpfsBootstrap();
    const configBlock = `globalThis.__opfsBootstrapConfig = ${JSON.stringify({
      contextId,
      isInitPage: true,
    })};`;
    return `${configBlock}\n${opfsBootstrapJs}`;
  }

  private loadOpfsBootstrap(): string {
    const bootstrapPath = path.join(__dirname, "opfsBootstrap.js");
    try {
      return fs.readFileSync(bootstrapPath, "utf-8");
    } catch {
      return `console.warn("[NatStack] Context bootstrap not available.");`;
    }
  }

  // =========================================================================
  // Static pages
  // =========================================================================

  private serveIndex(res: import("http").ServerResponse): void {
    // Use callbacks for running panels
    const runningPanels = this.callbacks?.listPanels() ?? [];
    const runningSubdomains = new Set(runningPanels.map(p => p.subdomain));

    // Active panels: currently running with direct links
    const activeEntries = runningPanels.map(p => {
      const url = `http://${p.subdomain}.localhost:${this.port}/${p.source}/`;
      return `<li>
  <a href="${url}">${escapeHtml(p.title)}</a>
  <span class="badge running">running</span>
  <small class="sub">${escapeHtml(p.subdomain)}.localhost/${escapeHtml(p.source)}</small>
</li>`;
    });

    // Available panels: from source registry, not currently running
    const availableEntries = Array.from(this.sourceRegistry.entries())
      .filter(([subdomain]) => !runningSubdomains.has(subdomain))
      .map(([subdomain, { source, name }]) => {
        const origin = this.getPanelOrigin(subdomain);
        return `<li>
  <a href="${origin}/${escapeHtml(source)}/">${escapeHtml(name)}</a>
  <small class="sub">${escapeHtml(subdomain)}.localhost/${escapeHtml(source)}</small>
</li>`;
      });

    const allEntries = [...activeEntries, ...availableEntries];

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
