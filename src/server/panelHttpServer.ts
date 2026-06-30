/**
 * PanelHttpServer — source/ref-keyed static panel asset server.
 *
 * Panel identity is injected by the host shell before app code runs, so this
 * server resolves source builds and serves static assets from path-based URLs.
 */

import * as fs from "fs";
import * as path from "path";
import { WebSocketServer } from "ws";
import { createDevLogger } from "@natstack/dev-log";
import type {
  BuildArtifactManifestEntry,
  BuildResult,
  BuildMetadata,
} from "./buildV2/buildStore.js";
import type { CdpBridge } from "./cdpBridge.js";
import { CONFIG_LOADER_JS } from "./configLoader.js";
import { assertPresent } from "../lintHelpers";

const log = createDevLogger("PanelHttpServer");

declare const __dirname: string | undefined;

// ---------------------------------------------------------------------------
// Pre-compiled browser transport + context bootstrap
// ---------------------------------------------------------------------------

function loadBrowserTransport(): string {
  const transportCandidates = [
    typeof __dirname !== "undefined" && __dirname
      ? path.join(__dirname, "browserTransport.js")
      : null,
    path.join(process.cwd(), "dist", "browserTransport.js"),
    path.join(process.cwd(), "src", "server", "browserTransport.js"),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const transportPath of transportCandidates) {
    try {
      return fs.readFileSync(transportPath, "utf-8");
    } catch {
      // Try the next runtime layout.
    }
  }

  log.info(`[PanelHttpServer] Browser transport not found, using inline stub`);
  return `console.warn("[NatStack] Browser transport not available — panel RPC will not work.");`;
}

const BROWSER_TRANSPORT_JS = loadBrowserTransport();

// ---------------------------------------------------------------------------
// Embedded favicon (SVG)
// ---------------------------------------------------------------------------

const DEFAULT_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#1a1a2e"/><text x="16" y="23" text-anchor="middle" font-size="20" font-family="system-ui" fill="#e94560">N</text></svg>`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Callback interface for panel-related data.
 * The HTTP server receives all panel data via these callbacks — no per-panel state stored.
 */
export interface PanelHttpCallbacks {
  /** Build-complete notification (source-level) */
  onBuildComplete?(source: string, error?: string): void;

  /** Build trigger */
  getBuild(source: string, ref?: string): Promise<BuildResult>;
}

/** Build output cached by source path (shared across panels) */
interface CachedBuild {
  artifacts: Array<BuildArtifactManifestEntry & { content: string }>;
  htmlArtifact: BuildArtifactManifestEntry & { content: string };
  metadata: BuildMetadata;
  revision: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
  return { source: assertPresent(match[1]), resource: match[2] || "/" };
}

function shouldLogPanelResourceRequests(): boolean {
  if (process.env["NATSTACK_PANEL_RESOURCE_LOG"] === "0") return false;
  return (
    process.env["NATSTACK_PANEL_RESOURCE_LOG"] === "1" || process.env["NODE_ENV"] === "development"
  );
}

function isPanelAssetRequest(resource: string): boolean {
  const normalized = resource.replace(/^\/+/, "");
  return (
    normalized === "bundle.js" ||
    normalized === "bundle.css" ||
    normalized.startsWith("assets/") ||
    normalized.startsWith("chunk-") ||
    /\.[cm]?js(?:\.map)?$/iu.test(normalized) ||
    /\.css(?:\.map)?$/iu.test(normalized) ||
    /\.(?:png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|wasm)$/iu.test(normalized)
  );
}

// ---------------------------------------------------------------------------
// PanelHttpServer
// ---------------------------------------------------------------------------

export class PanelHttpServer {
  /** Serving cache: source/ref -> resolved build (for fast sub-resource serving within a page load) */
  private servingCache = new Map<string, CachedBuild>();

  /** Builds currently in flight (dedup concurrent requests) */
  private buildInFlight = new Map<string, Promise<void>>();

  /** Build errors: source -> error message (surface to next request) */
  private buildErrors = new Map<string, string>();
  private buildRevisionCounter = 0;

  private port: number | null = null;

  /**
   * Source registry populated at startup from the package graph.
   * Used to list launchable panels on the index page.
   */
  private sourceRegistry = new Map<string, { name: string }>();

  /** Callbacks for panel-related data (zero per-panel state on server) */
  private callbacks: PanelHttpCallbacks | null = null;

  private wss: WebSocketServer | null = null;
  private cdpBridge: CdpBridge | null = null;
  private workerdInspectorBridge:
    | import("./workerdInspectorBridge.js").WorkerdInspectorBridge
    | null = null;

