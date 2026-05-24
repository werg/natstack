import * as fs from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { createDevLogger } from "@natstack/dev-log";
import { proxyRequest, proxyUpgrade } from "@natstack/shared/nodeHttpProxy";
import { validateWorkspaceName } from "@natstack/shared/workspace/loader";
import { hasValidOperatorToken, OperatorAuthError, requireOperatorToken } from "./operatorAuth.js";
import {
  ColdStartAuthRequiredError,
  WorkspaceBackendCrashedError,
  WorkspaceCapacityError,
  WorkspaceNotFoundError,
  WorkspaceSupervisor,
} from "./workspaceSupervisor.js";

const log = createDevLogger("SupervisorGateway");

export interface SupervisorGatewayOptions {
  supervisor: WorkspaceSupervisor;
  bindHost: string;
  port: number;
  publicBasePath: string;
  operatorToken: string;
  allowCreate?: boolean;
  tlsCert?: string;
  tlsKey?: string;
  coldStartWindowMs?: number;
  coldStartMaxAttempts?: number;
  shutdownTimeoutMs?: number;
}

interface TenantRoute {
  workspace: string;
  targetPath: string;
}

export class SupervisorGateway {
  private server: Server | null = null;
  private readonly publicBasePath: string;
  private readonly coldStartsBySource = new Map<string, number[]>();
  private readonly sockets = new Set<Socket>();

  constructor(private readonly opts: SupervisorGatewayOptions) {
    this.publicBasePath = normalizeBasePath(opts.publicBasePath);
  }

