/**
 * PanelHttpServer — Serves panel content over HTTP for browser access.
 *
 * Replaces Electron's natstack-panel:// custom protocol with a standard HTTP
 * server. Each panel's built HTML, JS, CSS, and assets are served under
 * /panels/:encodedPanelId/. The HTML is augmented with:
 *
 * 1. Injected globals (replacing Electron's preload/contextBridge)
 * 2. An inline WebSocket transport bridge (adapted from wsTransport.ts)
 * 3. Proper CSP headers
 *
 * Authentication: Per-panel tokens are passed as ?token= query params on core
 * resources (HTML, bundle.js, bundle.css). This matches the Electron protocol
 * handler's approach. The token is also embedded in the HTML for the inline
 * transport to send as ws:auth.
 */

import { createServer, type Server as HttpServer } from "http";
import * as path from "path";
import { randomBytes } from "crypto";
import { createDevLogger } from "../main/devLog.js";
import type { BuildResult } from "./buildV2/buildStore.js";

const log = createDevLogger("PanelHttpServer");

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

    log.info(`Stored panel: ${panelId} (token: ${httpToken.slice(0, 8)}...)`);
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
    const gitConfig = JSON.stringify({
      serverUrl: config.gitBaseUrl,
      token: config.gitToken,
      sourceRepo: "",
      resolvedRepoArgs: {},
    });
    const pubsubConfig = JSON.stringify({
      serverUrl: `ws://${this.host}:${config.pubsubPort}`,
      token: config.rpcToken,
    });
    const env = JSON.stringify({
      ...config.env,
      PARENT_ID: config.parentId ?? "",
      __GIT_CONFIG: JSON.stringify({
        serverUrl: config.gitBaseUrl,
        token: config.gitToken,
        sourceRepo: "",
        resolvedRepoArgs: {},
      }),
      __PUBSUB_CONFIG: JSON.stringify({
        serverUrl: `ws://${this.host}:${config.pubsubPort}`,
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
      `globalThis.process = { env: ${env} };`,
    ].join("\n");
  }

  /**
   * Generate the inline browser transport script. This is a self-contained
   * adaptation of src/preload/wsTransport.ts that runs in a regular browser
   * context (no Node.js, no Buffer, no process.argv).
   *
   * The transport implements the same ws:auth / ws:rpc / ws:stream-* protocol
   * as the Electron preload, and is assigned to globalThis.__natstackTransport.
   */
  private buildTransportScript(config: PanelConfig): string {
    // Determine WS URL scheme from page context at runtime
    const rpcPort = config.rpcPort;
    const authToken = config.rpcToken;
    const viewId = config.panelId;

    return `
// NatStack browser transport — adapted from src/preload/wsTransport.ts
globalThis.__natstackTransport = (function() {
  var listeners = new Set();
  var bufferedMessages = [];
  var outgoingBuffer = [];
  var pendingToolCallIds = new Set();
  var transportReady = false;
  var flushScheduled = false;
  var ws = null;
  var authenticated = false;
  var reconnectAttempt = 0;
  var viewId = ${JSON.stringify(viewId)};
  var authToken = ${JSON.stringify(authToken)};
  var rpcPort = ${JSON.stringify(rpcPort)};

  function normalizeEndpointId(targetId) {
    if (targetId.startsWith("panel:")) return targetId.slice(6);
    return targetId;
  }

  function deliver(fromId, message) {
    if (!transportReady) {
      bufferedMessages.push({ fromId: fromId, message: message });
      if (bufferedMessages.length > 500) bufferedMessages.shift();
      return;
    }
    listeners.forEach(function(listener) {
      try { listener(fromId, message); }
      catch (e) { console.error("Error in WS transport message handler:", e); }
    });
  }

  function wsSend(msg) {
    var data = JSON.stringify(msg);
    if (ws && ws.readyState === WebSocket.OPEN && authenticated) {
      ws.send(data);
    } else {
      outgoingBuffer.push(data);
      if (outgoingBuffer.length > 500) outgoingBuffer.shift();
    }
  }

  function flushOutgoing() {
    if (!ws || ws.readyState !== WebSocket.OPEN || !authenticated) return;
    outgoingBuffer.forEach(function(data) { ws.send(data); });
    outgoingBuffer.length = 0;
  }

  function translatePanelEvent(payload) {
    if (payload.panelId !== viewId) return;
    if (payload.type === "focus") {
      deliver("main", { type: "event", fromId: "main", event: "runtime:focus", payload: null });
    } else if (payload.type === "theme") {
      deliver("main", { type: "event", fromId: "main", event: "runtime:theme", payload: payload.theme });
    } else if (payload.type === "child-creation-error") {
      deliver("main", { type: "event", fromId: "main", event: "runtime:child-creation-error",
        payload: { url: payload.url, error: payload.error } });
    }
  }

  function handleServerMessage(msg) {
    switch (msg.type) {
      case "ws:auth-result":
        if (msg.success) { authenticated = true; reconnectAttempt = 0; flushOutgoing(); }
        else { console.error("[WsTransport] Auth failed:", msg.error); }
        break;
      case "ws:rpc":
        deliver("main", msg.message);
        break;
      case "ws:stream-chunk":
        deliver("main", { type: "event", fromId: "main", event: "ai:stream-text-chunk",
          payload: { streamId: msg.streamId, chunk: msg.chunk } });
        break;
      case "ws:stream-end":
        deliver("main", { type: "event", fromId: "main", event: "ai:stream-text-end",
          payload: { streamId: msg.streamId } });
        break;
      case "ws:tool-exec":
        pendingToolCallIds.add(msg.callId);
        deliver("main", { type: "request", requestId: msg.callId, fromId: "main",
          method: "ai.executeTool", args: [msg.streamId, msg.toolName, msg.args] });
        break;
      case "ws:event":
        if (msg.event === "panel:event") { translatePanelEvent(msg.payload); }
        else { deliver("main", { type: "event", fromId: "main", event: msg.event, payload: msg.payload }); }
        break;
      case "ws:panel-rpc-delivery":
        deliver(msg.fromId, msg.message);
        break;
    }
  }

  function connect() {
    var wsScheme = location.protocol === "https:" ? "wss" : "ws";
    var wsHost = location.hostname || "127.0.0.1";
    ws = new WebSocket(wsScheme + "://" + wsHost + ":" + rpcPort);

    ws.onopen = function() {
      ws.send(JSON.stringify({ type: "ws:auth", token: authToken }));
    };
    ws.onmessage = function(event) {
      try { handleServerMessage(JSON.parse(event.data)); }
      catch (e) { console.error("[WsTransport] Failed to parse:", e); }
    };
    ws.onclose = function(event) {
      authenticated = false;
      if (event.code === 4001 || event.code === 4005 || event.code === 4006) {
        if (event.code !== 4001) {
          console.error("[WsTransport] Terminal auth failure (" + event.code + "): " + event.reason);
          deliver("main", { type: "event", fromId: "main", event: "runtime:connection-error",
            payload: { code: event.code, reason: event.reason || "Authentication failed" } });
        }
        return;
      }
      var jitter = Math.random() * 500;
      var delay = Math.min(1000 * Math.pow(2, reconnectAttempt) + jitter, 10000);
      reconnectAttempt++;
      setTimeout(connect, delay);
    };
    ws.onerror = function() { /* close event handles reconnect */ };
  }

  connect();

  // Listen for stateArgs updates (mirrors setupStateArgsListener)
  function setupStateListener() {
    listeners.add(function(_fromId, message) {
      if (message && message.type === "event" && message.event === "stateArgs:updated") {
        globalThis.__natstackStateArgs = message.payload;
        window.dispatchEvent(new CustomEvent("natstack:stateArgsChanged", { detail: message.payload }));
      }
    });
  }

  return {
    send: function(targetId, message) {
      if (!message || typeof message !== "object" || typeof message.type !== "string") {
        return Promise.reject(new Error("Invalid RPC message"));
      }
      var normalized = normalizeEndpointId(targetId);

      if (normalized === "main") {
        if (message.type === "request") {
          wsSend({ type: "ws:rpc", message: message });
          return Promise.resolve();
        }
        if (message.type === "response") {
          if (pendingToolCallIds.has(message.requestId)) {
            pendingToolCallIds.delete(message.requestId);
            if ("error" in message) {
              wsSend({ type: "ws:tool-result", callId: message.requestId,
                result: { content: [{ type: "text", text: message.error }], isError: true } });
            } else {
              var result = message.result;
              if (!result || !Array.isArray(result.content)) {
                wsSend({ type: "ws:tool-result", callId: message.requestId,
                  result: { content: [{ type: "text", text: "Tool execution failed" }], isError: true } });
              } else {
                wsSend({ type: "ws:tool-result", callId: message.requestId, result: result });
              }
            }
          } else {
            wsSend({ type: "ws:rpc", message: message });
          }
          return Promise.resolve();
        }
        return Promise.resolve();
      }

      wsSend({ type: "ws:panel-rpc", targetId: normalized, message: message });
      return Promise.resolve();
    },
    onMessage: function(handler) {
      listeners.add(handler);
      if (!flushScheduled) {
        flushScheduled = true;
        queueMicrotask(function() {
          transportReady = true;
          bufferedMessages.forEach(function(b) {
            listeners.forEach(function(l) {
              try { l(b.fromId, b.message); } catch(e) { console.error("Buffered delivery error:", e); }
            });
          });
          bufferedMessages.length = 0;
        });
      }
      return function() { listeners.delete(handler); };
    }
  };
})();

// Set up stateArgs listener after transport is created
(function() {
  globalThis.__natstackTransport.onMessage(function(_fromId, message) {
    if (message && message.type === "event" && message.event === "stateArgs:updated") {
      globalThis.__natstackStateArgs = message.payload;
      window.dispatchEvent(new CustomEvent("natstack:stateArgsChanged", { detail: message.payload }));
    }
  });
})();
`;
  }

  // =========================================================================
  // Index page
  // =========================================================================

  private serveIndex(res: import("http").ServerResponse): void {
    const panelEntries = Array.from(this.panels.entries()).map(([id, panel]) => {
      const encodedId = encodeURIComponent(id);
      const encodedToken = encodeURIComponent(panel.httpToken);
      const url = `/panels/${encodedId}/?token=${encodedToken}`;
      return `<li><a href="${url}">${escapeHtml(panel.title)} <code>${escapeHtml(id)}</code></a></li>`;
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