  // The panel asset façade is loopback-only and serves non-secret assets
  // exclusively (HTML / bundles / __loader.js / __transport.js / css / wasm).
  // It carries no management surface and no per-request token: the grant token
  // reaches the panel out-of-band via the shell bridge, and panel RPC rides
  // that bridge, never a loopback socket. The gateway binds 127.0.0.1 only.

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
   */
  populateSourceRegistry(entries: Array<{ source: string; name: string }>): void {
    this.sourceRegistry.clear();
    for (const entry of entries) {
      this.sourceRegistry.set(entry.source, { name: entry.name });
    }
    log.info(`Source registry populated with ${entries.length} panels`);
  }

  setCdpBridge(bridge: CdpBridge): void {
    this.cdpBridge = bridge;
  }

  setWorkerdInspectorBridge(
    bridge: import("./workerdInspectorBridge.js").WorkerdInspectorBridge
  ): void {
    this.workerdInspectorBridge = bridge;
  }

  // =========================================================================
  // Server lifecycle
  // =========================================================================

  /**
   * Initialize handlers without binding a socket.
   * Call this when the gateway owns the socket and dispatches to us.
   */
  initHandlers(): void {
    if (this.handlersInitialized) return;
    this.handlersInitialized = true;
    // WSS in noServer mode — gateway calls handleGatewayUpgrade for CDP.
    this.wss = new WebSocketServer({ noServer: true });
  }
  private handlersInitialized = false;

  /** Set the port (used when gateway owns the socket). */
  setPort(port: number): void {
    this.port = port;
  }

  getPort(): number {
    if (this.port === null) throw new Error("PanelHttpServer not started");
    return this.port;
  }

  // =========================================================================
  // Build cache (source/ref-keyed, inherently server)
  // =========================================================================

  /**
   * Store a build result. Keyed by source/ref.
   */
  storeBuild(source: string, buildResult: BuildResult, ref?: string): void {
    const htmlArtifact = buildResult.artifacts.find((artifact) => artifact.role === "html");
    const primaryArtifact = buildResult.artifacts.find((artifact) => artifact.role === "primary");
    if (!htmlArtifact || !primaryArtifact) {
      throw new Error(`Build result for ${source} missing HTML or primary artifact`);
    }

    const revision = ++this.buildRevisionCounter;
    this.servingCache.set(this.buildCacheKey(source, ref), {
      artifacts: buildResult.artifacts,
      htmlArtifact,
      metadata: buildResult.metadata,
      revision,
    });

    log.info(`Stored build: ${this.buildCacheKey(source, ref)}`);

    // Notify callback (source-level — caller does per-panel fan-out)
    this.callbacks?.onBuildComplete?.(source);
  }

  /**
   * Invalidate cached build for a source (used by force-rebuild).
   * Also clears build errors so force-rebuild retries cleanly.
   */
  invalidateBuild(source: string): void {
    for (const key of [...this.servingCache.keys()]) {
      if (key === source || key.startsWith(`${source}@`)) {
        this.servingCache.delete(key);
      }
    }
    for (const key of [...this.buildErrors.keys()]) {
      if (key === source || key.startsWith(`${source}@`)) {
        this.buildErrors.delete(key);
      }
    }
  }

  /**
   * Check if a build is cached for a source.
   */
  hasBuild(source: string, ref?: string): boolean {
    return this.servingCache.has(this.buildCacheKey(source, ref));
  }

  getBuildRevision(source: string, ref?: string): number | undefined {
    return this.servingCache.get(this.buildCacheKey(source, ref))?.revision;
  }

  async stop(): Promise<void> {
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    this.port = null;
  }

  // =========================================================================
  // Gateway in-process handlers
  // =========================================================================

