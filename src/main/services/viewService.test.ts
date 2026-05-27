import { createVerifiedCaller } from "@natstack/shared/serviceDispatcher";
import { describe, expect, it, vi } from "vitest";

import { createViewService } from "./viewService.js";

function makeViewManager(capabilities: string[] = []) {
  return {
    getViewInfo: vi.fn((id: string) =>
      id === "@workspace-apps/shell"
        ? {
            type: "app",
            visible: true,
            bounds: { x: 0, y: 0, width: 800, height: 600 },
            capabilities,
          }
        : null
    ),
    updateLayout: vi.fn(),
    setPanelViewportBounds: vi.fn(),
    setHostedShellReady: vi.fn(),
    bindPanelSlot: vi.fn(),
    updatePanelSlot: vi.fn(),
    clearPanelSlot: vi.fn(),
    setThemeCss: vi.fn(),
    setViewVisible: vi.fn(),
  };
}

describe("view service", () => {
  it("keeps legacy shell layout updates available to the bootstrap shell", async () => {
    const vm = makeViewManager();
    const service = createViewService({ getViewManager: () => vm as never });

    await expect(
      service.handler({ caller: createVerifiedCaller("shell", "shell") }, "updateLayout", [
        { sidebarVisible: true },
      ])
    ).resolves.toBeUndefined();

    expect(vm.updateLayout).toHaveBeenCalledWith({ sidebarVisible: true });
  });

  it("keeps legacy panel viewport reports available to the bootstrap shell", async () => {
    const vm = makeViewManager();
    const service = createViewService({ getViewManager: () => vm as never });
    const bounds = { x: 12, y: 80, width: 700, height: 500 };

    await expect(
      service.handler(
        { caller: createVerifiedCaller("shell", "shell") },
        "updatePanelViewportBounds",
        [bounds]
      )
    ).resolves.toBeUndefined();

    expect(vm.setPanelViewportBounds).toHaveBeenCalledWith(bounds);
  });

  it("rejects hosted apps for legacy panel layout APIs", async () => {
    const vm = makeViewManager(["panel-hosting"]);
    const service = createViewService({ getViewManager: () => vm as never });
    const caller = { caller: createVerifiedCaller("@workspace-apps/shell", "app") };

    await expect(
      service.handler(caller, "updateLayout", [{ sidebarVisible: true }])
    ).rejects.toThrow(/native panel slots/);
    await expect(
      service.handler(caller, "updatePanelViewportBounds", [
        { x: 12, y: 80, width: 700, height: 500 },
      ])
    ).rejects.toThrow(/native panel slots/);

    expect(vm.updateLayout).not.toHaveBeenCalled();
    expect(vm.setPanelViewportBounds).not.toHaveBeenCalled();
  });

  it("rejects ordinary apps for host-wide view controls", async () => {
    const vm = makeViewManager([]);
    const service = createViewService({ getViewManager: () => vm as never });

    await expect(
      service.handler(
        { caller: createVerifiedCaller("@workspace-apps/shell", "app") },
        "setThemeCss",
        [":root{}"]
      )
    ).rejects.toThrow(/cannot host workspace views/);

    expect(vm.setThemeCss).not.toHaveBeenCalled();
  });

  it("allows a panel-hosting workspace app to bind native panel slots", async () => {
    const vm = makeViewManager(["panel-hosting"]);
    const service = createViewService({ getViewManager: () => vm as never });
    const request = {
      nativeSlotId: "panel-stack:primary",
      panelId: "panel-1",
      bounds: { x: 10, y: 20, width: 300, height: 200 },
      focused: true,
    };

    await expect(
      service.handler(
        { caller: createVerifiedCaller("@workspace-apps/shell", "app") },
        "bindNativePanelSlot",
        [request]
      )
    ).resolves.toBeUndefined();

    expect(vm.bindPanelSlot).toHaveBeenCalledWith("@workspace-apps/shell", request);
  });

  it("rejects bootstrap shell callers for native panel slots", async () => {
    const vm = makeViewManager(["panel-hosting"]);
    const service = createViewService({ getViewManager: () => vm as never });

    await expect(
      service.handler({ caller: createVerifiedCaller("shell", "shell") }, "setHostedShellReady", [
        { ready: true },
      ])
    ).rejects.toThrow(/cannot place native panel slots/);

    expect(vm.setHostedShellReady).not.toHaveBeenCalled();
  });
});
