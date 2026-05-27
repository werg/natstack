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
    setThemeCss: vi.fn(),
    setViewVisible: vi.fn(),
  };
}

describe("view service", () => {
  it("allows a panel-hosting workspace app to manage host layout", async () => {
    const vm = makeViewManager(["panel-hosting"]);
    const service = createViewService({ getViewManager: () => vm as never });

    await expect(
      service.handler(
        { caller: createVerifiedCaller("@workspace-apps/shell", "app") },
        "updateLayout",
        [{ sidebarVisible: true }]
      )
    ).resolves.toBeUndefined();

    expect(vm.updateLayout).toHaveBeenCalledWith({ sidebarVisible: true });
  });

  it("accepts measured panel content bounds from a panel-hosting workspace app", async () => {
    const vm = makeViewManager(["panel-hosting"]);
    const service = createViewService({ getViewManager: () => vm as never });
    const panelContentBounds = { x: 260, y: 90, width: 900, height: 650 };

    await expect(
      service.handler(
        { caller: createVerifiedCaller("@workspace-apps/shell", "app") },
        "updateLayout",
        [{ panelContentBounds }]
      )
    ).resolves.toBeUndefined();

    expect(vm.updateLayout).toHaveBeenCalledWith({ panelContentBounds });
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
});