  async start(): Promise<number> {
    const handler = (req: IncomingMessage, res: ServerResponse) => {
      void this.handleRequest(req, res).catch((error) => writeError(res, error));
    };
    const server =
      this.opts.tlsCert || this.opts.tlsKey
        ? createHttpsServer(
            {
              cert: fs.readFileSync(requireValue(this.opts.tlsCert, "--tls-cert")),
              key: fs.readFileSync(requireValue(this.opts.tlsKey, "--tls-key")),
            },
            handler
          )
        : createServer(handler);
    server.on("upgrade", (req, socket, head) => {
      void this.handleUpgrade(req, socket, head);
    });
    server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        server.off("error", onError);
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      server.once("error", onError);
      server.listen(this.opts.port, this.opts.bindHost, () => {
        cleanup();
        resolve();
      });
    });
    this.server = server;
    const address = server.address();
    return typeof address === "object" && address ? address.port : this.opts.port;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        for (const socket of this.sockets) socket.destroy();
      }, this.opts.shutdownTimeoutMs ?? 5000);
      server.close((err) => {
        clearTimeout(timeout);
        this.sockets.clear();
        err ? reject(err) : resolve();
      });
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const pathname = getPathname(req);
    if (pathname === joinPath(this.publicBasePath, "/healthz")) {
      writeJson(res, 200, { ok: true });
      return;
    }
    if (pathname.startsWith(joinPath(this.publicBasePath, "/_supervisor"))) {
      await this.handleSupervisorRoute(req, res, pathname);
      return;
    }

    const route = parseTenantRoute(req.url ?? "/", this.publicBasePath);
    if (!route) {
      writeText(res, 404, "Not found");
      return;
    }
    let ports;
    try {
      this.enforceColdStartRateLimit(req, route.workspace);
      ports = await this.opts.supervisor.ensureExisting(route.workspace, {
        operatorAuthenticated: hasValidOperatorToken(req, this.opts.operatorToken),
      });
    } catch (error) {
      writeError(res, error);
      return;
    }

    this.trackHttpUntilDone(route.workspace, res);
    proxyRequest(req, res, {
      targetPort: ports.gatewayPort,
      targetPath: route.targetPath,
      auth: { mode: "passthrough" },
      errorPrefix: "Supervisor proxy error",
      onProxySocketOpen: () => this.opts.supervisor.trackProxySocketOpen(route.workspace),
      onProxySocketClose: () => this.opts.supervisor.trackProxySocketClose(route.workspace),
      logWarning: (message) => log.warn(message),
    });
  }

  private async handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const route = parseTenantRoute(req.url ?? "/", this.publicBasePath);
    if (!route) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    let ports;
    try {
      this.enforceColdStartRateLimit(req, route.workspace);
      ports = await this.opts.supervisor.ensureExisting(route.workspace, {
        operatorAuthenticated: hasValidOperatorToken(req, this.opts.operatorToken),
      });
    } catch (error) {
      const status = statusCodeFor(error);
      socket.write(`HTTP/1.1 ${status} ${statusText(status)}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
      return;
    }

    this.opts.supervisor.trackWsOpen(route.workspace);
    socket.on("close", () => this.opts.supervisor.trackWsClose(route.workspace));
    proxyUpgrade(req, socket, head, {
      targetPort: ports.gatewayPort,
      targetPath: route.targetPath,
      auth: { mode: "passthrough" },
      onProxySocketOpen: () => this.opts.supervisor.trackProxySocketOpen(route.workspace),
      onProxySocketClose: () => this.opts.supervisor.trackProxySocketClose(route.workspace),
      logWarning: (message) => log.warn(message),
    });
  }

  private async handleSupervisorRoute(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string
  ): Promise<void> {
    try {
      requireOperatorToken(req, this.opts.operatorToken);
    } catch (error) {
      writeError(res, error);
      return;
    }

    const root = joinPath(this.publicBasePath, "/_supervisor");
    if (req.method === "GET" && pathname === joinPath(root, "/workspaces")) {
      writeJson(res, 200, {
        workspaces: this.opts.supervisor.listRegisteredWorkspaces(),
        active: this.opts.supervisor.listActive(),
      });
      return;
    }

    if (req.method === "POST" && pathname === joinPath(root, "/workspaces")) {
      if (!this.opts.allowCreate) {
        writeJson(res, 403, { error: "workspace creation is disabled" });
        return;
      }
      const body = await readJsonBody(req);
      const name = typeof body?.["name"] === "string" ? body["name"] : "";
      validateWorkspaceName(name);
      writeJson(res, 201, { workspace: this.opts.supervisor.createWorkspace(name) });
      return;
    }

    const stopMatch = pathname.match(new RegExp(`^${escapeRegExp(root)}/workspaces/([^/]+)/stop$`));
    if (req.method === "POST" && stopMatch?.[1]) {
      const name = decodeRouteComponent(stopMatch[1]);
      if (!name) {
        writeText(res, 404, "Not found");
        return;
      }
      validateWorkspaceName(name);
      await this.opts.supervisor.evict(name);
      writeJson(res, 200, { ok: true });
      return;
    }

    const workspaceMatch = pathname.match(new RegExp(`^${escapeRegExp(root)}/workspaces/([^/]+)$`));
    if (req.method === "DELETE" && workspaceMatch?.[1]) {
      const name = decodeRouteComponent(workspaceMatch[1]);
      if (!name) {
        writeText(res, 404, "Not found");
        return;
      }
      validateWorkspaceName(name);
      await this.opts.supervisor.deleteWorkspace(name);
      writeJson(res, 200, { ok: true });
      return;
    }

    const issueDeviceMatch = pathname.match(
      new RegExp(`^${escapeRegExp(root)}/workspaces/([^/]+)/issue-device$`)
    );
    if (req.method === "POST" && issueDeviceMatch?.[1]) {
      const name = decodeRouteComponent(issueDeviceMatch[1]);
      if (!name) {
        writeText(res, 404, "Not found");
        return;
      }
      await this.proxySupervisorAdminPost(req, res, name);
      return;
    }

    writeText(res, 404, "Not found");
  }

  private async proxySupervisorAdminPost(
    req: IncomingMessage,
    res: ServerResponse,
    workspace: string
  ): Promise<void> {
    validateWorkspaceName(workspace);
    const ports = await this.opts.supervisor.ensureExisting(workspace, {
      operatorAuthenticated: true,
    });
    const entry = this.opts.supervisor.getEntry(workspace);
    const adminToken = entry?.ports?.adminToken ?? ports.adminToken;
    this.trackHttpUntilDone(workspace, res);
    proxyRequest(req, res, {
      targetPort: ports.gatewayPort,
      targetPath: "/_r/s/auth/issue-device",
      auth: { mode: "replace", upstreamToken: adminToken },
      errorPrefix: "Supervisor admin proxy error",
      logWarning: (message) => log.warn(message),
    });
  }

  private trackHttpUntilDone(workspace: string, res: ServerResponse): void {
    this.opts.supervisor.trackHttpStart(workspace);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      this.opts.supervisor.trackHttpFinish(workspace);
    };
    res.on("finish", finish);
    res.on("close", finish);
  }

  private enforceColdStartRateLimit(req: IncomingMessage, workspace: string): void {
    if (hasValidOperatorToken(req, this.opts.operatorToken)) return;
    const entry = this.opts.supervisor.getEntry(workspace);
    if (entry?.state === "ready" || entry?.state === "starting") return;
    const windowMs = this.opts.coldStartWindowMs ?? 60_000;
    const maxAttempts = this.opts.coldStartMaxAttempts ?? 20;
    const now = Date.now();
    const key = `${req.socket.remoteAddress ?? "unknown"}:${workspace}`;
    const retained = (this.coldStartsBySource.get(key) ?? []).filter((ts) => now - ts < windowMs);
    if (retained.length >= maxAttempts) {
      this.coldStartsBySource.set(key, retained);
      throw new ColdStartRateLimitError();
    }
    retained.push(now);
    this.coldStartsBySource.set(key, retained);
  }
}

class ColdStartRateLimitError extends Error {
  readonly statusCode = 429;

  constructor() {
    super("Too many cold-start attempts");
  }
}

function parseTenantRoute(rawUrl: string, publicBasePath: string): TenantRoute | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl, "http://supervisor.invalid");
  } catch {
    return null;
  }
  const pathname = parsed.pathname;
  const prefix = joinPath(publicBasePath, "/w/");
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length);
  const slash = rest.indexOf("/");
  if (slash === -1) return null;
  const rawName = rest.slice(0, slash);
  const workspace = decodeRouteComponent(rawName);
  if (!workspace) return null;
  try {
    validateWorkspaceName(workspace);
  } catch {
    return null;
  }
  const targetPath = `${rest.slice(slash) || "/"}${parsed.search}`;
  return { workspace, targetPath };
}

function getPathname(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? "/", "http://supervisor.invalid").pathname;
  } catch {
    return "/";
  }
}

function decodeRouteComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function writeError(res: ServerResponse, error: unknown): void {
  const status = statusCodeFor(error);
  writeJson(res, status, {
    error: error instanceof Error ? error.message : String(error),
  });
}

function statusCodeFor(error: unknown): number {
  if (error instanceof OperatorAuthError) return 401;
  if (
    error instanceof WorkspaceNotFoundError ||
    error instanceof WorkspaceBackendCrashedError ||
    error instanceof WorkspaceCapacityError ||
    error instanceof ColdStartAuthRequiredError ||
    error instanceof ColdStartRateLimitError
  ) {
    return error.statusCode;
  }
  return 500;
}

function statusText(status: number): string {
  if (status === 401) return "Unauthorized";
  if (status === 404) return "Not Found";
  if (status === 429) return "Too Many Requests";
  if (status === 503) return "Service Unavailable";
  return "Error";
}

function writeJson(res: ServerResponse, status: number, value: unknown): void {
  const body = `${JSON.stringify(value)}\n`;
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function writeText(res: ServerResponse, status: number, value: string): void {
  res.writeHead(status, { "Content-Type": "text/plain" });
  res.end(value);
}

function normalizeBasePath(value: string): string {
  if (!value || value === "/") return "";
  return `/${value.replace(/^\/+|\/+$/g, "")}`;
}

function joinPath(base: string, suffix: string): string {
  const normalized = normalizeBasePath(base);
  return `${normalized}${suffix}`;
}

function requireValue(value: string | undefined, label: string): string {
  if (!value) throw new Error(`${label} is required`);
  return value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
