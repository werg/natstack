import { describe, expect, it, vi } from "vitest";
import type { ServiceContext } from "@natstack/shared/serviceDispatcher";
import { createPanelShellService } from "./panelShellService.js";

const shellCtx: ServiceContext = {
  callerId: "shell",
  callerKind: "shell",
};

function createServiceHarness(panelExists: boolean) {
  const focusPanel = vi.fn();
  const rebuildUnloadedPanel = vi.fn(async () => {});
  const refreshVisiblePanel = vi.fn();
  const getPanel = vi.fn(() => (panelExists ? { id: "panel-1" } : undefined));

  const service = createPanelShellService({
    panelOrchestrator: {
      focusPanel,
      rebuildUnloadedPanel,
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
      }) as never,
  });

  return { service, focusPanel, rebuildUnloadedPanel, refreshVisiblePanel, getPanel };
}

describe("PanelShellService", () => {
  it("ignores focus notifications for missing panels", async () => {
    const { service, focusPanel, rebuildUnloadedPanel, refreshVisiblePanel } =
      createServiceHarness(false);

    await service.handler(shellCtx, "notifyFocused", ["missing-panel"]);

    expect(focusPanel).not.toHaveBeenCalled();
    expect(refreshVisiblePanel).not.toHaveBeenCalled();
    expect(rebuildUnloadedPanel).not.toHaveBeenCalled();
  });

  it("focuses and rebuilds existing panels", async () => {
    const { service, focusPanel, rebuildUnloadedPanel, refreshVisiblePanel } =
      createServiceHarness(true);

    await service.handler(shellCtx, "notifyFocused", ["panel-1"]);

    expect(focusPanel).toHaveBeenCalledWith("panel-1");
    expect(refreshVisiblePanel).toHaveBeenCalled();
    expect(rebuildUnloadedPanel).toHaveBeenCalledWith("panel-1");
  });
});
