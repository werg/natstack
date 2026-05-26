import { describe, expect, it, vi } from "vitest";

import { createVerifiedCaller } from "@natstack/shared/serviceDispatcher";
import { createAppService } from "./appService.js";

vi.mock("electron", () => ({
  app: { getVersion: () => "0.0.0-test" },
  nativeTheme: {
    shouldUseDarkColors: false,
    themeSource: "system",
  },
  shell: {
    openExternal: vi.fn(async () => undefined),
    openPath: vi.fn(async () => ""),
  },
}));

function makeService() {
  const appOrchestrator = {
    applyPendingAppUpdate: vi.fn(async () => true),
    listPendingAppUpdates: vi.fn(() => [{ appId: "@workspace-apps/shell" }]),
  };
  const viewManager = {
    getViewInfo: vi.fn((id: string) =>
      id === "@workspace-apps/shell"
        ? { type: "app", capabilities: ["open-external", "panel-hosting", "window-management"] }
        : null
    ),
    openDevTools: vi.fn(),
  };
  const service = createAppService({
    panelOrchestrator: { invalidateReadyPanels: vi.fn() } as never,
    serverClient: {
      call: vi.fn(async (serviceName: string, method: string) => {
        if (serviceName === "workspace" && method === "getInfo") return { path: "/workspace" };
        if (serviceName === "build" && method === "getAboutPages") return [];
        return null;
      }),
      getConnectionStatus: vi.fn(() => "connected"),
    } as never,
    getViewManager: () => viewManager as never,
    getAppOrchestrator: () => appOrchestrator as never,
    connectionMode: "local",
  });
  return { service, viewManager, appOrchestrator };
}

describe("createAppService", () => {
  it("does not grant app-host capabilities to the bootstrap shell caller", async () => {
    const { service } = makeService();
    const shellCtx = { caller: createVerifiedCaller("shell", "shell") };

    await expect(
      service.handler(shellCtx, "openExternal", ["https://example.com"])
    ).rejects.toThrow(/restricted to app callers/);
    await expect(service.handler(shellCtx, "clearBuildCache", [])).rejects.toThrow(
      /restricted to app callers/
    );
  });

  it("allows app callers with declared capabilities to use app-host surfaces", async () => {
    const { service } = makeService();
    const appCtx = {
      caller: createVerifiedCaller("@workspace-apps/shell", "app", {
        callerId: "@workspace-apps/shell",
        callerKind: "app",
        repoPath: "apps/shell",
        effectiveVersion: "ev-shell",
      }),
    };

    await expect(
      service.handler(appCtx, "openExternal", ["https://example.com"])
    ).resolves.toBeUndefined();
  });

  it("lets shell and panel-hosting apps apply queued app updates", async () => {
    const { service, appOrchestrator } = makeService();
    const shellCtx = { caller: createVerifiedCaller("shell", "shell") };
    const appCtx = {
      caller: createVerifiedCaller("@workspace-apps/shell", "app", {
        callerId: "@workspace-apps/shell",
        callerKind: "app",
        repoPath: "apps/shell",
        effectiveVersion: "ev-shell",
      }),
    };

    await expect(
      service.handler(shellCtx, "applyUpdate", ["@workspace-apps/shell"])
    ).resolves.toEqual({ applied: true });
    await expect(service.handler(appCtx, "listPendingUpdates", [])).resolves.toEqual([
      { appId: "@workspace-apps/shell" },
    ]);
    expect(appOrchestrator.applyPendingAppUpdate).toHaveBeenCalledWith("@workspace-apps/shell");
  });
});
