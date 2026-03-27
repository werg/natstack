/**
 * Gateway — Single-port HTTP/WS router for NatStack server.
 *
 * Multiplexes:
 * - Panel HTTP requests → PanelHttpServer (by subdomain)
 * - WebSocket /rpc → RpcServer
 * - Git HTTP (smart protocol) → GitServer reverse proxy
 * - Workerd /_w/ → Workerd reverse proxy
 *
 * In standalone mode, this provides a single entry point for all services.
 * In Electron IPC mode, this is not used (Electron connects directly to ports).
 */

import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from "http";
import type { Duplex } from "stream";
import { createProxyRequest } from "./gatewayProxy.js";
import { createDevLogger } from "@natstack/dev-log";

const log = createDevLogger("Gateway");

export interface GatewayDeps {
  /** RPC WS port for /rpc path upgrades */
  rpcPort: number;
  /** Panel HTTP port for subdomain-based routing */
  panelHttpPort: number | null;
  /** Git server port for /_git/ path */
  gitPort: number;
  /** Workerd port for /_w/ path */
  workerdPort: number | null;
  /** External hostname for subdomain extraction */
  externalHost: string;
}

export class Gateway {
  private server: HttpServer | null = null;
  private deps: GatewayDeps;

  constructor(deps: GatewayDeps) {
    this.deps = deps;
  }

  async start(port: number): Promise<number> {
    const { rpcPort, panelHttpPort, gitPort, workerdPort } = this.deps;

    this.server = createServer((req, res) => {
      const url = req.url ?? "/";

      // /_w/ → workerd proxy
      if (url.startsWith("/_w/") && workerdPort) {
        return createProxyRequest(req, res, workerdPort, url);
      }

      // /_git/ → git server proxy
      if (url.startsWith("/_git/")) {
        const gitPath = url.slice(5); // strip /_git prefix
        return createProxyRequest(req, res, gitPort, gitPath);
      }

      // Everything else → panel HTTP server
      if (panelHttpPort) {
        return createProxyRequest(req, res, panelHttpPort, url, req.headers.host);
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
    });

    // WebSocket upgrade routing
    this.server.on("upgrade", (req, socket, head) => {
      const url = req.url ?? "/";

      // /rpc → RPC WebSocket server
      if (url === "/rpc" || url.startsWith("/rpc?")) {
        const proxyReq = createUpgradeProxy(req, socket, head, rpcPort);
        return proxyReq;
      }

      // /_w/ → workerd WebSocket proxy
      if (url.startsWith("/_w/") && workerdPort) {
        return createUpgradeProxy(req, socket, head, workerdPort);
      }

      // Default: panel HTTP server (subdomain WebSocket connections)
      if (panelHttpPort) {
        return createUpgradeProxy(req, socket, head, panelHttpPort);
      }

      socket.destroy();
    });

    return new Promise((resolve, reject) => {
      this.server!.listen(port, "0.0.0.0", () => {
        const addr = this.server!.address();
        const assignedPort = typeof addr === "object" && addr ? addr.port : port;
        log.info(`Gateway listening on port ${assignedPort}`);
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
    if (!this.server) return;
    return new Promise((resolve) => {
      this.server!.close(() => resolve());
    });
  }
}

/**
 * Proxy a WebSocket upgrade request to a local service port.
 */
function createUpgradeProxy(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  targetPort: number,
): void {
  const { connect } = require("net") as typeof import("net");
  const targetSocket = connect(targetPort, "127.0.0.1", () => {
    // Rebuild the HTTP upgrade request
    const headers = Object.entries(req.headers)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
      .join("\r\n");
    const upgradeReq = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${headers}\r\n\r\n`;

    targetSocket.write(upgradeReq);
    if (head.length > 0) targetSocket.write(head);

    // Bi-directional pipe
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
