import { describe, expect, it, vi } from "vitest";
import { createVerifiedCaller, ServiceDispatcher } from "@natstack/shared/serviceDispatcher";
import { createAdblockService } from "./adblockService.js";

function createManager() {
  return {
    getConfig: vi.fn(() => ({})),
    setEnabled: vi.fn(),
    setListEnabled: vi.fn(),
    addCustomList: vi.fn(),
    removeCustomList: vi.fn(),
    addToWhitelist: vi.fn(),
    removeFromWhitelist: vi.fn(),
    getStats: vi.fn(() => ({ blockedRequests: 0 })),
    resetStats: vi.fn(),
    rebuildEngine: vi.fn(),
    isActive: vi.fn(() => true),
    getStatsForPanel: vi.fn(() => ({ blockedRequests: 0 })),
    isEnabledForPanel: vi.fn(() => true),
    setEnabledForPanel: vi.fn(),
    resetStatsForPanel: vi.fn(),
    getPanelUrl: vi.fn(() => "https://example.test/"),
  };
}

describe("createAdblockService", () => {
  it("allows panel callers to use panel adblock methods", async () => {
    const manager = createManager();
    const dispatcher = new ServiceDispatcher();
    dispatcher.registerService(createAdblockService({ adBlockManager: manager as never }));
    dispatcher.markInitialized();

    const result = await dispatcher.dispatch(
      { caller: createVerifiedCaller("panel:test", "panel") },
      "adblock",
      "getPanelUrl",
      [123]
    );

    expect(result).toBe("https://example.test/");
    expect(manager.getPanelUrl).toHaveBeenCalledWith(123);
  });

  it("keeps global adblock configuration methods shell-only", async () => {
    const manager = createManager();
    const dispatcher = new ServiceDispatcher();
    dispatcher.registerService(createAdblockService({ adBlockManager: manager as never }));
    dispatcher.markInitialized();

    await expect(
      dispatcher.dispatch(
        { caller: createVerifiedCaller("panel:test", "panel") },
        "adblock",
        "setEnabled",
        [false]
      )
    ).rejects.toThrow("not accessible to panel callers");
    expect(manager.setEnabled).not.toHaveBeenCalled();
  });
});
