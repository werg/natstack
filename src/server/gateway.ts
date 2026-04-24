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
import * as fs from "fs";
import { WebSocketServer, WebSocket } from "ws";
import type { Duplex } from "stream";
import { createDevLogger } from "@natstack/dev-log";
import type { RouteRegistry, LookupResult } from "./routeRegistry.js";

const log = createDevLogger("Gateway");

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
  /** External hostname for subdomain extraction */
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

  constructor(deps: GatewayDeps) {
    this.deps = deps;
  }

  async start(port: number): Promise<number> {
    const { rpcHandler, panelHttpHandler, gitPort, workerdPort, tlsCert, tlsKey } = this.deps;

    const { healthProvider, adminToken, routeRegistry } = this.deps;

    const requestHandler = (req: IncomingMessage, res: ServerResponse) => {
      const url = req.url ?? "/";

      // /healthz → liveness + (token-gated) detailed status. No auth for basic
      // probe. Token can arrive via `?token=` query (convenient for curl) OR
      // via `X-NatStack-Token` header (what the main-process health poller
      // uses — keeps the admin token out of URLs / proxy logs).
      if (req.method === "GET" && (url === "/healthz" || url.startsWith("/healthz?"))) {
        let detailed = false;
        if (adminToken) {
          const qIdx = url.indexOf("?");
          if (qIdx !== -1) {
            const params = new URLSearchParams(url.slice(qIdx + 1));
            if (params.get("token") === adminToken) detailed = true;
          }
          const headerToken = req.headers["x-natstack-token"];
          if (typeof headerToken === "string" && headerToken === adminToken) detailed = true;
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
        return proxyRequest(req, res, workerdPort, url);
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
        );
        if (handled) return;
        // Fall through to 404 below — no panel fallback for `/_r/` misses.
      }

      // /_git/ → git server reverse proxy
      if (url.startsWith("/_git/") && gitPort) {
        const gitPath = url.slice(5); // strip /_git prefix
        return proxyRequest(req, res, gitPort, gitPath);
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

    // WebSocket upgrade routing
    this.wss = new WebSocketServer({ noServer: true });

    this.server.on("upgrade", (req, socket, head) => {
      const url = req.url ?? "/";

      // /rpc → RPC WebSocket (in-process via WSS)
      if ((url === "/rpc" || url.startsWith("/rpc?")) && rpcHandler) {
        this.wss!.handleUpgrade(req, socket, head, (ws) => {
          rpcHandler.handleGatewayWsConnection(ws);
        });
        return;
      }

      // /_w/ → workerd WebSocket proxy
      if (url.startsWith("/_w/") && workerdPort) {
        return proxyUpgrade(req, socket, head, workerdPort);
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
// Reverse proxy helpers (for external processes: git, workerd)
// ===========================================================================

function proxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  targetPort: number,
  targetPath: string,
  hostHeader?: string,
): void {
  const proxyReq = request(
    {
      hostname: "127.0.0.1",
      port: targetPort,
      path: targetPath,
      method: req.method,
      headers: {
        ...req.headers,
        ...(hostHeader ? { host: hostHeader } : {}),
      },
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
): void {
  const { connect } = require("net") as typeof import("net");
  const targetSocket = connect(targetPort, "127.0.0.1", () => {
    const headers = Object.entries(req.headers)
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
  if (!adminToken) return false;
  const presented = extractRouteToken(url, req);
  return presented === adminToken;
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
  proxyRequest(req, res, workerdPort, targetPath);
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
  proxyUpgrade(req, socket, head, workerdPort);
  return true;
}
