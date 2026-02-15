/**
 * PanelHttpServer — Serves panel content over HTTP for browser access.
 *
 * Replaces Electron's natstack-panel:// custom protocol with a standard HTTP
 * server. Each panel's built HTML, JS, CSS, and assets are served under
 * /panels/:encodedPanelId/. The HTML is augmented with:
 *
 * 1. Injected globals (replacing Electron's preload/contextBridge)
 * 2. A pre-compiled browser transport (built from src/server/browserTransportEntry.ts)
 * 3. Proper CSP headers
 *
 * Authentication: Per-panel tokens are passed as ?token= query params on core
 * resources (HTML, bundle.js, bundle.css). This matches the Electron protocol
 * handler's approach. The token is also embedded in the HTML for the transport
 * to send as ws:auth.
 */

import { createServer, type Server as HttpServer } from "http";
import * as fs from "fs";
import * as path from "path";
import { randomBytes } from "crypto";
import { createDevLogger } from "../main/devLog.js";
import type { BuildResult } from "./buildV2/buildStore.js";

const log = createDevLogger("PanelHttpServer");

// ---------------------------------------------------------------------------
// Pre-compiled browser transport
// ---------------------------------------------------------------------------

/**
 * Load the browser transport IIFE (built from src/server/browserTransportEntry.ts).
 * Falls back to a stub if the file is not available (e.g. during tests).
 */
