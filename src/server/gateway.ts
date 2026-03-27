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
import { WebSocketServer, WebSocket } from "ws";
import type { Duplex } from "stream";
import { createDevLogger } from "@natstack/dev-log";

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
}

export class Gateway {
  private server: HttpServer | null = null;
  private wss: WebSocketServer | null = null;
  private deps: GatewayDeps;

  constructor(deps: GatewayDeps) {
    this.deps = deps;
  }

  async start(port: number): Promise<number> {
    const { rpcHandler, panelHttpHandler, gitPort, workerdPort } = this.deps;

    this.server = createServer((req, res) => {
      const url = req.url ?? "/";

      // /_w/ → workerd reverse proxy
      if (url.startsWith("/_w/") && workerdPort) {
        return proxyRequest(req, res, workerdPort, url);
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
    });

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

      // Default: panel HTTP handler (CDP bridge, etc.)
      if (panelHttpHandler) {
        return panelHttpHandler.handleGatewayUpgrade(req, socket, head);
      }

      socket.destroy();
    });

    const bindHost = this.deps.bindHost ?? "0.0.0.0";
    return new Promise((resolve, reject) => {
      this.server!.listen(port, bindHost, () => {
        const addr = this.server!.address();
        const assignedPort = typeof addr === "object" && addr ? addr.port : port;
        log.info(`Gateway listening on ${bindHost}:${assignedPort}`);
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
