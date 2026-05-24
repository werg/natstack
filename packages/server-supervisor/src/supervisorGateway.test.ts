import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import type { ManagedServerLike, SupervisorCentralData } from "./workspaceSupervisor.js";
import { WorkspaceSupervisor } from "./workspaceSupervisor.js";
import { SupervisorGateway } from "./supervisorGateway.js";
import type { ServerPorts } from "./managedServer.js";

class FakeCentralData implements SupervisorCentralData {
  readonly workspaces = new Map<string, { name: string; lastOpened: number }>();
  readonly removed: string[] = [];

  constructor(names: string[]) {
    for (const name of names) this.workspaces.set(name, { name, lastOpened: 1 });
  }

  listWorkspaces() {
    return [...this.workspaces.values()];
  }

  hasWorkspace(name: string): boolean {
    return this.workspaces.has(name);
  }

  addWorkspace(name: string): void {
    this.workspaces.set(name, { name, lastOpened: Date.now() });
  }

  removeWorkspace(name: string): void {
    this.removed.push(name);
    this.workspaces.delete(name);
  }

  touchWorkspace(name: string): void {
    const entry = this.workspaces.get(name);
    if (entry) entry.lastOpened = Date.now();
  }

  getWorkspaceEntry(name: string) {
    return this.workspaces.get(name) ?? null;
  }
}

class StaticManagedServer implements ManagedServerLike {
  readonly shutdown = vi.fn(async () => undefined);

  constructor(readonly ports: ServerPorts) {}

  async start(): Promise<ServerPorts> {
    return this.ports;
  }

  getPorts(): ServerPorts | null {
    return this.ports;
  }

  getProcessId(): number | undefined {
    return 12345;
  }

  getCurrentGatewayUrl(): string | null {
    return `ws://127.0.0.1:${this.ports.gatewayPort}/rpc`;
  }
}

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()));
});

describe("SupervisorGateway", () => {
  it("routes base-path tenant requests while preserving caller authorization", async () => {
    let seenAuth: string | undefined;
    let seenUrl: string | undefined;
    const backend = await listen((req, res) => {
      seenAuth = req.headers.authorization;
      seenUrl = req.url;
      json(res, 200, { ok: true });
    });
    const { url, stop } = await startGateway(backend.port, { publicBasePath: "/base" });
    cleanup.push(stop);
    cleanup.push(backend.stop);

    const response = await fetch(`${url}/base/w/alpha/rpc?x=1`, {
      headers: { Authorization: "Bearer caller-token" },
    });

    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(seenAuth).toBe("Bearer caller-token");
    expect(seenUrl).toBe("/rpc?x=1");
  });

  it("proxies websocket upgrades and preserves the first auth frame", async () => {
    let firstFrame: string | null = null;
    const backend = await listenWs((message) => {
      firstFrame = message;
    });
    const { url, stop } = await startGateway(backend.port);
    cleanup.push(stop);
    cleanup.push(backend.stop);

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`${url.replace(/^http:/, "ws:")}/w/alpha/rpc`);
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error("timed out waiting for websocket frame"));
      }, 3000);
      ws.on("open", () => ws.send(JSON.stringify({ type: "ws:auth", token: "caller-token" })));
      ws.on("message", () => {
        clearTimeout(timeout);
        ws.close();
        resolve();
      });
      ws.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    expect(firstFrame).toBe(JSON.stringify({ type: "ws:auth", token: "caller-token" }));
  });

  it("rejects supervisor routes without an operator token", async () => {
    const backend = await listen((_req, res) => json(res, 200, { ok: true }));
    const { url, stop } = await startGateway(backend.port);
    cleanup.push(stop);
    cleanup.push(backend.stop);

    const response = await fetch(`${url}/_supervisor/workspaces`);

    expect(response.status).toBe(401);
  });

  it("proxies issue-device with the backend admin token only after operator auth", async () => {
    let seenAuth: string | undefined;
    let seenUrl: string | undefined;
    const backend = await listen((req, res) => {
      seenAuth = req.headers.authorization;
      seenUrl = req.url;
      json(res, 200, { deviceId: "device", shellToken: "shell" });
    });
    const { url, stop } = await startGateway(backend.port);
    cleanup.push(stop);
    cleanup.push(backend.stop);

    const response = await fetch(`${url}/_supervisor/workspaces/alpha/issue-device`, {
      method: "POST",
      headers: {
        Authorization: "Bearer operator",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ label: "test" }),
    });

    await expect(response.json()).resolves.toEqual({ deviceId: "device", shellToken: "shell" });
    expect(seenUrl).toBe("/_r/s/auth/issue-device");
    expect(seenAuth).toBe("Bearer admin-alpha");
  });

  it("supports operator-authenticated delete provisioning", async () => {
    const backend = await listen((_req, res) => json(res, 200, { ok: true }));
    const centralData = new FakeCentralData(["alpha"]);
    const deleteWorkspaceDir = vi.fn();
    const { url, stop, supervisor } = await startGateway(backend.port, {
      centralData,
      deleteWorkspaceDir,
    });
    cleanup.push(stop);
    cleanup.push(backend.stop);
    await supervisor.ensureExisting("alpha");

    const response = await fetch(`${url}/_supervisor/workspaces/alpha`, {
      method: "DELETE",
      headers: { Authorization: "Bearer operator" },
    });

    expect(response.status).toBe(200);
    expect(deleteWorkspaceDir).toHaveBeenCalledWith("alpha");
    expect(centralData.removed).toEqual(["alpha"]);
    expect(supervisor.getEntry("alpha")).toBeNull();
  });

  it("rate-limits unauthenticated cold-start attempts by source and workspace", async () => {
    const backend = await listen((_req, res) => json(res, 200, { ok: true }));
    const { url, stop } = await startGateway(backend.port, {
      coldStartMaxAttempts: 1,
      coldStartWindowMs: 60_000,
      centralData: new FakeCentralData([]),
    });
    cleanup.push(stop);
    cleanup.push(backend.stop);

    const first = await fetch(`${url}/w/missing/healthz`);
    const second = await fetch(`${url}/w/missing/healthz`);

    expect(first.status).toBe(404);
    expect(second.status).toBe(429);
  });

  it("treats malformed encoded workspace names as a 404 route miss", async () => {
    const backend = await listen((_req, res) => json(res, 200, { ok: true }));
    const { url, stop } = await startGateway(backend.port);
    cleanup.push(stop);
    cleanup.push(backend.stop);

    const response = await fetch(`${url}/w/%E0%A4%A/healthz`);

    expect(response.status).toBe(404);
  });

  it("treats malformed encoded supervisor workspace segments as a 404 route miss", async () => {
    const backend = await listen((_req, res) => json(res, 200, { ok: true }));
    const { url, stop } = await startGateway(backend.port);
    cleanup.push(stop);
    cleanup.push(backend.stop);

    const response = await fetch(`${url}/_supervisor/workspaces/%E0%A4%A/issue-device`, {
      method: "POST",
      headers: { Authorization: "Bearer operator" },
    });

    expect(response.status).toBe(404);
  });

  it("rejects start when the supervisor port cannot be bound", async () => {
    const occupied = createServer();
    await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise<void>((resolve) => occupied.close(() => resolve())));
    const address = occupied.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const supervisor = new WorkspaceSupervisor({
      appRoot: "/app",
      publicBaseUrl: "http://127.0.0.1:1",
      publicBasePath: "",
      centralData: new FakeCentralData(["alpha"]),
      createManagedServer: () =>
        new StaticManagedServer({
          gatewayPort: 1,
          adminToken: "admin-alpha",
        }),
    });
    const gateway = new SupervisorGateway({
      supervisor,
      bindHost: "127.0.0.1",
      port: address.port,
      publicBasePath: "",
      operatorToken: "operator",
    });
    cleanup.push(async () => {
      await gateway.stop();
      await supervisor.shutdownAll();
    });

    await expect(gateway.start()).rejects.toMatchObject({ code: "EADDRINUSE" });
  });

  it("bounded stop destroys active websocket sockets instead of hanging", async () => {
    const backend = await listenWs(() => undefined);
    const { url, stop } = await startGateway(backend.port, { shutdownTimeoutMs: 20 });
    cleanup.push(stop);
    cleanup.push(backend.stop);

    const ws = new WebSocket(`${url.replace(/^http:/, "ws:")}/w/alpha/rpc`);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("websocket did not open")), 3000);
      ws.on("open", () => {
        clearTimeout(timeout);
        resolve();
      });
      ws.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    await expect(stop()).resolves.toBeUndefined();
    await waitForSocketClose(ws);
  });
});

