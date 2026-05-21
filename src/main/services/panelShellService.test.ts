import { createVerifiedCaller } from "@natstack/shared/serviceDispatcher";
import { describe, expect, it, vi } from "vitest";
import type { ServiceContext } from "@natstack/shared/serviceDispatcher";
import { createPanelShellService } from "./panelShellService.js";

const shellCtx: ServiceContext = { caller: createVerifiedCaller("shell", "shell") };

function createServiceHarness(panelExists: boolean) {
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
      }) as never,
  });

  return { service, focusPanel, refreshVisiblePanel, getPanel };
}

describe("PanelShellService", () => {
  it("ignores focus notifications for missing panels", async () => {
    const { service, focusPanel, refreshVisiblePanel } = createServiceHarness(false);

    const result = await service.handler(shellCtx, "notifyFocused", ["missing-panel"]);

    expect(focusPanel).not.toHaveBeenCalled();
    expect(refreshVisiblePanel).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "missing", focused: false, loaded: false });
  });

  it("focuses and loads existing panels with a structured result", async () => {
    const { service, focusPanel, refreshVisiblePanel } = createServiceHarness(true);

    const result = await service.handler(shellCtx, "notifyFocused", ["panel-1"]);

    expect(focusPanel).toHaveBeenCalledWith("panel-1", { loadIfNeeded: true });
    expect(refreshVisiblePanel).toHaveBeenCalled();
    expect(result).toMatchObject({ status: "loaded", focused: true, loaded: true });
  });
});
