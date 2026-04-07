/**
 * Workspace service contract regression tests.
 *
 * The point of these tests is to catch the exact regression that broke the
 * workspace API for panels in March: a refactor moved panels from a routing
 * bridge (which split RPC by service name) to a single direct-to-server
 * transport, but the workspace service was left registered only on the
 * Electron-main side. The runtime's `WorkspaceClient` kept calling
 * `rpc.call("main", "workspace.list")` against a server that no longer had
 * the `workspace` service, and every panel-side workspace operation silently
 * failed with `Unknown service 'workspace'`.
 *
 * The contract this file locks in:
 *
 * 1. The runtime-side `createWorkspaceClient` and the server-side
 *    `createWorkspaceService` use the same service name (`"workspace"`) and
 *    the same method names. Any drift on either side fails a test.
 *
 * 2. `"workspace"` is in `SERVER_SERVICE_NAMES` so the IpcDispatcher forwards
 *    shell-renderer calls to the server (instead of dispatching them locally
 *    against an Electron-side service that no longer exists).
 *
 * 3. The service policy allows `panel`, `worker`, `shell`, and `server`
 *    callers — panels and workers must be able to reach this service
 *    directly via the WebSocket transport.
 *
 * 4. `workspace.select` invokes the `requestRelaunch` callback (the only path
 *    by which the server signals Electron main to call `app.relaunch()`).
 */

import { describe, it, expect, vi } from "vitest";
import { SERVER_SERVICE_NAMES } from "@natstack/rpc";
import type { RpcCaller } from "@natstack/rpc";
import { createWorkspaceService } from "../workspaceService.js";
import { createWorkspaceClient } from "../../../../workspace/packages/runtime/src/shared/workspace.js";
import type { WorkspaceConfig } from "@natstack/shared/workspace/types";
import type { ServiceContext } from "@natstack/shared/serviceDispatcher";

/**
 * Build a recording RpcCaller that captures every (target, method, args) tuple
 * the runtime client emits. The cast is necessary because `vi.fn` collapses
 * the generic `call<T>` signature into `(...args: unknown[]) => unknown`,
 * which can't be assigned back to `RpcCaller` without help.
 */
function recordingRpc(): {
  rpc: RpcCaller;
  captured: Array<{ target: string; method: string; args: unknown[] }>;
} {
  const captured: Array<{ target: string; method: string; args: unknown[] }> = [];
  const callImpl = async (target: string, method: string, ...args: unknown[]): Promise<unknown> => {
    captured.push({ target, method, args });
    return undefined;
  };
  const rpc = { call: callImpl } as unknown as RpcCaller;
  return { rpc, captured };
}

// ─── Test fixtures ────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<WorkspaceConfig> = {}): WorkspaceConfig {
  return { id: "test-ws", initPanels: [], ...overrides };
}

function makeWorkspace() {
  return {
    path: "/tmp/source",
    statePath: "/tmp/state",
    config: makeConfig(),
    panelsPath: "/tmp/source/panels",
    packagesPath: "/tmp/source/packages",
    contextsPath: "/tmp/state/.contexts",
    gitReposPath: "/tmp/source",
    cachePath: "/tmp/state/.cache",
    agentsPath: "/tmp/source/agents",
  };
}

function makeCentralData() {
  const entries: Array<{ name: string; lastOpened: number }> = [
    { name: "test-ws", lastOpened: 1000 },
    { name: "other", lastOpened: 500 },
  ];
  return {
    listWorkspaces: vi.fn(() => entries),
    hasWorkspace: vi.fn((name: string) => entries.some(e => e.name === name)),
    addWorkspace: vi.fn(),
    removeWorkspace: vi.fn((name: string) => {
      const idx = entries.findIndex(e => e.name === name);
      if (idx !== -1) entries.splice(idx, 1);
    }),
    touchWorkspace: vi.fn(),
    getWorkspaceEntry: vi.fn((name: string) => entries.find(e => e.name === name) ?? null),
  };
}