  /** Handle an HTTP request from the gateway (in-process dispatch). */
  handleGatewayRequest(
    req: import("http").IncomingMessage,
    res: import("http").ServerResponse
  ): void {
    this.handleRequest(req, res).catch((err) => {
      log.warn(`Request handler error: ${err}`);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal Server Error");
      }
    });
  }

  /** Handle a WebSocket upgrade from the gateway (CDP bridge). */
  handleGatewayUpgrade(
    req: import("http").IncomingMessage,
    socket: import("stream").Duplex,
    head: Buffer
  ): void {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (this.workerdInspectorBridge?.isInspectorPath(pathname) && this.wss) {
      this.workerdInspectorBridge.handleUpgrade(req, socket, head, this.wss);
      return;
    }
    if (this.cdpBridge && this.wss) {
      this.cdpBridge.handleUpgrade(req, socket, head, this.wss);
    } else {
      socket.destroy();
    }
  }

  // =========================================================================
  // Request routing
  // =========================================================================

  private async handleRequest(
    req: import("http").IncomingMessage,
    res: import("http").ServerResponse
  ): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;

    // ── Static runtime helpers ────────────────────────────────────────────
    if (this.serveRuntimeHelper(pathname, res)) {
      return;
    }

    // ── Favicon ─────────────────────────────────────────────────────────
    if (pathname === "/favicon.ico" || pathname === "/favicon.svg") {
      this.serveFavicon(res);
      return;
    }

    const parsed = extractSourcePath(pathname);
    if (parsed) {
      if (this.serveRuntimeHelper(parsed.resource, res)) {
        return;
      }
      const contextId =
        url.searchParams.get("contextId") || this.contextIdFromReferer(req) || undefined;
      const routeLabel = contextId || parsed.source;
      // `contextId` is panel/runtime identity, not necessarily a VCS head.
      // Only an explicit ref selects a non-main build.
      const ref = url.searchParams.get("ref") || this.refFromReferer(req) || undefined;
      this.logPanelResourceRequest(req, res, parsed.source, parsed.resource, routeLabel);
      const isHtmlRequest = parsed.resource === "/" || parsed.resource === "/index.html";
      if (isHtmlRequest) {
        await this.resolveAndServeBuild(res, parsed.source, routeLabel, true, ref);
      } else {
        const build = this.servingCache.get(this.buildCacheKey(parsed.source, ref));
        if (build) {
          this.servePanelResource(res, build, parsed.resource);
        } else {
          await this.resolveAndServeBuild(res, parsed.source, routeLabel, false, ref);
        }
      }
      return;
    }

    // ── Index page ────────────────────────────────────────────────────────
    if (pathname === "/" || pathname === "/index.html") {
      this.serveIndex(res);
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }

  private logPanelResourceRequest(
    req: import("http").IncomingMessage,
    res: import("http").ServerResponse,
    source: string,
    resource: string,
    routeLabel: string
  ): void {
    if (!shouldLogPanelResourceRequests()) return;
    const startedAt = Date.now();
    const method = req.method ?? "GET";
    const userAgent = req.headers["user-agent"];
    res.once("finish", () => {
      const durationMs = Date.now() - startedAt;
      const client =
        typeof userAgent === "string" && userAgent.includes("NatStack-Mobile") ? "mobile" : "web";
      log.info(
        `Panel resource ${method} ${source}${resource} route=${routeLabel} ` +
          `status=${res.statusCode} durationMs=${durationMs} client=${client}`
      );
    });
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
    panelLabel: string,
    waitForResult = true,
    ref?: string
  ): Promise<void> {
    const flightKey = this.buildCacheKey(source, ref);

    // Start build if not already in flight (dedup concurrent requests).
    // Always start a fresh getBuild — errors from previous attempts are
    // cleared when the new build completes or fails again.
    if (!this.buildInFlight.has(flightKey)) {
      if (!this.callbacks?.getBuild) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Panel build service unavailable");
        return;
      }
      const promise = this.callbacks
        .getBuild(source, ref)
        .then((result) => {
          this.storeBuild(source, result, ref);
          this.buildErrors.delete(flightKey);
          this.buildInFlight.delete(flightKey);
        })
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          log.info(`Build failed for ${flightKey}: ${msg}`);
          this.buildErrors.set(flightKey, msg);
          this.buildInFlight.delete(flightKey);
          this.callbacks?.onBuildComplete?.(source, msg);
        });
      this.buildInFlight.set(flightKey, promise);
    }

    if (!waitForResult) {
      this.serveBuildingPage(res, panelLabel);
      return;
    }

    // Hold the HTML request open while the build runs (up to a budget) rather
    // than racing a short timer: the building placeholder costs a 2s
    // meta-refresh poll cycle, so serving it for a build that finishes at
    // 501ms used to add ~2.5s to the edit-reload loop. Cached builds resolve
    // in milliseconds either way.
    const BUILD_WAIT_BUDGET_MS = 3_000;
    const resolved = await Promise.race([
      assertPresent(this.buildInFlight.get(flightKey)).then(() => true),
      new Promise<false>((r) => setTimeout(() => r(false), BUILD_WAIT_BUDGET_MS)),
    ]);

    if (resolved) {
      const build = this.servingCache.get(flightKey);
      if (build) {
        this.servePanelResource(res, build, "/");
      } else {
        const error = this.buildErrors.get(flightKey);
        if (error) {
          this.serveBuildErrorPage(res, source, error);
        } else {
          this.serveBuildingPage(res, panelLabel);
        }
      }
    } else {
      this.serveBuildingPage(res, panelLabel);
    }
  }

  private buildCacheKey(source: string, ref?: string): string {
    return ref ? `${source}@${ref}` : source;
  }

  private serveRuntimeHelper(pathname: string, res: import("http").ServerResponse): boolean {
    if (pathname === "/__loader.js") {
      res.writeHead(200, {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(CONFIG_LOADER_JS);
      return true;
    }
    if (pathname === "/__transport.js") {
      res.writeHead(200, {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(BROWSER_TRANSPORT_JS);
      return true;
    }
    return false;
  }

  private refFromReferer(req: import("http").IncomingMessage): string | null {
    const referer = req.headers.referer;
    if (typeof referer !== "string") return null;
    try {
      const parsed = new URL(referer);
      return parsed.searchParams.get("ref");
    } catch {
      return null;
    }
  }

  private contextIdFromReferer(req: import("http").IncomingMessage): string | null {
    const referer = req.headers.referer;
    if (typeof referer !== "string") return null;
    try {
      const parsed = new URL(referer);
      return parsed.searchParams.get("contextId");
    } catch {
      return null;
    }
  }

  // =========================================================================
  // Building / error pages
  // =========================================================================

  /**
   * Serve a "building" placeholder page for a pending panel.
   */
  private serveBuildingPage(res: import("http").ServerResponse, panelLabel: string): void {
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
  <p>The panel <code>${escapeHtml(panelLabel)}</code> is still building. This page will refresh automatically.</p>
</body>
</html>`;

    res.writeHead(202, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  }

  /**
   * Serve a build error page instead of looping on a failed build.
   */
  private serveBuildErrorPage(
    res: import("http").ServerResponse,
    source: string,
    error: string
  ): void {
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
    resource: string
  ): void {
    const artifact = this.resolvePanelArtifact(build, resource);
    if (artifact) {
      this.writeArtifact(res, build.revision, artifact);
      return;
    }

    if (isPanelAssetRequest(resource)) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    // ── SPA catch-all ──
    // Unknown paths on a panel's source prefix get the panel HTML so
    // client-side routing (pushState) works.
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-NatStack-Build-Revision": String(build.revision),
    });
    res.end(build.htmlArtifact.content);
  }

  private resolvePanelArtifact(
    build: CachedBuild,
    resource: string
  ): (BuildArtifactManifestEntry & { content: string }) | null {
    if (resource === "/" || resource === "/index.html") return build.htmlArtifact;
    const normalized = resource.replace(/^\/+/, "");
    return build.artifacts.find((artifact) => artifact.path === normalized) ?? null;
  }

  private writeArtifact(
    res: import("http").ServerResponse,
    revision: number,
    artifact: BuildArtifactManifestEntry & { content: string }
  ): void {
    const cacheControl =
      artifact.role === "asset" || artifact.role === "map"
        ? "public, max-age=31536000, immutable"
        : "no-store";
    if (artifact.encoding === "base64") {
      const body = Buffer.from(artifact.content, "base64");
      res.writeHead(200, {
        "Content-Type": artifact.contentType,
        "Content-Length": body.length,
        "Cache-Control": cacheControl,
        "X-NatStack-Build-Revision": String(revision),
      });
      res.end(body);
      return;
    }
    res.writeHead(200, {
      "Content-Type": artifact.contentType,
      "Cache-Control": cacheControl,
      "X-NatStack-Build-Revision": String(revision),
    });
    res.end(artifact.content);
  }

  // =========================================================================
  // Static pages
  // =========================================================================

  private serveIndex(res: import("http").ServerResponse): void {
    const origin = `http://127.0.0.1:${this.port}`;
    // Launchable panels: from the source registry (loopback asset façade).
    const allEntries = Array.from(this.sourceRegistry.entries()).map(([source, { name }]) => {
      return `<li>
  <a href="${origin}/${escapeHtml(source)}/">${escapeHtml(name)}</a>
  <small class="sub">${escapeHtml(source)}</small>
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
    .badge { font-size: 0.7em; padding: 0.15em 0.5em; border-radius: 3px; margin-left: 0.5em; text-transform: uppercase; font-weight: 600; }
    .badge.running { background: #1b5e20; color: #81c784; }
  </style>
</head>
<body>
  <h1>NatStack Panels</h1>
  ${
    allEntries.length > 0
      ? `<ul>${allEntries.join("\n")}</ul>`
      : `<p class="empty">No panels available. Add panels to the workspace <code>panels/</code> directory.</p>`
  }
</body>
</html>`;

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
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