async function startGateway(
  backendPort: number,
  opts: {
    publicBasePath?: string;
    centralData?: FakeCentralData;
    deleteWorkspaceDir?: (name: string) => void;
    coldStartMaxAttempts?: number;
    coldStartWindowMs?: number;
    shutdownTimeoutMs?: number;
  } = {}
): Promise<{ url: string; stop: () => Promise<void>; supervisor: WorkspaceSupervisor }> {
  const supervisor = new WorkspaceSupervisor({
    appRoot: "/app",
    publicBaseUrl: `http://127.0.0.1:1${opts.publicBasePath ?? ""}`,
    publicBasePath: opts.publicBasePath ?? "",
    centralData: opts.centralData ?? new FakeCentralData(["alpha"]),
    deleteWorkspaceDir: opts.deleteWorkspaceDir,
    createManagedServer: (ctx) =>
      new StaticManagedServer({
        gatewayPort: backendPort,
        adminToken: `admin-${ctx.name}`,
      }),
  });
  const gateway = new SupervisorGateway({
    supervisor,
    bindHost: "127.0.0.1",
    port: 0,
    publicBasePath: opts.publicBasePath ?? "",
    operatorToken: "operator",
    coldStartMaxAttempts: opts.coldStartMaxAttempts,
    coldStartWindowMs: opts.coldStartWindowMs,
    shutdownTimeoutMs: opts.shutdownTimeoutMs,
  });
  const port = await gateway.start();
  return {
    url: `http://127.0.0.1:${port}`,
    supervisor,
    stop: async () => {
      await gateway.stop();
      await supervisor.shutdownAll();
    },
  };
}

async function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void
): Promise<{ port: number; stop: () => Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind to a port");
  return {
    port: address.port,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function listenWs(
  onMessage: (message: string) => void
): Promise<{ port: number; stop: () => Promise<void> }> {
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.once("message", (data) => {
        onMessage(data.toString());
        ws.send("ok");
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind to a port");
  return {
    port: address.port,
    stop: async () => {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function waitForSocketClose(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("websocket did not close")), 3000);
    ws.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function json(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}
