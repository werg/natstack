import { describe, expect, it, vi } from "vitest";
import {
  ColdStartAuthRequiredError,
  WorkspaceCapacityError,
  WorkspaceBackendCrashedError,
  WorkspaceNotFoundError,
  WorkspaceSupervisor,
  type ManagedServerFactoryContext,
  type ManagedServerLike,
  type SupervisorCentralData,
} from "./workspaceSupervisor.js";
import type { ServerPorts } from "./managedServer.js";

class FakeCentralData implements SupervisorCentralData {
  readonly workspaces = new Map<string, { name: string; lastOpened: number }>();
  readonly touched: string[] = [];
  readonly removed: string[] = [];

  constructor(names: string[]) {
    for (const name of names) {
      this.workspaces.set(name, { name, lastOpened: Date.now() });
    }
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
    this.touched.push(name);
    const entry = this.workspaces.get(name);
    if (entry) entry.lastOpened = Date.now();
  }

  getWorkspaceEntry(name: string) {
    return this.workspaces.get(name) ?? null;
  }
}

class FakeManagedServer implements ManagedServerLike {
  readonly shutdown = vi.fn(async () => undefined);
  ports: ServerPorts | null;

  constructor(
    readonly name: string,
    readonly env: Record<string, string | undefined>,
    ports?: ServerPorts
  ) {
    this.ports = ports ?? { gatewayPort: nextPort(), adminToken: `admin-${name}` };
  }

  async start(): Promise<ServerPorts> {
    return this.ports!;
  }

  getPorts(): ServerPorts | null {
    return this.ports;
  }

  getProcessId(): number | undefined {
    return this.ports ? this.ports.gatewayPort + 1000 : undefined;
  }

  getCurrentGatewayUrl(): string | null {
    return this.ports ? `ws://127.0.0.1:${this.ports.gatewayPort}/rpc` : null;
  }
}

class DeferredManagedServer extends FakeManagedServer {
  private resolveStart!: (ports: ServerPorts) => void;
  private readonly startPromise: Promise<ServerPorts>;

  constructor(name: string, env: Record<string, string | undefined>) {
    super(name, env);
    this.startPromise = new Promise((resolve) => {
      this.resolveStart = resolve;
    });
  }

  async start(): Promise<ServerPorts> {
    return this.startPromise;
  }

  finishStart(): void {
    this.resolveStart(this.ports!);
  }
}

class FailingManagedServer extends FakeManagedServer {
  async start(): Promise<ServerPorts> {
    throw new Error("startup failed");
  }
}

let port = 41000;
function nextPort(): number {
  port += 1;
  return port;
}

function createHarness(
  names: string[],
  opts: Partial<ConstructorParameters<typeof WorkspaceSupervisor>[0]> = {}
) {
  const centralData = new FakeCentralData(names);
  const created: FakeManagedServer[] = [];
  const contexts: ManagedServerFactoryContext[] = [];
  const supervisor = new WorkspaceSupervisor({
    appRoot: "/app",
    publicBaseUrl: "https://example.test/base",
    publicBasePath: "/base",
    wsAllowedOrigins: "https://example.test",
    centralData,
    createManagedServer: (ctx) => {
      contexts.push(ctx);
      const manager = new FakeManagedServer(ctx.name, ctx.env);
      created.push(manager);
      return manager;
    },
    ...opts,
  });
  return { supervisor, centralData, created, contexts };
}

