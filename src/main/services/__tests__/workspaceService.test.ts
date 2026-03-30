import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ServiceContext } from "@natstack/shared/serviceDispatcher";
import type { WorkspaceConfig } from "@natstack/shared/workspace/types";

import { createWorkspaceService } from "../workspaceService.js";

const shellCtx: ServiceContext = { callerId: "shell", callerKind: "shell" };
const panelCtx: ServiceContext = { callerId: "panel-1", callerKind: "panel" };
const workerCtx: ServiceContext = { callerId: "worker-1", callerKind: "worker" };

function makeConfig(): WorkspaceConfig {
  return { id: "test-ws", initPanels: [{ source: "panels/chat" }], git: { port: 63524 } };
}

function makeServerClient() {
  return {
    call: vi.fn(async (service: string, method: string, args: unknown[]) => {
      if (service === "workspaceInfo") {
        switch (method) {
          case "listWorkspaces":
            return [{ name: "test-ws", lastOpened: 1000 }, { name: "other", lastOpened: 900 }];
          case "touchWorkspace":
            return;
          case "createWorkspace":
            return { name: args[0], lastOpened: Date.now() };
          case "deleteWorkspace":
            return;
          case "getWorkspaceEntry":
            if (args[0] === "test-ws") return { name: "test-ws", lastOpened: 1000 };
            return null;
        }
      }
      throw new Error(`Unexpected RPC: ${service}.${method}`);
    }),
  };
}

describe("workspaceService", () => {
  let config: WorkspaceConfig;
  let setField: ReturnType<typeof vi.fn>;
  let restartWithWorkspace: ReturnType<typeof vi.fn>;
  let serverClient: ReturnType<typeof makeServerClient>;

  function makeService() {
    return createWorkspaceService({
      activeWorkspaceName: "test-ws",
      getWorkspaceConfig: () => config,
      setWorkspaceConfigField: setField,
      restartWithWorkspace,
      serverClient,
    });
  }

  beforeEach(() => {
    vi.resetAllMocks();
    config = makeConfig();
    setField = vi.fn();
    restartWithWorkspace = vi.fn();
    serverClient = makeServerClient();
  });

  // ── select ──

  it("select calls server touchWorkspace then restartWithWorkspace", async () => {
    const svc = makeService();
    await svc.handler(shellCtx, "select", ["other-ws"]);
    expect(serverClient.call).toHaveBeenCalledWith("workspaceInfo", "touchWorkspace", ["other-ws"]);
    expect(restartWithWorkspace).toHaveBeenCalledWith("other-ws");
  });

  // ── getActiveEntry ──

  it("getActiveEntry delegates to server getWorkspaceEntry", async () => {
    const svc = makeService();
    const result = await svc.handler(shellCtx, "getActiveEntry", []);
    expect(serverClient.call).toHaveBeenCalledWith("workspaceInfo", "getWorkspaceEntry", ["test-ws"]);
    expect(result).toEqual({ name: "test-ws", lastOpened: 1000 });
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
  });

  // ── setInitPanels ──

  it("setInitPanels calls setWorkspaceConfigField with the array", async () => {
    const svc = makeService();
    const entries = [{ source: "panels/setup" }, { source: "panels/chat", stateArgs: { agentClass: "Foo" } }];
    await svc.handler(panelCtx, "setInitPanels", [entries]);
    expect(setField).toHaveBeenCalledWith("initPanels", entries);
  });

  // ── delete guard ──

  it("delete delegates to server deleteWorkspace", async () => {
    const svc = makeService();
    await svc.handler(shellCtx, "delete", ["other"]);
    expect(serverClient.call).toHaveBeenCalledWith("workspaceInfo", "deleteWorkspace", ["other"]);
  });

  it("delete is blocked for panel callers", async () => {
    const svc = makeService();
    await expect(svc.handler(panelCtx, "delete", ["other"])).rejects.toThrow(
      "Only the shell UI can delete workspaces"
    );
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

  // ── list and create delegate to server ──

  it("list delegates to server listWorkspaces", async () => {
    const svc = makeService();
    const result = await svc.handler(panelCtx, "list", []);
    expect(serverClient.call).toHaveBeenCalledWith("workspaceInfo", "listWorkspaces", []);
    expect(result).toEqual([{ name: "test-ws", lastOpened: 1000 }, { name: "other", lastOpened: 900 }]);
  });

  it("getActive returns the active workspace name", async () => {
    const svc = makeService();
    const result = await svc.handler(workerCtx, "getActive", []);
    expect(result).toBe("test-ws");
  });

  it("create delegates to server createWorkspace", async () => {
    const svc = makeService();
    await svc.handler(panelCtx, "create", ["new-ws", { forkFrom: "test-ws" }]);
    expect(serverClient.call).toHaveBeenCalledWith("workspaceInfo", "createWorkspace", ["new-ws", { forkFrom: "test-ws" }]);
  });
});
