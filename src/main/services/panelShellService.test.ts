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