describe("WorkspaceSupervisor", () => {
  it("dedupes concurrent ensureExisting calls for the same workspace", async () => {
    const { supervisor, created } = createHarness(["alpha"]);

    const [a, b] = await Promise.all([
      supervisor.ensureExisting("alpha"),
      supervisor.ensureExisting("alpha"),
    ]);

    expect(a).toBe(b);
    expect(created).toHaveLength(1);
  });

  it("rejects unknown or non-exposed workspaces without spawning", async () => {
    const { supervisor, created } = createHarness(["alpha"], {
      exposedWorkspaces: new Set(["beta"]),
    });

    await expect(supervisor.ensureExisting("alpha")).rejects.toBeInstanceOf(WorkspaceNotFoundError);
    await expect(supervisor.ensureExisting("missing")).rejects.toBeInstanceOf(
      WorkspaceNotFoundError
    );
    expect(created).toHaveLength(0);
  });

  it("requires operator auth for cold starts when configured", async () => {
    const { supervisor, created } = createHarness(["alpha"], {
      requireAuthToColdStart: true,
    });

    await expect(supervisor.ensureExisting("alpha")).rejects.toBeInstanceOf(
      ColdStartAuthRequiredError
    );
    await expect(
      supervisor.ensureExisting("alpha", { operatorAuthenticated: true })
    ).resolves.toMatchObject({ adminToken: "admin-alpha" });
    expect(created).toHaveLength(1);
  });

  it("evicts the least-recently-used idle backend at capacity", async () => {
    const { supervisor, created } = createHarness(["alpha", "beta", "gamma"], {
      maxWorkspaces: 2,
    });

    await supervisor.ensureExisting("alpha");
    await supervisor.ensureExisting("beta");
    const alpha = supervisor.getEntry("alpha")!;
    const beta = supervisor.getEntry("beta")!;
    alpha.lastActivity = 1;
    beta.lastActivity = 2;

    await supervisor.ensureExisting("gamma");

    expect(created.map((m) => m.name)).toEqual(["alpha", "beta", "gamma"]);
    expect(created[0]!.shutdown).toHaveBeenCalledTimes(1);
    expect(supervisor.getEntry("alpha")).toBeNull();
    expect(supervisor.getEntry("beta")).not.toBeNull();
    expect(supervisor.getEntry("gamma")).not.toBeNull();
  });

  it("returns 503 at capacity when every backend is active", async () => {
    const { supervisor, created } = createHarness(["alpha", "beta", "gamma"], {
      maxWorkspaces: 2,
    });

    await supervisor.ensureExisting("alpha");
    await supervisor.ensureExisting("beta");
    supervisor.trackWsOpen("alpha");
    supervisor.trackHttpStart("beta");

    await expect(supervisor.ensureExisting("gamma")).rejects.toBeInstanceOf(WorkspaceCapacityError);
    expect(created).toHaveLength(2);
  });

  it("counts starting backends toward capacity during concurrent cold starts", async () => {
    const centralData = new FakeCentralData(["alpha", "beta"]);
    const created: DeferredManagedServer[] = [];
    const supervisor = new WorkspaceSupervisor({
      appRoot: "/app",
      publicBaseUrl: "https://example.test",
      publicBasePath: "",
      centralData,
      maxWorkspaces: 1,
      createManagedServer: (ctx) => {
        const manager = new DeferredManagedServer(ctx.name, ctx.env);
        created.push(manager);
        return manager;
      },
    });
    try {
      const alpha = supervisor.ensureExisting("alpha");
      await waitFor(() => created.length === 1);

      await expect(supervisor.ensureExisting("beta")).rejects.toBeInstanceOf(
        WorkspaceCapacityError
      );
      expect(created.map((manager) => manager.name)).toEqual(["alpha"]);

      created[0]!.finishStart();
      await expect(alpha).resolves.toMatchObject({ adminToken: "admin-alpha" });
    } finally {
      await supervisor.shutdownAll();
    }
  });

  it("idle reaper waits for websocket, HTTP, and proxy activity to drain", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const { supervisor, created } = createHarness(["alpha"], {
      idleTimeoutMs: 1000,
    });
    try {
      await supervisor.ensureExisting("alpha");
      supervisor.trackWsOpen("alpha");
      supervisor.trackHttpStart("alpha");
      supervisor.trackProxySocketOpen("alpha");

      await vi.advanceTimersByTimeAsync(1000);

      expect(created[0]!.shutdown).not.toHaveBeenCalled();
      supervisor.trackWsClose("alpha");
      supervisor.trackHttpFinish("alpha");
      supervisor.trackProxySocketClose("alpha");

      await vi.advanceTimersByTimeAsync(1000);

      expect(created[0]!.shutdown).toHaveBeenCalledTimes(1);
      expect(supervisor.getEntry("alpha")).toBeNull();
    } finally {
      await supervisor.shutdownAll();
      vi.useRealTimers();
    }
  });

  it("spawns backends with supervisor public URL and base path env", async () => {
    const { supervisor, contexts } = createHarness(["alpha"]);

    await supervisor.ensureExisting("alpha");

    expect(contexts[0]!.env).toMatchObject({
      NATSTACK_WORKSPACE: "alpha",
      NATSTACK_PUBLIC_URL: "https://example.test/base/w/alpha",
      NATSTACK_PUBLIC_BASE_PATH: "/base/w/alpha",
      NATSTACK_NO_VPN_DETECT: "1",
      NATSTACK_SUPERVISOR_MODE: "1",
      NATSTACK_BIND_HOST: "127.0.0.1",
      NATSTACK_WS_ALLOWED_ORIGINS: "https://example.test",
    });
  });

  it("answers backend IPC catalog requests from supervisor-owned central data", async () => {
    const { supervisor, contexts } = createHarness(["alpha", "beta"]);
    await supervisor.ensureExisting("alpha");

    await expect(contexts[0]!.onIpcRequest("workspace-list-request", {})).resolves.toEqual({
      workspaces: expect.arrayContaining([
        expect.objectContaining({ name: "alpha" }),
        expect.objectContaining({ name: "beta" }),
      ]),
    });
    await expect(contexts[0]!.onIpcRequest("workspace-active-entry-request", {})).resolves.toEqual({
      entry: expect.objectContaining({ name: "alpha" }),
    });
  });

  it("surfaces repeated backend crash state as tenant-scoped 503 during crash backoff", async () => {
    const { supervisor, contexts, created } = createHarness(["alpha"], {
      crashBackoffMs: 60_000,
    });
    await supervisor.ensureExisting("alpha");

    contexts[0]!.onCrash(1);

    expect(created[0]!.shutdown).not.toHaveBeenCalled();
    expect(supervisor.getEntry("alpha")).toBeNull();
    await expect(supervisor.ensureExisting("alpha")).rejects.toBeInstanceOf(
      WorkspaceBackendCrashedError
    );
  });

  it("shuts down and backs off a backend that fails during startup", async () => {
    const centralData = new FakeCentralData(["alpha"]);
    const created: FailingManagedServer[] = [];
    const supervisor = new WorkspaceSupervisor({
      appRoot: "/app",
      publicBaseUrl: "https://example.test",
      publicBasePath: "",
      centralData,
      crashBackoffMs: 60_000,
      createManagedServer: (ctx) => {
        const manager = new FailingManagedServer(ctx.name, ctx.env);
        created.push(manager);
        return manager;
      },
    });
    try {
      await expect(supervisor.ensureExisting("alpha")).rejects.toThrow("startup failed");

      expect(created).toHaveLength(1);
      expect(created[0]!.shutdown).toHaveBeenCalledTimes(1);
      expect(supervisor.getEntry("alpha")).toBeNull();
      await expect(supervisor.ensureExisting("alpha")).rejects.toBeInstanceOf(
        WorkspaceBackendCrashedError
      );
      expect(created).toHaveLength(1);
    } finally {
      await supervisor.shutdownAll();
    }
  });

  it("deletes through supervisor provisioning by evicting, removing disk, and registry entry", async () => {
    const deleteWorkspaceDir = vi.fn();
    const { supervisor, created, centralData } = createHarness(["alpha"], {
      deleteWorkspaceDir,
    });
    await supervisor.ensureExisting("alpha");

    await supervisor.deleteWorkspace("alpha");

    expect(created[0]!.shutdown).toHaveBeenCalledTimes(1);
    expect(deleteWorkspaceDir).toHaveBeenCalledWith("alpha");
    expect(centralData.removed).toEqual(["alpha"]);
    expect(supervisor.getEntry("alpha")).toBeNull();
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition was not met");
}