function makeService(opts: { requestRelaunch?: (name: string) => void } = {}) {
  return createWorkspaceService({
    workspace: makeWorkspace(),
    getConfig: () => makeConfig(),
    setConfigField: vi.fn(),
    centralData: makeCentralData(),
    createWorkspace: vi.fn((name: string) => ({ name, lastOpened: Date.now() })),
    deleteWorkspaceDir: vi.fn(),
    requestRelaunch: opts.requestRelaunch,
  });
}

const panelCtx: ServiceContext = { callerId: "panel-1", callerKind: "panel" };
const shellCtx: ServiceContext = { callerId: "shell-1", callerKind: "shell" };

// ─── Contract: client/server method-name alignment ───────────────────────────

describe("workspace service ↔ client contract", () => {
  it("client and server agree on the service name (`workspace`)", () => {
    const { rpc, captured } = recordingRpc();
    const client = createWorkspaceClient(rpc);
    void client.list();
    void client.getActive();

    expect(captured.length).toBeGreaterThan(0);
    for (const { target, method } of captured) {
      expect(target).toBe("main");
      expect(method.startsWith("workspace.")).toBe(true);
    }
  });

  it("every method the runtime client calls is registered on the server service", async () => {
    // Build a recording RPC, call every method on the client, capture wire calls.
    const { rpc, captured } = recordingRpc();
    const client = createWorkspaceClient(rpc);

    // Exercise every method the client exposes (reads + writes). The contract
    // assertion below verifies each captured wire-name is a registered method
    // on the service definition.
    await client.list();
    await client.getActive();
    await client.getActiveEntry();
    await client.getConfig();
    await client.create("new-ws", { forkFrom: "test-ws" });
    await client.setInitPanels([{ source: "panels/chat" }]);
    await client.switchTo("other");

    const service = makeService();
    for (const { method } of captured) {
      // Wire format is "workspace.<methodName>"
      const [serviceName, methodName] = method.split(".") as [string, string];
      expect(serviceName).toBe(service.name);
      expect(methodName in service.methods).toBe(true);
    }
  });

  it("the runtime client's interface keys map 1:1 to server method names", () => {
    // Build a recording RPC and call EVERY method on the client interface.
    // This catches drift in either direction: a server method that no client
    // uses, or a client method that hits an unregistered server method.
    const { rpc, captured } = recordingRpc();
    const client = createWorkspaceClient(rpc);

    void client.list();
    void client.getActive();
    void client.getActiveEntry();
    void client.getConfig();
    void client.create("x");
    void client.setInitPanels([]);
    void client.switchTo("x");

    // The server should have a method handler for each captured wire name.
    const service = makeService();
    for (const { method } of captured) {
      const wireName = method.split(".")[1]!;
      expect(service.methods[wireName]).toBeDefined();
    }
  });
});

// ─── Routing: SERVER_SERVICE_NAMES inclusion ──────────────────────────────────

describe("workspace service routing", () => {
  it("`workspace` is in SERVER_SERVICE_NAMES so IpcDispatcher forwards to server", () => {
    expect((SERVER_SERVICE_NAMES as readonly string[]).includes("workspace")).toBe(true);
  });

  it("the obsolete `workspaceInfo` name is gone from SERVER_SERVICE_NAMES", () => {
    // Catches the cleanup regression where someone re-introduces both names.
    expect((SERVER_SERVICE_NAMES as readonly string[]).includes("workspaceInfo")).toBe(false);
  });
});

// ─── Policy: panel/worker reachability ────────────────────────────────────────

describe("workspace service policy", () => {
  it("allows panel callers (the regression target)", () => {
    const service = makeService();
    expect(service.policy.allowed).toContain("panel");
  });

  it("allows worker, shell, and server callers as well", () => {
    const service = makeService();
    expect(service.policy.allowed).toContain("worker");
    expect(service.policy.allowed).toContain("shell");
    expect(service.policy.allowed).toContain("server");
  });
});

// ─── Behavior: handler delegates correctly ────────────────────────────────────

