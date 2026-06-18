import { createVerifiedCaller } from "@natstack/shared/serviceDispatcher";
import { describe, expect, it, vi } from "vitest";
import type { ServiceContext } from "@natstack/shared/serviceDispatcher";
import { createPanelShellService } from "./panelShellService.js";

const appCtx: ServiceContext = { caller: createVerifiedCaller("@workspace-apps/shell", "app") };

function createServiceHarness(panelExists: boolean, appCapabilities: string[] = []) {
  const focusPanel = vi.fn(async (panelId: string) => ({
    panelId,
    status: "loaded",
    focused: true,
    loaded: true,
  }));
  const refreshVisiblePanel = vi.fn();
  const getPanel = vi.fn(() => (panelExists ? { id: "panel-1" } : undefined));

  const service = createPanelShellService({
    panelOrchestrator: {
      focusPanel,
      getCollapsedIds: vi.fn(async () => []),
    } as never,
    panelRegistry: {
      getPanel,
      getSerializablePanelTree: vi.fn(() => []),
    } as never,
    panelView: {} as never,
    getViewManager: () =>
      ({
        refreshVisiblePanel,
        getViewInfo: vi.fn(() => ({
          type: "app",
          visible: true,
          bounds: { x: 0, y: 0, width: 100, height: 100 },
          capabilities: appCapabilities,
        })),
      }) as never,
  });

  return { service, focusPanel, refreshVisiblePanel, getPanel };
}

describe("PanelShellService", () => {
  it("ignores focus notifications for missing panels", async () => {
    const { service, focusPanel, refreshVisiblePanel } = createServiceHarness(false, [
      "panel-hosting",
    ]);

    const result = await service.handler(appCtx, "notifyFocused", ["missing-panel"]);

    expect(focusPanel).not.toHaveBeenCalled();
    expect(refreshVisiblePanel).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "missing", focused: false, loaded: false });
  });

  it("focuses and loads existing panels with a structured result", async () => {
    const { service, focusPanel, refreshVisiblePanel } = createServiceHarness(true, [
      "panel-hosting",
    ]);

    const result = await service.handler(appCtx, "notifyFocused", ["panel-1"]);

    expect(focusPanel).toHaveBeenCalledWith("panel-1", { loadIfNeeded: true });
    expect(refreshVisiblePanel).toHaveBeenCalled();
    expect(result).toMatchObject({ status: "loaded", focused: true, loaded: true });
  });

  it("allows app callers only when the panel-hosting capability is declared", async () => {
    const { service, focusPanel } = createServiceHarness(true, ["panel-hosting"]);

    const result = await service.handler(appCtx, "notifyFocused", ["panel-1"]);

    expect(focusPanel).toHaveBeenCalledWith("panel-1", { loadIfNeeded: true });
    expect(result).toMatchObject({ status: "loaded" });
  });

  it("denies app callers without the panel-hosting capability", async () => {
    const { service, focusPanel } = createServiceHarness(true);

    await expect(service.handler(appCtx, "notifyFocused", ["panel-1"])).rejects.toThrow(
      /panel-hosting/
    );
    expect(focusPanel).not.toHaveBeenCalled();
  });

  it("denies bootstrap shell callers for panel-hosting operations", async () => {
    const { service, focusPanel } = createServiceHarness(true, ["panel-hosting"]);

    await expect(
      service.handler({ caller: createVerifiedCaller("shell", "shell") }, "notifyFocused", [
        "panel-1",
      ])
    ).rejects.toThrow(/restricted to app callers/);
    expect(focusPanel).not.toHaveBeenCalled();
  });
});

