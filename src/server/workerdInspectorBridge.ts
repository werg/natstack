/**
 * WorkerdInspectorBridge — server-side relay between userland V8-inspector
 * clients (profiling via @workspace/testkit) and the local workerd inspector
 * socket.
 *
 * Architecture:
 *   Runtime client → /workerd-inspector/{encodedTargetPath} WS → this bridge
 *     → ws://127.0.0.1:<inspectorPort>/<targetPath> (workerd --inspector-addr)
 *
 * The inspector socket binds loopback and is unreachable from userland
 * (workers egress through the proxy; panels are not server-local), so this
 * bridge is the only programmatic path. Clients authenticate with the same
 * first-message frame as the CDP bridge ({type:"natstack:cdp-auth",token}),
 * redeeming single-use grants minted by the workerdInspector service after
 * its approval check. The client↔upstream protocol is plain V8 inspector
 * JSON, relayed verbatim.
 */
import { WebSocket, type WebSocketServer } from "ws";
import type { IncomingMessage } from "http";
import type { Duplex } from "stream";
import { CdpGrantService } from "@natstack/shared/cdpGrants";
import { createDevLogger } from "@natstack/dev-log";

const log = createDevLogger("WorkerdInspectorBridge");

export const WORKERD_INSPECTOR_PATH_PREFIX = "/workerd-inspector/";
const AUTH_TIMEOUT_MS = 5_000;

export interface WorkerdInspectorTarget {
  id: string;
  title: string;
  type: string;
  /** Path component to pass to getEndpoint (from webSocketDebuggerUrl). */
  targetPath: string;
}

export interface WorkerdInspectorBridgeOptions {
  /** Base inspector URL, e.g. http://127.0.0.1:9229 — null when disabled. */
  getInspectorUrl: () => string | null;
  protocol?: "http" | "https";
  externalHost?: string;
  port: number;
}

interface ProxiedSession {
  client: WebSocket;
  upstream: WebSocket;
}

export class WorkerdInspectorBridge {
  private readonly grants = new CdpGrantService();
  private readonly sessions = new Set<ProxiedSession>();

  constructor(private readonly options: WorkerdInspectorBridgeOptions) {}

  /** List live inspector targets via the inspector's /json/list endpoint. */
  async listTargets(): Promise<WorkerdInspectorTarget[]> {
    const base = this.options.getInspectorUrl();
    if (!base) return [];
    const response = await fetch(`${base}/json/list`);
    if (!response.ok) {
      throw new Error(`workerd inspector /json/list failed: ${response.status}`);
    }
    const rows = (await response.json()) as Array<{
      id?: string;
      title?: string;
      type?: string;
      webSocketDebuggerUrl?: string;
    }>;
    return rows
      .map((row) => {
        let targetPath = row.id ?? "";
        if (row.webSocketDebuggerUrl) {
          try {
            targetPath = new URL(row.webSocketDebuggerUrl).pathname.replace(/^\//, "");
          } catch {
            // Keep the id fallback.
          }
        }
        return {
          id: row.id ?? targetPath,
          title: row.title ?? row.id ?? targetPath,
          type: row.type ?? "node",
          targetPath,
        };
      })
      .filter((target) => target.targetPath.length > 0);
  }

  /** Mint a single-use endpoint for a target path. Null when disabled. */
  getEndpoint(
    targetPath: string,
    principalId: string
  ): { wsEndpoint: string; token: string } | null {
    if (!this.options.getInspectorUrl()) return null;
    const { token } = this.grants.grant(principalId, `workerd-inspector:${targetPath}`);
    const wsProtocol = this.options.protocol === "https" ? "wss" : "ws";
    const host = this.options.externalHost ?? "127.0.0.1";
    const encoded = encodeURIComponent(targetPath);
    return {
      wsEndpoint: `${wsProtocol}://${host}:${this.options.port}${WORKERD_INSPECTOR_PATH_PREFIX}${encoded}`,
      token,
    };
  }

  isInspectorPath(pathname: string): boolean {
    return pathname.startsWith(WORKERD_INSPECTOR_PATH_PREFIX);
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, wss: WebSocketServer): void {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!this.isInspectorPath(url.pathname)) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    const targetPath = decodeURIComponent(url.pathname.slice(WORKERD_INSPECTOR_PATH_PREFIX.length));
    const inspectorBase = this.options.getInspectorUrl();
    if (!inspectorBase || targetPath.length === 0) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (client) => {
      void this.authenticateAndProxy(client, targetPath, inspectorBase);
    });
  }

  /** Close all proxied sessions (e.g. before a workerd restart). */
  closeAll(): void {
    for (const session of this.sessions) {
      session.client.close(1012, "workerd restarting");
      session.upstream.close();
    }
    this.sessions.clear();
  }

  stop(): void {
    this.closeAll();
    this.grants.stop();
  }

  private async authenticateAndProxy(
    client: WebSocket,
    targetPath: string,
    inspectorBase: string
  ): Promise<void> {
    const authed = await this.awaitAuth(client, targetPath);
    if (!authed) {
      client.close(4401, "authentication failed");
      return;
    }
    const upstreamUrl = `${inspectorBase.replace(/^http/, "ws")}/${targetPath}`;
    const upstream = new WebSocket(upstreamUrl);
    const session: ProxiedSession = { client, upstream };
    this.sessions.add(session);

    const teardown = (): void => {
      this.sessions.delete(session);
      if (client.readyState === WebSocket.OPEN) client.close();
      if (upstream.readyState === WebSocket.OPEN) upstream.close();
    };

    upstream.on("open", () => {
      client.send(JSON.stringify({ type: "natstack:cdp-auth-ok" }));
      client.on("message", (data) => {
        if (upstream.readyState === WebSocket.OPEN) {
          upstream.send(typeof data === "string" ? data : data.toString());
        }
      });
      upstream.on("message", (data) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(typeof data === "string" ? data : data.toString());
        }
      });
    });
    upstream.on("error", (error) => {
      log.warn(`upstream inspector socket error for ${targetPath}: ${String(error)}`);
      teardown();
    });
    upstream.on("close", teardown);
    client.on("close", teardown);
    client.on("error", teardown);
  }

  private awaitAuth(client: WebSocket, targetPath: string): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        cleanup();
        resolve(false);
      }, AUTH_TIMEOUT_MS);
      const onMessage = (data: unknown): void => {
        cleanup();
        try {
          const parsed = JSON.parse(String(data)) as { type?: string; token?: string };
          if (parsed.type !== "natstack:cdp-auth" || !parsed.token) {
            resolve(false);
            return;
          }
          const grant = this.grants.redeem(parsed.token, `workerd-inspector:${targetPath}`);
          resolve(Boolean(grant));
        } catch {
          resolve(false);
        }
      };
      const onClose = (): void => {
        cleanup();
        resolve(false);
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        client.off("message", onMessage);
        client.off("close", onClose);
      };
      client.once("message", onMessage);
      client.once("close", onClose);
    });
  }
}