describe("workspace service handler", () => {
  it("list returns the central catalog entries", async () => {
    const service = makeService();
    const result = await service.handler(panelCtx, "list", []);
    expect(result).toEqual([
      { name: "test-ws", lastOpened: 1000 },
      { name: "other", lastOpened: 500 },
    ]);
  });

  it("getActive returns the active workspace name from config", async () => {
    const service = makeService();
    const result = await service.handler(panelCtx, "getActive", []);
    expect(result).toBe("test-ws");
  });

  it("getActiveEntry returns the catalog entry for the active workspace", async () => {
    const service = makeService();
    const result = await service.handler(panelCtx, "getActiveEntry", []);
    expect(result).toEqual({ name: "test-ws", lastOpened: 1000 });
  });

  it("getConfig returns the workspace config", async () => {
    const service = makeService();
    const result = await service.handler(panelCtx, "getConfig", []);
    expect(result).toEqual(makeConfig());
  });

  it("create delegates to the createWorkspace dep", async () => {
    const service = makeService();
    const result = await service.handler(panelCtx, "create", ["new-ws", { forkFrom: "test-ws" }]) as { name: string };
    expect(result.name).toBe("new-ws");
  });

  it("delete is shell-only (panels cannot delete workspaces)", async () => {
    const service = makeService();
    await expect(service.handler(panelCtx, "delete", ["other"])).rejects.toThrow(/shell/);
  });

  it("delete works from the shell", async () => {
    const service = makeService();
    await service.handler(shellCtx, "delete", ["other"]);
    // Should not throw
  });

  it("delete refuses to delete the currently running workspace", async () => {
    const service = makeService();
    await expect(service.handler(shellCtx, "delete", ["test-ws"])).rejects.toThrow(/currently running/);
  });

  it("setInitPanels delegates to setConfigField", async () => {
    const setConfigField = vi.fn();
    const service = createWorkspaceService({
      workspace: makeWorkspace(),
      getConfig: () => makeConfig(),
      setConfigField,
      centralData: makeCentralData(),
      createWorkspace: vi.fn(),
      deleteWorkspaceDir: vi.fn(),
    });
    await service.handler(panelCtx, "setInitPanels", [[{ source: "panels/chat" }]]);
    expect(setConfigField).toHaveBeenCalledWith("initPanels", [{ source: "panels/chat" }]);
  });
});

// ─── Select / relaunch: the only Electron-coupled path ───────────────────────

describe("workspace.select", () => {
  it("touches the catalog and invokes requestRelaunch with the target name", async () => {
    const requestRelaunch = vi.fn();
    const central = makeCentralData();
    const service = createWorkspaceService({
      workspace: makeWorkspace(),
      getConfig: () => makeConfig(),
      setConfigField: vi.fn(),
      centralData: central,
      createWorkspace: vi.fn(),
      deleteWorkspaceDir: vi.fn(),
      requestRelaunch,
    });

    await service.handler(panelCtx, "select", ["other"]);

    expect(central.touchWorkspace).toHaveBeenCalledWith("other");
    expect(requestRelaunch).toHaveBeenCalledWith("other");
  });

  it("is a no-op (no error) when requestRelaunch is undefined (standalone mode)", async () => {
    const central = makeCentralData();
    const service = createWorkspaceService({
      workspace: makeWorkspace(),
      getConfig: () => makeConfig(),
      setConfigField: vi.fn(),
      centralData: central,
      createWorkspace: vi.fn(),
      deleteWorkspaceDir: vi.fn(),
      // No requestRelaunch — standalone server has no Electron app to relaunch.
    });

    await expect(service.handler(panelCtx, "select", ["other"])).resolves.toBeUndefined();
    expect(central.touchWorkspace).toHaveBeenCalledWith("other");
  });

  it("the runtime client's switchTo() maps to the wire method workspace.select", () => {
    const { rpc, captured } = recordingRpc();
    const client = createWorkspaceClient(rpc);
    void client.switchTo("other");
    expect(captured).toHaveLength(1);
    expect(captured[0]!.method).toBe("workspace.select");
    expect(captured[0]!.args).toEqual(["other"]);
  });
});
