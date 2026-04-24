/**
 * Gateway — Single-port HTTP/WS router for NatStack server.
 *
 * In-process routing for RPC and PanelHttp (zero-overhead handler dispatch).
 * Reverse proxy only for external processes (git server, workerd).
 *
 * The gateway is always present in standalone mode. In Electron IPC mode,
 * the Electron process runs its own RpcServer — the gateway is not needed.
 */

import { createServer, request, type Server as HttpServer, type IncomingMessage, type ServerResponse } from "http";
import { createServer as createHttpsServer } from "https";
import { randomBytes } from "crypto";
import * as fs from "fs";
import { WebSocketServer, WebSocket } from "ws";
import type { Duplex } from "stream";
import { createDevLogger } from "@natstack/dev-log";
import { constantTimeStringEqual } from "@natstack/shared/tokenManager";
import type { RouteRegistry, LookupResult } from "./routeRegistry.js";

const log = createDevLogger("Gateway");

// ---------------------------------------------------------------------------
// Per-upstream gateway credentials (audit finding #32).
//
// Wave-1 stripped inbound `Authorization` before forwarding to workerd /
// git upstreams (so panel/admin tokens never leak into workerd-served
// code). What was missing: an upstream-scoped credential that lets the
// upstream attribute the request to "the gateway" rather than "anonymous
// loopback caller". We mint a fresh random token per upstream at gateway
// construction time and stamp it onto every forwarded request.
//
// The receiving side (workerd entrypoint, git server) must validate the
// bearer matches its expected token. Wiring that validation into workerd
// and the git server is OUT of this agent's file scope.
//
// TODO(security-audit-wave2-agent-1): wire WORKERD_GATEWAY_TOKEN into
// `src/server/workerdManager.ts` so that the workerd entrypoint refuses
// requests whose Authorization bearer does not match the env-injected
// token. Pass via `WORKERD_GATEWAY_TOKEN` env binding on workerd start.
// TODO(security-audit-wave2-agent-1): wire GIT_GATEWAY_TOKEN into
// `src/server/gitServer.ts` so the git server validates the bearer
// before serving any /_git/ request. Until that lands, the bearer is
// stamped but unverified.
// ---------------------------------------------------------------------------

/**
 * Headers that must NEVER be forwarded from inbound gateway requests to
 * upstream workerd / git proxies (audit finding #32). These carry
 * gateway-level authority that the upstream must not see; the upstream
 * gets its own narrow credential injected (or, for git, no credential at
 * all — git auth is handled by the git server's own bearer scheme).
 *
 * `x-natstack-*` covers `x-natstack-token` (admin) and any future
 * NatStack-internal admin-bearing headers.
 */
const STRIP_UPSTREAM_HEADERS = new Set<string>([
  "authorization",
  "cookie",
  "proxy-authorization",
]);

function stripUpstreamHeaders(
  headers: IncomingMessage["headers"],
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    const lower = k.toLowerCase();
    if (STRIP_UPSTREAM_HEADERS.has(lower)) continue;
    if (lower.startsWith("x-natstack-")) continue;
    out[k] = v as string | string[];
  }
  return out;
}

/** Handler interface for PanelHttpServer (in-process dispatch) */
export interface PanelHttpHandler {
  handleGatewayRequest(req: IncomingMessage, res: ServerResponse): void;
  handleGatewayUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
}

/** Handler interface for RpcServer (in-process dispatch) */
export interface RpcHandler {
  /** Accept a pre-upgraded WebSocket connection from the gateway */
  handleGatewayWsConnection(ws: WebSocket): void;
  /** Handle an HTTP POST /rpc request */
  handleGatewayHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> | void;
}

export interface GatewayDeps {
  /** In-process RPC handler */
  rpcHandler?: RpcHandler;
  /** In-process panel HTTP handler */
  panelHttpHandler?: PanelHttpHandler;
  /** Git server port for /_git/ path (reverse proxy) */
  gitPort?: number;
  /** Workerd port for /_w/ path (reverse proxy) */
  workerdPort?: number | null;
  /** External hostname for generated public URLs and origin checks */
  externalHost: string;
  /** Bind host (default "0.0.0.0") */
  bindHost?: string;
  /** Path to TLS certificate file (enables HTTPS) */
  tlsCert?: string;
  /** Path to TLS private key file (enables HTTPS) */
  tlsKey?: string;
  /** Called by /healthz to produce the JSON body */
  healthProvider?: (detailed: boolean) => Record<string, unknown>;
  /** Admin token — when provided and matches ?token= query arg, /healthz returns detailed fields */
  adminToken?: string;
  /** Route registry for `/_r/` dispatch (worker and service routes). Optional
   *  — when absent, `/_r/` paths fall through to 404. */
  routeRegistry?: RouteRegistry;
}