function routingHarness(opts: { withServerClient: boolean }) {
  const calls: Array<{ service: string; method: string; args: unknown[] }> = [];
  const serverClient = opts.withServerClient
    ? {
        call: vi.fn(async (service: string, method: string, args: unknown[]) => {
          calls.push({ service, method, args });
          return { id: "srv-panel", title: "Srv" };
        }),
      }
    : null;
  const lifecycle = {
    navigatePanel: vi.fn(async () => ({ id: "p", title: "t" })),
    navigatePanelHistory: vi.fn(async () => null),
    createRootPanel: vi.fn(async () => ({ id: "p", title: "t" })),
    createPanel: vi.fn(async () => ({ id: "p", title: "t" })),
    createAboutPanel: vi.fn(async () => ({ id: "p", title: "t" })),
    createBrowserUrlPanel: vi.fn(async () => ({ id: "p", title: "t" })),
    closePanel: vi.fn(async () => ({})),
    unloadPanel: vi.fn(async () => ({})),
    movePanel: vi.fn(async () => {}),
    reloadPanel: vi.fn(async () => ({})),
    rebuildPanel: vi.fn(async () => ({})),
    rebuildAndReloadPanel: vi.fn(async () => ({})),
    takeOverPanel: vi.fn(async () => {}),
    getCollapsedIds: vi.fn(async () => []),
  };
  const service = createPanelShellService({
    panelOrchestrator: lifecycle as never,
    panelRegistry: {
      getPanel: vi.fn(() => ({ id: "panel-1" })),
      getRuntimeLease: vi.fn(() => null),
    } as never,
    panelView: {} as never,
    getViewManager: () =>
      ({
        getViewInfo: vi.fn(() => ({
          type: "app",
          visible: true,
          bounds: { x: 0, y: 0, width: 1, height: 1 },
          capabilities: ["panel-hosting"],
        })),
        getWebContents: vi.fn(() => null),
        refreshVisiblePanel: vi.fn(),
      }) as never,
    serverClient: serverClient as never,
  });
  return { service, calls, lifecycle };
}

describe("PanelShellService — server authority routing", () => {
  it("routes structural ops straight to the panelTree service", async () => {
    const { service, calls } = routingHarness({ withServerClient: true });

    await service.handler(appCtx, "archive", ["panel-1"]);
    await service.handler(appCtx, "unload", ["panel-1"]);
    await service.handler(appCtx, "movePanel", [
      { panelId: "panel-1", newParentId: null, targetPosition: 2 },
    ]);
    await service.handler(appCtx, "reload", ["panel-1"]);
    await service.handler(appCtx, "rebuildPanel", ["panel-1"]);
    await service.handler(appCtx, "rebuildAndReload", ["panel-1"]);
    await service.handler(appCtx, "takeOver", ["panel-1"]);

    expect(calls).toEqual([
      { service: "panelTree", method: "archive", args: ["panel-1"] },
      { service: "panelTree", method: "unload", args: ["panel-1"] },
      {
        service: "panelTree",
        method: "movePanel",
        args: [{ panelId: "panel-1", newParentId: null, targetPosition: 2 }],
      },
      { service: "panelTree", method: "reload", args: ["panel-1"] },
      { service: "panelTree", method: "rebuildPanel", args: ["panel-1"] },
      { service: "panelTree", method: "rebuildAndReload", args: ["panel-1"] },
      { service: "panelTree", method: "takeOver", args: ["panel-1"] },
    ]);
  });

  it("routes create + navigate + history through the orchestrator (server write AND view build)", async () => {
    const { service, calls, lifecycle } = routingHarness({ withServerClient: true });

    await service.handler(appCtx, "create", ["panels/x", { name: "N", ref: "HEAD" }]);
    await service.handler(appCtx, "createChild", ["parent-1", "panels/x", { focus: true }]);
    await service.handler(appCtx, "createAboutPanel", ["new"]);
    await service.handler(appCtx, "createBrowser", ["https://example.com/", {}]);
    await service.handler(appCtx, "navigate", ["panel-1", "panels/x", { ref: "HEAD" }]);

    // The orchestrator routes the WRITE to panelTree internally and builds the
    // view (createViaServer/navigatePanel → attachCreatedPanel) — these must NOT
    // short-circuit to panelTree here (that creates a slot with no view → endless
    // spinner) and must not appear in the direct panelTree calls.
    expect(lifecycle.createRootPanel).toHaveBeenCalledWith("panels/x", { name: "N", ref: "HEAD" });
    expect(lifecycle.createPanel).toHaveBeenCalledWith("parent-1", "panels/x", { focus: true });
    expect(lifecycle.createAboutPanel).toHaveBeenCalledWith("new");
    expect(lifecycle.createBrowserUrlPanel).toHaveBeenCalledWith(
      "shell",
      "https://example.com/",
      expect.objectContaining({ focus: true })
    );
    expect(lifecycle.navigatePanel).toHaveBeenCalledWith("panel-1", "panels/x", { ref: "HEAD" });
    expect(calls.filter((c) => c.method === "create" || c.method === "navigate")).toEqual([]);
  });

  it("requires a server connection for direct panelTree mutations (no local fallback)", async () => {
    const { service } = routingHarness({ withServerClient: false });

    await expect(service.handler(appCtx, "unload", ["panel-1"])).rejects.toThrow(
      /server connection/
    );
    await expect(service.handler(appCtx, "archive", ["panel-1"])).rejects.toThrow(
      /server connection/
    );
  });
});
