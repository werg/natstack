import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ServiceContext } from "../../../shared/serviceDispatcher.js";
import type { CentralDataManager } from "../../centralData.js";
import type { WorkspaceConfig } from "../../../shared/workspace/types.js";
import type { WorkspaceEntry } from "../../../shared/types.js";

// Mock electron app (workspace.select calls app.relaunch/app.exit)
vi.mock("electron", () => ({
  app: {
    relaunch: vi.fn(),
    exit: vi.fn(),
  },
}));

// Mock workspaceOps to avoid real filesystem operations
vi.mock("../../workspaceOps.js", () => ({
  createAndRegisterWorkspace: vi.fn(),
  deleteWorkspaceDir: vi.fn(),
}));

import { createWorkspaceService } from "../workspaceService.js";
import { createAndRegisterWorkspace, deleteWorkspaceDir } from "../../workspaceOps.js";

const shellCtx: ServiceContext = { callerId: "shell", callerKind: "shell" };
const panelCtx: ServiceContext = { callerId: "panel-1", callerKind: "panel" };
const workerCtx: ServiceContext = { callerId: "worker-1", callerKind: "worker" };

function makeCentralData(workspaces: WorkspaceEntry[] = []): CentralDataManager {
  return {
    listWorkspaces: vi.fn(() => workspaces),
    touchWorkspace: vi.fn(),
    removeWorkspace: vi.fn(),
    getWorkspaceEntry: vi.fn((name: string) => workspaces.find((w) => w.name === name) ?? null),
    hasWorkspace: vi.fn(),
    addWorkspace: vi.fn(),
    getLastOpenedWorkspace: vi.fn(),
  } as unknown as CentralDataManager;
}

function makeConfig(): WorkspaceConfig {
  return { id: "test-ws", initPanels: [{ source: "panels/chat" }], git: { port: 63524 } };
}

describe("workspaceService", () => {
  let config: WorkspaceConfig;
  let setField: ReturnType<typeof vi.fn>;
  let centralData: ReturnType<typeof makeCentralData>;

  function makeService(overrides?: { centralData?: CentralDataManager }) {
    return createWorkspaceService({
      centralData: overrides?.centralData ?? centralData,
      activeWorkspaceName: "test-ws",
      getWorkspaceConfig: () => config,
      setWorkspaceConfigField: setField,
    });
  }

  beforeEach(() => {
    vi.resetAllMocks();
    config = makeConfig();
    setField = vi.fn();
    centralData = makeCentralData([
      { name: "test-ws", lastOpened: 1000 },
      { name: "other", lastOpened: 900 },
    ]);
  });

  // ── getActiveEntry ──

  it("getActiveEntry returns the active workspace entry", async () => {
    const svc = makeService();
    const result = await svc.handler(shellCtx, "getActiveEntry", []);
    expect(centralData.getWorkspaceEntry).toHaveBeenCalledWith("test-ws");
    expect(result).toEqual({ name: "test-ws", lastOpened: 1000 });
  });

  it("getActiveEntry throws if entry not found", async () => {
    const empty = makeCentralData([]);
    const svc = makeService({ centralData: empty });
    await expect(svc.handler(shellCtx, "getActiveEntry", [])).rejects.toThrow("not found in registry");
  });

  it("getActiveEntry works for panel callers", async () => {
    const svc = makeService();
    const result = await svc.handler(panelCtx, "getActiveEntry", []);
    expect(result).toEqual({ name: "test-ws", lastOpened: 1000 });
  });

  // ── getConfig ──

  it("getConfig returns the live workspace config", async () => {
    const svc = makeService();
    const result = await svc.handler(panelCtx, "getConfig", []);
    expect(result).toBe(config);
    expect(result).toEqual({ id: "test-ws", initPanels: [{ source: "panels/chat" }], git: { port: 63524 } });
  });

  // ── setInitPanels ──

  it("setInitPanels calls setWorkspaceConfigField with the array", async () => {
    const svc = makeService();
    const entries = [{ source: "panels/setup" }, { source: "panels/chat", stateArgs: { agentClass: "Foo" } }];
    await svc.handler(panelCtx, "setInitPanels", [entries]);
    expect(setField).toHaveBeenCalledWith("initPanels", entries);
  });

  // ── delete guard ──

  it("delete is allowed for shell callers", async () => {
    const svc = makeService();
    await svc.handler(shellCtx, "delete", ["other"]);
    expect(vi.mocked(deleteWorkspaceDir)).toHaveBeenCalledWith("other");
    expect(centralData.removeWorkspace).toHaveBeenCalledWith("other");
  });

  it("delete is blocked for panel callers", async () => {
    const svc = makeService();
    await expect(svc.handler(panelCtx, "delete", ["other"])).rejects.toThrow(
      "Only the shell UI can delete workspaces"
    );
    expect(vi.mocked(deleteWorkspaceDir)).not.toHaveBeenCalled();
  });

  it("delete is blocked for worker callers", async () => {
    const svc = makeService();
    await expect(svc.handler(workerCtx, "delete", ["other"])).rejects.toThrow(
      "Only the shell UI can delete workspaces"
    );
  });

  it("delete rejects deleting the active workspace", async () => {
    const svc = makeService();
    await expect(svc.handler(shellCtx, "delete", ["test-ws"])).rejects.toThrow(
      "Cannot delete the currently running workspace"
    );
  });

  // ── existing methods still work ──

  it("list delegates to centralData", async () => {
    const svc = makeService();
    await svc.handler(panelCtx, "list", []);
    expect(centralData.listWorkspaces).toHaveBeenCalled();
  });

  it("getActive returns the active workspace name", async () => {
    const svc = makeService();
    const result = await svc.handler(workerCtx, "getActive", []);
    expect(result).toBe("test-ws");
  });

  it("create delegates to createAndRegisterWorkspace", async () => {
    const svc = makeService();
    await svc.handler(panelCtx, "create", ["new-ws", { forkFrom: "test-ws" }]);
    expect(vi.mocked(createAndRegisterWorkspace)).toHaveBeenCalledWith(
      "new-ws", centralData, { forkFrom: "test-ws" }
    );
  });
});