export class Gateway {
  private server: HttpServer | null = null;
  private wss: WebSocketServer | null = null;
  private deps: GatewayDeps;
  /** Per-upstream gateway-internal bearer tokens (audit #32). Minted once at
   *  construction; stamped onto every forwarded request after inbound auth
   *  headers are stripped. */
  private readonly workerdGatewayToken: string;
  private readonly gitGatewayToken: string;

  constructor(deps: GatewayDeps) {
    this.deps = deps;
    this.workerdGatewayToken = randomBytes(32).toString("hex");
    this.gitGatewayToken = randomBytes(32).toString("hex");
  }

  /** Bearer token the gateway uses when calling workerd. The workerd
   *  entrypoint should be configured to require this exact token. */
  getWorkerdGatewayToken(): string {
    return this.workerdGatewayToken;
  }

  /** Bearer token the gateway uses when calling the git server. */
  getGitGatewayToken(): string {
    return this.gitGatewayToken;
  }


  async start(port: number): Promise<number> {
    const { rpcHandler, panelHttpHandler, gitPort, workerdPort, tlsCert, tlsKey } = this.deps;

    const { healthProvider, adminToken, routeRegistry } = this.deps;
    const workerdToken = this.workerdGatewayToken;
    const gitToken = this.gitGatewayToken;

    const requestHandler = (req: IncomingMessage, res: ServerResponse) => {
      const url = req.url ?? "/";

      // /healthz → liveness + (token-gated) detailed status. No auth for basic
      // probe. Token can arrive via `?token=` query (convenient for curl) OR
      // via `X-NatStack-Token` header (what the main-process health poller
      // uses — keeps the admin token out of URLs / proxy logs).
      if (req.method === "GET" && (url === "/healthz" || url.startsWith("/healthz?"))) {
        let detailed = false;
        // Default-deny: the detailed branch is only reachable when the host
        // configured an admin token AND the caller presents the matching
        // token. No token configured ⇒ no detailed branch (audit #25).
        if (adminToken) {
          const qIdx = url.indexOf("?");
          if (qIdx !== -1) {
            const params = new URLSearchParams(url.slice(qIdx + 1));
            const qToken = params.get("token");
            if (qToken && constantTimeStringEqual(qToken, adminToken)) {
              detailed = true;
            }
          }
          const headerToken = req.headers["x-natstack-token"];
          if (typeof headerToken === "string" && headerToken.length > 0
              && constantTimeStringEqual(headerToken, adminToken)) {
            detailed = true;
          }
        }
        const body = healthProvider
          ? healthProvider(detailed)
          : { ok: true };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
        return;
      }

      // /_w/ → workerd reverse proxy
      if (url.startsWith("/_w/") && workerdPort) {
        return proxyRequest(req, res, workerdPort, url, workerdToken);
      }

      // /_r/ → route registry dispatch (worker + service HTTP routes)
      if (url.startsWith("/_r/") && routeRegistry) {
        const handled = handleRouteRequest(
          req,
          res,
          url,
          routeRegistry,
          workerdPort,
          adminToken,
          workerdToken,
        );
        if (handled) return;
        // Fall through to 404 below — no panel fallback for `/_r/` misses.
      }

      // /_git/ → git server reverse proxy
      if (url.startsWith("/_git/") && gitPort) {
        const gitPath = url.slice(5); // strip /_git prefix
        return proxyRequest(req, res, gitPort, gitPath, gitToken);
      }

      // POST /rpc → RPC handler (in-process)
      if (url === "/rpc" && req.method === "POST" && rpcHandler) {
        return rpcHandler.handleGatewayHttpRequest(req, res);
      }

      // Everything else → panel HTTP handler (in-process)
      if (panelHttpHandler) {
        return panelHttpHandler.handleGatewayRequest(req, res);
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
    };

    // Create HTTP or HTTPS server
    if (tlsCert && tlsKey) {
      this.server = createHttpsServer(
        { cert: fs.readFileSync(tlsCert), key: fs.readFileSync(tlsKey) },
        requestHandler,
      );
    } else {
      this.server = createServer(requestHandler);
    }

    // WebSocket upgrade routing. No payload cap is configured here so the
    // gateway preserves existing WebSocket behavior for large developer flows.
    this.wss = new WebSocketServer({ noServer: true });

    const externalHost = this.deps.externalHost;
    const allowedOrigins = buildOriginAllowList(externalHost);

    this.server.on("upgrade", (req, socket, head) => {
      const url = req.url ?? "/";

      // Origin allow-list (audit #30). Bearer auth still gates the actual
      // RPC, but rejecting cross-site browser connects defends against the
      // case where a malicious local web page learns the loopback port and
      // tries to ride an existing token via XSS.
      if (!isOriginAllowed(req.headers["origin"], allowedOrigins)) {
        log.warn(`WS upgrade rejected: disallowed Origin ${String(req.headers["origin"])}`);
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }

      // /rpc → RPC WebSocket (in-process via WSS)
      if ((url === "/rpc" || url.startsWith("/rpc?")) && rpcHandler) {
        this.wss!.handleUpgrade(req, socket, head, (ws) => {
          rpcHandler.handleGatewayWsConnection(ws);
        });
        return;
      }

      // /_w/ → workerd WebSocket proxy
      if (url.startsWith("/_w/") && workerdPort) {
        return proxyUpgrade(req, socket, head, workerdPort, workerdToken);
      }

      // /_r/ → route registry dispatch (worker + service WS routes)
      if (url.startsWith("/_r/") && routeRegistry) {
        const handled = handleRouteUpgrade(
          req,
          socket,
          head,
          url,
          routeRegistry,
          workerdPort,
          adminToken,
          workerdToken,
        );
        if (handled) return;
        // Miss → fall through to destroy below.
      }

      // Default: panel HTTP handler (CDP bridge, etc.)
      if (panelHttpHandler) {
        return panelHttpHandler.handleGatewayUpgrade(req, socket, head);
      }

      socket.destroy();
    });

    const isTls = !!(tlsCert && tlsKey);
    const bindHost = this.deps.bindHost ?? "0.0.0.0";
    return new Promise((resolve, reject) => {
      this.server!.listen(port, bindHost, () => {
        const addr = this.server!.address();
        const assignedPort = typeof addr === "object" && addr ? addr.port : port;
        log.info(`Gateway listening on ${bindHost}:${assignedPort}${isTls ? " (TLS)" : ""}`);
        resolve(assignedPort);
      });
      this.server!.on("error", reject);
    });
  }

  getPort(): number | null {
    const addr = this.server?.address();
    return typeof addr === "object" && addr ? addr.port : null;
  }

  async stop(): Promise<void> {
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
    if (!this.server) return;
    return new Promise((resolve) => {
      this.server!.close(() => resolve());
    });
  }
}

// ===========================================================================
// Origin allow-list helpers (audit finding #30)
// ===========================================================================

/**
 * Build the set of allowed Origin header values for incoming WS upgrades.
 * Empty Origin is treated separately by `isOriginAllowed` (Node clients,
 * curl, the Electron preload, etc., do not send Origin).
 *
 * The list intentionally does not contain a port: we accept any port the
 * caller used (the gateway is loopback-bound on the dev host; in remote
 * mode the externalHost resolves to a fixed published port).
 *
 * Override / extension: set `NATSTACK_WS_ALLOWED_ORIGINS` to a comma list
 * of additional origins (e.g. `http://my-dev-host:5173,chrome-extension://xyz`).
 */
function buildOriginAllowList(externalHost: string): { exact: Set<string>; suffix: Set<string> } {
  const exact = new Set<string>();
  const suffix = new Set<string>();
  // Bare host on http/https.
  exact.add(`http://${externalHost}`);
  exact.add(`https://${externalHost}`);
  // Loopback dev origins.
  for (const h of ["localhost", "127.0.0.1", "[::1]"]) {
    exact.add(`http://${h}`);
    exact.add(`https://${h}`);
  }
  // Custom panel/extension origins via env.
  const extra = process.env["NATSTACK_WS_ALLOWED_ORIGINS"];
  if (extra) {
    for (const raw of extra.split(",")) {
      const v = raw.trim();
      if (v) exact.add(v);
    }
  }
  return { exact, suffix };
}

/**
 * Decide whether an inbound WS upgrade Origin is allowed.
 *
 * Allow:
 *   (a) absent / empty Origin (Node clients, Electron preload that does not
 *       set Origin on direct ws connects, native CDP libraries),
 *   (b) literal `null` (some `about:blank` / sandboxed iframe contexts),
 *   (c) origin scheme://host[:port] whose host matches an allowed host or
 *       an allowed host.
 */
function isOriginAllowed(
  origin: string | string[] | undefined,
  allowed: { exact: Set<string>; suffix: Set<string> },
): boolean {
  if (origin === undefined) return true;
  const value = Array.isArray(origin) ? origin[0] : origin;
  if (value === undefined || value === "") return true;
  if (value === "null") return true;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  const originBase = `${parsed.protocol}//${parsed.host}`;
  const originNoPort = `${parsed.protocol}//${parsed.hostname}`;
  if (allowed.exact.has(originBase)) return true;
  if (allowed.exact.has(originNoPort)) return true;
  for (const suffix of allowed.suffix) {
    if (parsed.hostname.endsWith(suffix.replace(/^\./, ""))) return true;
    if (parsed.hostname === suffix.replace(/^\./, "")) return true;
  }
  return false;
}

// ===========================================================================
// Reverse proxy helpers (for external processes: git, workerd)
// ===========================================================================

function proxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  targetPort: number,
  targetPath: string,
  upstreamToken: string,
  hostHeader?: string,
): void {
  // Strip inbound auth/cookie/X-NatStack-* before forwarding (audit #32).
  // Workerd-served code is untrusted-by-design; it must never see the
  // gateway's admin token, the panel's bearer, or session cookies. After
  // stripping, stamp a per-upstream gateway-internal bearer so the
  // upstream can attribute the request to "the gateway".
  const safeHeaders = stripUpstreamHeaders(req.headers);
  safeHeaders["authorization"] = `Bearer ${upstreamToken}`;
  if (hostHeader) safeHeaders["host"] = hostHeader;

  const proxyReq = request(
    {
      hostname: "127.0.0.1",
      port: targetPort,
      path: targetPath,
      method: req.method,
      headers: safeHeaders,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.on("error", (err) => {
        log.warn(`Proxy response stream error: ${err.message}`);
        try { res.end(); } catch { /* already closed */ }
      });
      proxyRes.pipe(res);
    },
  );

  proxyReq.on("error", (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "text/plain" });
    }
    res.end(`Gateway proxy error: ${err.message}`);
  });

  req.pipe(proxyReq);
}

function proxyUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  targetPort: number,
  upstreamToken: string,
): void {
  // Strip inbound auth/cookie/X-NatStack-* (audit #32). See proxyRequest.
  // After stripping, stamp the per-upstream gateway bearer.
  const safeHeaders = stripUpstreamHeaders(req.headers);
  safeHeaders["authorization"] = `Bearer ${upstreamToken}`;
  const { connect } = require("net") as typeof import("net");
  const targetSocket = connect(targetPort, "127.0.0.1", () => {
    const headers = Object.entries(safeHeaders)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
      .join("\r\n");
    const upgradeReq = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${headers}\r\n\r\n`;

    targetSocket.write(upgradeReq);
    if (head.length > 0) targetSocket.write(head);

    socket.pipe(targetSocket);
    targetSocket.pipe(socket);
  });

  targetSocket.on("error", (err) => {
    log.warn(`Gateway WS proxy error: ${err.message}`);
    socket.destroy();
  });

  socket.on("error", () => {
    targetSocket.destroy();
  });
}

// ===========================================================================
// Route registry dispatch (`/_r/w/...` and `/_r/s/...`)
// ===========================================================================

/** Extract an admin-token-equivalent value from query or `X-NatStack-Token` header. */
function extractRouteToken(url: string, req: IncomingMessage): string | null {
  const qIdx = url.indexOf("?");
  if (qIdx !== -1) {
    const params = new URLSearchParams(url.slice(qIdx + 1));
    const qToken = params.get("token");
    if (qToken) return qToken;
  }
  const h = req.headers["x-natstack-token"];
  if (typeof h === "string" && h.length > 0) return h;
  return null;
}

function enforceAuth(
  lookup: LookupResult,
  req: IncomingMessage,
  url: string,
  adminToken: string | undefined,
): boolean {
  if (lookup.auth !== "admin-token") return true;
  // Default-deny when no admin token is configured (audit #25): without a
  // token there is no way to authenticate, so the route is unreachable.
  if (!adminToken) return false;
  const presented = extractRouteToken(url, req);
  if (!presented) return false;
  // Constant-time compare (audit #33).
  return constantTimeStringEqual(presented, adminToken);
}

/**
 * Build the rewritten target path for a worker-route lookup.
 *
 * - DO-backed: `/_w/<source0>/<source1>/<className>/<objectKey>/<remainder>`
 * - Regular-worker: `/<instanceName>/<remainder>`
 *
 * Preserves the original query string.
 */
function buildWorkerTargetPath(
  lookup: Extract<LookupResult, { kind: "worker-do" | "worker-regular" }>,
  originalUrl: string,
): string {
  const qIdx = originalUrl.indexOf("?");
  const query = qIdx !== -1 ? originalUrl.slice(qIdx) : "";
  const remainder = lookup.remainder === "/" ? "" : lookup.remainder;
  if (lookup.kind === "worker-do") {
    return `/_w/${lookup.source}/${lookup.className}/${lookup.objectKey}${remainder}${query}`;
  }
  return `/${lookup.targetInstanceName}${remainder}${query}`;
}

/**
 * Handle a non-upgrade HTTP request that matched `/_r/`. Returns `true` if
 * the request was handled (response started or dispatched); `false` if the
 * caller should continue with fallbacks.
 */
function handleRouteRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  routeRegistry: RouteRegistry,
  workerdPort: number | null | undefined,
  adminToken: string | undefined,
  workerdToken: string,
): boolean {
  const qIdx = url.indexOf("?");
  const pathOnly = qIdx === -1 ? url : url.slice(0, qIdx);
  const method = req.method ?? "GET";
  const result = routeRegistry.lookup(pathOnly, method, false);
  if (result === null) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Route not found");
    return true;
  }
  if (result === "method-not-allowed") {
    res.writeHead(405, { "Content-Type": "text/plain" });
    res.end("Method Not Allowed");
    return true;
  }

  if (!enforceAuth(result, req, url, adminToken)) {
    res.writeHead(401, { "Content-Type": "text/plain" });
    res.end("Unauthorized");
    return true;
  }

  if (result.kind === "service") {
    void Promise.resolve(result.handler(req, res, result.params)).catch((err) => {
      log.warn(`Service route handler error (${result.serviceName}):`, err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal Server Error");
      } else {
        try { res.end(); } catch { /* already closed */ }
      }
    });
    return true;
  }

  // worker-do / worker-regular → reverse proxy to workerd with rewritten path.
  if (!workerdPort) {
    res.writeHead(503, { "Content-Type": "text/plain" });
    res.end("workerd not running");
    return true;
  }
  const targetPath = buildWorkerTargetPath(result, url);
  proxyRequest(req, res, workerdPort, targetPath, workerdToken);
  return true;
}

/**
 * Handle a WebSocket upgrade that matched `/_r/`. Returns `true` if handled.
 */
function handleRouteUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  url: string,
  routeRegistry: RouteRegistry,
  workerdPort: number | null | undefined,
  adminToken: string | undefined,
  workerdToken: string,
): boolean {
  const qIdx = url.indexOf("?");
  const pathOnly = qIdx === -1 ? url : url.slice(0, qIdx);
  const method = req.method ?? "GET";
  const result = routeRegistry.lookup(pathOnly, method, true);
  if (result === null || result === "method-not-allowed") {
    socket.destroy();
    return true;
  }

  if (!enforceAuth(result, req, url, adminToken)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return true;
  }

  if (result.kind === "service") {
    if (!result.onUpgrade) {
      socket.destroy();
      return true;
    }
    try {
      result.onUpgrade(req, socket, head, result.params);
    } catch (err) {
      log.warn(`Service route onUpgrade error (${result.serviceName}):`, err);
      socket.destroy();
    }
    return true;
  }

  if (!workerdPort) {
    socket.destroy();
    return true;
  }
  // Rewrite req.url so the upstream (workerd) sees the rewritten path.
  req.url = buildWorkerTargetPath(result, url);
  proxyUpgrade(req, socket, head, workerdPort, workerdToken);
  return true;
}
