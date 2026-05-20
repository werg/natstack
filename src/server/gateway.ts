/**
 * Gateway — Single-port HTTP/WS router for NatStack server.
 *
 * In-process routing for RPC, PanelHttp, and git, plus reverse proxying for
 * external worker processes.
 *
 * The gateway is the single caller-facing ingress in both standalone and
 * Electron-managed server modes.
 */

import {
  createServer,
  request,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "http";
import { createServer as createHttpsServer } from "https";
import { randomBytes } from "crypto";
import * as fs from "fs";
import { connect as connectNet } from "net";
import { WebSocketServer, WebSocket } from "ws";
import type { Duplex } from "stream";
import { createDevLogger } from "@natstack/dev-log";
import { constantTimeStringEqual, type TokenManager } from "@natstack/shared/tokenManager";
import {
  createVerifiedCaller,
  type CallerKind,
  type VerifiedCaller,
} from "@natstack/shared/serviceDispatcher";
import type { RouteRegistry, LookupResult } from "./routeRegistry.js";
import { assertPresent } from "../lintHelpers";
import type { EntityCache } from "@natstack/shared/runtime/entityCache";
import { resolveCodeIdentity } from "./services/principalIdentity.js";

const log = createDevLogger("Gateway");

// ---------------------------------------------------------------------------
// Per-upstream gateway credentials (audit finding #32).
//
// Inbound `Authorization` and `x-natstack-*` headers are stripped before
// forwarding to upstream processes so panel/admin tokens never leak past the
// gateway. Workerd receives a gateway-scoped bearer that its router validates.
// Git is dispatched in-process after caller bearer validation, so it receives
// caller identity directly rather than a forwarded bearer.
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
const STRIP_UPSTREAM_HEADERS = new Set<string>(["authorization", "cookie", "proxy-authorization"]);

function stripUpstreamHeaders(
  headers: IncomingMessage["headers"]
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

export interface GitHttpHandler {
  handleHttpRequest(
    req: IncomingMessage,
    res: ServerResponse,
    caller: VerifiedCaller | null
  ): Promise<void> | void;
}

export interface ExtensionHttpHandler {
  handleExtensionHttpRequest(
    req: IncomingMessage,
    res: ServerResponse,
    name: string,
    remainderPath: string,
    caller: VerifiedCaller
  ): Promise<void> | void;
}

export interface GatewayDeps {
  /** In-process RPC handler */
  rpcHandler?: RpcHandler;
  /** Dynamic in-process RPC handler getter. */
  getRpcHandler?: () => RpcHandler | null | undefined;
  /** In-process panel HTTP handler */
  panelHttpHandler?: PanelHttpHandler;
  /** Dynamic in-process panel HTTP handler getter. */
  getPanelHttpHandler?: () => PanelHttpHandler | null | undefined;
  /** Dynamic in-process git handler getter. */
  getGitHandler?: () => GitHttpHandler | null | undefined;
  /** Dynamic in-process extension fetch handler getter. */
  getExtensionHttpHandler?: () => ExtensionHttpHandler | null | undefined;
  /** Workerd port for /_w/ path (reverse proxy) */
  workerdPort?: number | null;
  /** Dynamic workerd port getter. */
  getWorkerdPort?: () => number | null | undefined;
  /** Optional pre-shared workerd gateway token. */
  workerdGatewayToken?: string;
  /** Internal secret stamped onto gateway-authorized DO dispatches. */
  getWorkerdDispatchSecret?: () => string | null | undefined;
  /** External hostname for generated public URLs and origin checks */
  externalHost: string;
  /** Current public URL for origin checks, including --public-url / NATSTACK_PUBLIC_URL overrides. */
  getPublicUrl?: () => string | null | undefined;
  /** Bind host (default "0.0.0.0") */
  bindHost?: string;
  /** Path to TLS certificate file (enables HTTPS) */
  tlsCert?: string;
  /** Path to TLS private key file (enables HTTPS) */
  tlsKey?: string;
  /** Called by /healthz to produce the JSON body */
  healthProvider?: (detailed: boolean) => Record<string, unknown>;
  /** Admin token — when provided and presented as Bearer, /healthz returns detailed fields */
  adminToken?: string;
  /** Caller token manager for route auth modes used by panels/workers/shell/server callers. */
  tokenManager: TokenManager;
  /** Principal metadata for authenticated caller tokens. */
  entityCache?: Pick<EntityCache, "resolve" | "resolveActive" | "resolveSource">;
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

  constructor(deps: GatewayDeps) {
    this.deps = deps;
    this.workerdGatewayToken = deps.workerdGatewayToken ?? randomBytes(32).toString("hex");
  }

  /** Bearer token the gateway uses when calling workerd. The workerd
   *  entrypoint should be configured to require this exact token. */
  getWorkerdGatewayToken(): string {
    return this.workerdGatewayToken;
  }

  async start(port: number): Promise<number> {
    const { tlsCert, tlsKey } = this.deps;

    const { healthProvider, adminToken, tokenManager, routeRegistry } = this.deps;
    const workerdToken = this.workerdGatewayToken;

    const requestHandler = (req: IncomingMessage, res: ServerResponse) => {
      const url = req.url ?? "/";
      const rpcHandler = this.deps.getRpcHandler?.() ?? this.deps.rpcHandler;
      const panelHttpHandler = this.deps.getPanelHttpHandler?.() ?? this.deps.panelHttpHandler;
      const gitHandler = this.deps.getGitHandler?.();
      const extensionHttpHandler = this.deps.getExtensionHttpHandler?.();
      const workerdPort = this.deps.getWorkerdPort?.() ?? this.deps.workerdPort;

      // /healthz → liveness + (token-gated) detailed status. No auth for basic
      // probe. Detailed status requires the admin token as a Bearer token.
      if (req.method === "GET" && (url === "/healthz" || url.startsWith("/healthz?"))) {
        let detailed = false;
        if (adminToken) {
          const bearer = extractBearerToken(req);
          if (bearer && constantTimeStringEqual(bearer, adminToken)) {
            detailed = true;
          }
        }
        const body = healthProvider ? healthProvider(detailed) : { ok: true };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
        return;
      }

      // /_w/ → workerd reverse proxy
      if (url.startsWith("/_w/")) {
        if (!validateCallerBearer(req, tokenManager, this.deps.entityCache)) {
          res.writeHead(401, { "Content-Type": "text/plain" });
          res.end("Unauthorized");
          return;
        }
        if (!workerdPort) {
          res.writeHead(503, { "Content-Type": "text/plain" });
          res.end("Service starting up");
          return;
        }
        const dispatchSecret = this.deps.getWorkerdDispatchSecret?.();
        if (!dispatchSecret) {
          res.writeHead(503, { "Content-Type": "text/plain" });
          res.end("DO dispatch unavailable");
          return;
        }
        const providedSecret = req.headers["x-natstack-dispatch-secret"];
        if (
          typeof providedSecret !== "string" ||
          !constantTimeStringEqual(providedSecret, dispatchSecret)
        ) {
          res.writeHead(403, { "Content-Type": "text/plain" });
          res.end("Forbidden");
          return;
        }
        return proxyRequest(req, res, workerdPort, url, workerdToken, undefined, {
          "X-NatStack-Dispatch-Secret": dispatchSecret,
        });
      }

      // /_r/ext/<encoded-name>/* → extension fetch surface.
      if (url.startsWith("/_r/ext/") && extensionHttpHandler) {
        const parsed = parseExtensionRoute(url);
        if (!parsed) {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("Extension route not found");
          return;
        }
        const entry = validateCallerBearer(req, tokenManager, this.deps.entityCache);
        if (!entry) {
          res.writeHead(401, { "Content-Type": "text/plain" });
          res.end("Unauthorized");
          return;
        }
        return extensionHttpHandler.handleExtensionHttpRequest(
          req,
          res,
          parsed.name,
          parsed.remainderPath,
          entry
        );
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
          tokenManager,
          workerdToken,
          this.deps.getWorkerdDispatchSecret?.()
        );
        if (handled) return;
        // Fall through to 404 below — no panel fallback for `/_r/` misses.
      }

      // /_git/ → git server reverse proxy
      if (url.startsWith("/_git/") && gitHandler) {
        if (req.method === "OPTIONS") {
          return gitHandler.handleHttpRequest(req, res, null);
        }
        const entry = validateCallerBearer(req, tokenManager, this.deps.entityCache);
        if (!entry) {
          res.writeHead(401, { "Content-Type": "text/plain" });
          res.end("Unauthorized");
          return;
        }
        return gitHandler.handleHttpRequest(req, res, entry);
      }

      // POST /rpc → RPC handler (in-process). `/rpc/stream` is the
      // streaming RPC variant for Response-returning service methods,
      // including the credentials.proxyFetch fast path.
      if ((url === "/rpc" || url === "/rpc/stream") && req.method === "POST" && rpcHandler) {
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
        requestHandler
      );
    } else {
      this.server = createServer(requestHandler);
    }

    // WebSocket upgrade routing. No payload cap is configured here so the
    // gateway preserves existing WebSocket behavior for large developer flows.
    this.wss = new WebSocketServer({ noServer: true });

    this.server.on("upgrade", (req, socket, head) => {
      const url = req.url ?? "/";
      const rpcHandler = this.deps.getRpcHandler?.() ?? this.deps.rpcHandler;
      const panelHttpHandler = this.deps.getPanelHttpHandler?.() ?? this.deps.panelHttpHandler;
      const workerdPort = this.deps.getWorkerdPort?.() ?? this.deps.workerdPort;
      const allowedOrigins = buildOriginAllowList(
        this.deps.externalHost,
        this.deps.getPublicUrl?.()
      );

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
        assertPresent(this.wss).handleUpgrade(req, socket, head, (ws) => {
          rpcHandler.handleGatewayWsConnection(ws);
        });
        return;
      }

      // /_w/ → workerd WebSocket proxy
      if (url.startsWith("/_w/")) {
        if (!validateCallerBearer(req, tokenManager, this.deps.entityCache)) {
          socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
          socket.destroy();
          return;
        }
        if (!workerdPort) {
          socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
          socket.destroy();
          return;
        }
        const dispatchSecret = this.deps.getWorkerdDispatchSecret?.();
        if (!dispatchSecret) {
          socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
          socket.destroy();
          return;
        }
        const providedSecret = req.headers["x-natstack-dispatch-secret"];
        if (
          typeof providedSecret !== "string" ||
          !constantTimeStringEqual(providedSecret, dispatchSecret)
        ) {
          socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
          socket.destroy();
          return;
        }
        return proxyUpgrade(req, socket, head, workerdPort, workerdToken, {
          "X-NatStack-Dispatch-Secret": dispatchSecret,
        });
      }

      // Extension fetch routes do not support WebSocket upgrade in v1.
      if (url.startsWith("/_r/ext/")) {
        socket.write("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
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
          tokenManager,
          workerdToken,
          this.deps.getWorkerdDispatchSecret?.()
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
      assertPresent(this.server).listen(port, bindHost, () => {
        const addr = assertPresent(this.server).address();
        const assignedPort = typeof addr === "object" && addr ? addr.port : port;
        log.info(`Gateway listening on ${bindHost}:${assignedPort}${isTls ? " (TLS)" : ""}`);
        resolve(assignedPort);
      });
      assertPresent(this.server).on("error", reject);
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
      assertPresent(this.server).close(() => resolve());
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
function buildOriginAllowList(
  externalHost: string,
  publicUrl?: string | null
): { exact: Set<string>; suffix: Set<string> } {
  const exact = new Set<string>();
  const suffix = new Set<string>();
  // Bare host on http/https.
  exact.add(`http://${externalHost}`);
  exact.add(`https://${externalHost}`);
  if (publicUrl) {
    try {
      const parsed = new URL(publicUrl);
      exact.add(parsed.origin);
      exact.add(`${parsed.protocol}//${parsed.hostname}`);
    } catch {
      log.warn(`Ignoring invalid public URL for WS Origin allow-list: ${publicUrl}`);
    }
  }
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
  allowed: { exact: Set<string>; suffix: Set<string> }
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
  extraHeaders: Record<string, string> = {}
): void {
  // Strip inbound auth/cookie/X-NatStack-* before forwarding (audit #32).
  // Workerd-served code is untrusted-by-design; it must never see the
  // gateway's admin token, the panel's bearer, or session cookies. After
  // stripping, stamp a per-upstream gateway-internal bearer so the
  // upstream can attribute the request to "the gateway".
  const safeHeaders = stripUpstreamHeaders(req.headers);
  safeHeaders["authorization"] = `Bearer ${upstreamToken}`;
  if (hostHeader) safeHeaders["host"] = hostHeader;
  Object.assign(safeHeaders, extraHeaders);

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
        try {
          res.end();
        } catch {
          /* already closed */
        }
      });
      proxyRes.pipe(res);
    }
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
  extraHeaders: Record<string, string> = {}
): void {
  // Strip inbound auth/cookie/X-NatStack-* (audit #32). See proxyRequest.
  // After stripping, stamp the per-upstream gateway bearer.
  const safeHeaders = stripUpstreamHeaders(req.headers);
  safeHeaders["authorization"] = `Bearer ${upstreamToken}`;
  Object.assign(safeHeaders, extraHeaders);
  const targetSocket = connectNet(targetPort, "127.0.0.1", () => {
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

function extractBearerToken(req: IncomingMessage): string | null {
  const h = req.headers["authorization"];
  if (typeof h !== "string" || !h.startsWith("Bearer ")) return null;
  const token = h.slice("Bearer ".length);
  return token.length > 0 ? token : null;
}

function validateCallerBearer(
  req: IncomingMessage,
  tokenManager: TokenManager,
  entityCache?: Pick<EntityCache, "resolveActive">
): VerifiedCaller | null {
  const token = extractBearerToken(req);
  if (!token) return null;
  const entry = tokenManager.validateToken(token);
  if (!entry) return null;
  return createVerifiedCaller(
    entry.callerId,
    entry.callerKind as CallerKind,
    entityCache ? (resolveCodeIdentity(entityCache, entry.callerId) ?? undefined) : undefined
  );
}

function validateAdminBearer(req: IncomingMessage, adminToken: string | undefined): boolean {
  if (!adminToken) return false;
  const token = extractBearerToken(req);
  if (!token) return false;
  return constantTimeStringEqual(token, adminToken);
}

function parseExtensionRoute(url: string): { name: string; remainderPath: string } | null {
  const qIdx = url.indexOf("?");
  const pathOnly = qIdx === -1 ? url : url.slice(0, qIdx);
  const prefix = "/_r/ext/";
  if (!pathOnly.startsWith(prefix)) return null;
  const rest = pathOnly.slice(prefix.length);
  const slash = rest.indexOf("/");
  const encodedName = slash === -1 ? rest : rest.slice(0, slash);
  if (!encodedName) return null;
  try {
    return {
      name: decodeURIComponent(encodedName),
      remainderPath: slash === -1 ? "/" : `/${rest.slice(slash + 1)}`,
    };
  } catch {
    return null;
  }
}

function enforceAuth(
  lookup: LookupResult,
  req: IncomingMessage,
  _url: string,
  adminToken: string | undefined,
  tokenManager: TokenManager
): boolean {
  switch (lookup.auth) {
    case "public":
      return true;
    case "admin-token":
      return validateAdminBearer(req, adminToken);
    case "caller-token":
      return validateCallerBearer(req, tokenManager) !== null;
  }
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
  originalUrl: string
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
  tokenManager: TokenManager,
  workerdToken: string,
  workerdDispatchSecret?: string | null
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

  if (!enforceAuth(result, req, url, adminToken, tokenManager)) {
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
        try {
          res.end();
        } catch {
          /* already closed */
        }
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
  if (result.kind === "worker-do" && !workerdDispatchSecret) {
    res.writeHead(503, { "Content-Type": "text/plain" });
    res.end("DO dispatch unavailable");
    return true;
  }
  const extraHeaders =
    result.kind === "worker-do" && workerdDispatchSecret
      ? { "X-NatStack-Dispatch-Secret": workerdDispatchSecret }
      : undefined;
  proxyRequest(req, res, workerdPort, targetPath, workerdToken, undefined, extraHeaders);
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
  tokenManager: TokenManager,
  workerdToken: string,
  workerdDispatchSecret?: string | null
): boolean {
  const qIdx = url.indexOf("?");
  const pathOnly = qIdx === -1 ? url : url.slice(0, qIdx);
  const method = req.method ?? "GET";
  const result = routeRegistry.lookup(pathOnly, method, true);
  if (result === null || result === "method-not-allowed") {
    socket.destroy();
    return true;
  }

  if (!enforceAuth(result, req, url, adminToken, tokenManager)) {
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
  if (result.kind === "worker-do" && !workerdDispatchSecret) {
    socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return true;
  }
  const extraHeaders =
    result.kind === "worker-do" && workerdDispatchSecret
      ? { "X-NatStack-Dispatch-Secret": workerdDispatchSecret }
      : undefined;
  proxyUpgrade(req, socket, head, workerdPort, workerdToken, extraHeaders);
  return true;
}