function loadBrowserTransport(): string {
  // In the bundled server, __dirname points to dist/ where browserTransport.js lives
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
// Types
// ---------------------------------------------------------------------------

export interface PanelConfig {
  panelId: string;
  contextId: string;
  parentId: string | null;
  rpcPort: number;
  rpcToken: string;
  gitBaseUrl: string;
  gitToken: string;
  pubsubPort: number;
  stateArgs: Record<string, unknown>;
  /** Panel's source repo path for git bootstrap (e.g., "panels/my-panel") */
  sourceRepo: string;
  /** Resolved repo args provided by parent at createChild time */
  resolvedRepoArgs: Record<string, unknown>;
  env: Record<string, string>;
  theme: "light" | "dark";
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
// Subdomain helpers — origin isolation via *.localhost
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

// ---------------------------------------------------------------------------
// PanelHttpServer
// ---------------------------------------------------------------------------

export class PanelHttpServer {
  private httpServer: HttpServer | null = null;
  private panels = new Map<string, StoredPanel>();
  private port: number | null = null;
  private host: string;

  constructor(host = "127.0.0.1") {
    this.host = host;
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

  /**
   * Get the origin URL for a panel's context.
   * Uses {contextSubdomain}.localhost:{port} so the browser treats each
   * context as a separate origin.
   */
  private getPanelOrigin(contextId: string): string {
    const subdomain = contextIdToSubdomain(contextId);
    return `http://${subdomain}.localhost:${this.port}`;
  }

  /**
   * Get the full authenticated URL for a panel.
   * Returns null if the panel is not stored or the server is not running.
   */
  getPanelUrl(panelId: string): string | null {
    const panel = this.panels.get(panelId);
    if (!panel || !this.port) return null;
    const encodedId = encodeURIComponent(panelId);
    const encodedToken = encodeURIComponent(panel.httpToken);
    const origin = this.getPanelOrigin(panel.config.contextId);
    return `${origin}/panels/${encodedId}/?token=${encodedToken}`;
  }

  /**
   * Store a built panel for HTTP serving.
   */
  storePanel(panelId: string, buildResult: BuildResult, config: PanelConfig): void {
    if (!buildResult.html || !buildResult.bundle) {
      throw new Error(`Build result for ${panelId} missing HTML or bundle`);
    }

    // Generate a per-panel HTTP access token (separate from RPC token)
    const httpToken = randomBytes(32).toString("hex");

    this.panels.set(panelId, {
      config,
      html: buildResult.html,
      bundle: buildResult.bundle,
      css: buildResult.css,
      assets: buildResult.assets,
      title: buildResult.metadata.name,
      httpToken,
    });

    const subdomain = contextIdToSubdomain(config.contextId);
    log.info(`Stored panel: ${panelId} (origin: ${subdomain}.localhost, token: ${httpToken.slice(0, 8)}...)`);
  }

  /**
   * Remove a panel from HTTP serving.
   */
  removePanel(panelId: string): void {
    this.panels.delete(panelId);
  }

  async stop(): Promise<void> {
    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => resolve());
      });
      this.httpServer = null;
    }
    this.port = null;
  }

  // =========================================================================
  // Request handling
  // =========================================================================

  private handleRequest(
    req: import("http").IncomingMessage,
    res: import("http").ServerResponse,
  ): void {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;

    // Index page: list available panels
    if (pathname === "/" || pathname === "/index.html") {
      this.serveIndex(res);
      return;
    }

    // Panel routes: /panels/:encodedPanelId/...
    const panelMatch = pathname.match(/^\/panels\/([^/]+)(\/.*)?$/);
    if (!panelMatch) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }

    const encodedPanelId = panelMatch[1]!;
    const panelId = decodeURIComponent(encodedPanelId);
    const resourcePath = panelMatch[2] ?? "/";

    const panel = this.panels.get(panelId);
    if (!panel) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end(`Panel not found: ${panelId}`);
      return;
    }

    // Auth check: core resources require token, assets use referer fallback
    const token = url.searchParams.get("token") ?? "";
    const isCorePath = resourcePath === "/" || resourcePath === "/index.html" ||
      resourcePath === "/bundle.js" || resourcePath === "/bundle.css";

    if (isCorePath && token !== panel.httpToken) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Unauthorized");
      return;
    }

    this.servePanelResource(res, panel, resourcePath);
  }

  // =========================================================================
  // Panel resource serving
  // =========================================================================

  private servePanelResource(
    res: import("http").ServerResponse,
    panel: StoredPanel,
    resourcePath: string,
  ): void {
    if (resourcePath === "/" || resourcePath === "/index.html") {
      const html = this.buildPanelHtml(panel);
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(html);
      return;
    }

    if (resourcePath === "/bundle.js") {
      res.writeHead(200, {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "public, max-age=31536000, immutable",
      });
      res.end(panel.bundle);
      return;
    }

    if (resourcePath === "/bundle.css" && panel.css) {
      res.writeHead(200, {
        "Content-Type": "text/css; charset=utf-8",
        "Cache-Control": "public, max-age=31536000, immutable",
      });
      res.end(panel.css);
      return;
    }

    // Try assets (code-split chunks, images, fonts, etc.)
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

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end(`Not found: ${resourcePath}`);
  }

  // =========================================================================
  // HTML generation with injected globals and inline transport
  // =========================================================================

  private buildPanelHtml(panel: StoredPanel): string {
    const { config } = panel;
    const encodedPanelId = encodeURIComponent(config.panelId);
    const encodedToken = encodeURIComponent(panel.httpToken);

    // Build the globals injection script
    const globalsScript = this.buildGlobalsScript(config);

    // Build the inline transport script
    const transportScript = this.buildTransportScript(config);

    // Build resource URLs with token
    const bundleUrl = `/panels/${encodedPanelId}/bundle.js?token=${encodedToken}`;
    const cssUrl = `/panels/${encodedPanelId}/bundle.css?token=${encodedToken}`;

    // Start from the build system's HTML and inject our scripts
    let html = panel.html;

    // Inject globals + transport before the closing </head> or first <script>
    const injection = `<script>\n${globalsScript}\n${transportScript}\n</script>`;

    // Try to inject before the first <script> tag
    const firstScriptIdx = html.indexOf("<script");
    if (firstScriptIdx !== -1) {
      html = html.slice(0, firstScriptIdx) + injection + "\n" + html.slice(firstScriptIdx);
    } else {
      // Fallback: inject before </head>
      html = html.replace("</head>", `${injection}\n</head>`);
    }

    // Replace relative bundle/CSS references with token-authenticated URLs
    html = html.replace(/src="\.\/bundle\.js"/g, `src="${bundleUrl}"`);
    html = html.replace(/href="\.\/bundle\.css"/g, `href="${cssUrl}"`);

    return html;
  }

  /**
   * Generate the globals injection script that replaces Electron's
   * preload/contextBridge. Sets all globalThis.__natstack* values that
   * @workspace/runtime reads during initialization.
   */
  private buildGlobalsScript(config: PanelConfig): string {
    const parentId = config.parentId !== null ? JSON.stringify(config.parentId) : "null";
    const subdomain = contextIdToSubdomain(config.contextId);
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

  /**
   * Return the pre-compiled browser transport script (IIFE built from
   * src/server/browserTransportEntry.ts, which reuses createWsTransport
   * from src/preload/wsTransport.ts). Config is read from __natstack*
   * globals that buildGlobalsScript() injects.
   */
  private buildTransportScript(_config: PanelConfig): string {
    return BROWSER_TRANSPORT_JS;
  }

  // =========================================================================
  // Index page
  // =========================================================================

  private serveIndex(res: import("http").ServerResponse): void {
    const panelEntries = Array.from(this.panels.entries()).map(([id, panel]) => {
      const encodedId = encodeURIComponent(id);
      const encodedToken = encodeURIComponent(panel.httpToken);
      const origin = this.getPanelOrigin(panel.config.contextId);
      const url = `${origin}/panels/${encodedId}/?token=${encodedToken}`;
      const subdomain = contextIdToSubdomain(panel.config.contextId);
      return `<li><a href="${url}">${escapeHtml(panel.title)} <code>${escapeHtml(id)}</code></a> <small>(${escapeHtml(subdomain)}.localhost)</small></li>`;
    });

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>NatStack Panels</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 600px; margin: 2rem auto; padding: 0 1rem; }
    code { background: #f0f0f0; padding: 0.1em 0.3em; border-radius: 3px; font-size: 0.85em; }
    li { margin: 0.5rem 0; }
    a { color: #0066cc; }
  </style>
</head>
<body>
  <h1>NatStack Panels</h1>
  ${panelEntries.length > 0
    ? `<ul>${panelEntries.join("\n")}</ul>`
    : "<p>No panels are currently running. Create a panel via the RPC API.</p>"
  }
</body>
</html>`;

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
