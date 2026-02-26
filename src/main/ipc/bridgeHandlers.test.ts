/**
 * Tests for bridge service handlers.
 */

import { handleCommonBridgeMethod } from "../../shared/bridgeHandlersCommon.js";

vi.mock("electron", () => ({
  dialog: { showOpenDialog: vi.fn() },
}));
vi.mock("../panelManager.js");
vi.mock("../cdpServer.js");
vi.mock("../viewManager.js", () => ({ getViewManager: vi.fn() }));
vi.mock("../paths.js", () => ({ getActiveWorkspace: vi.fn() }));
vi.mock("../../shared/bridgeHandlersCommon.js", () => ({
  handleCommonBridgeMethod: vi.fn(),
}));

import { handleBridgeCall } from "./bridgeHandlers.js";

describe("handleBridgeCall", () => {
  const pm = {
    findParentId: vi.fn(),
    goBack: vi.fn().mockResolvedValue(undefined),
    goForward: vi.fn().mockResolvedValue(undefined),
    navigatePanel: vi.fn().mockResolvedValue(undefined),
    createBrowserChild: vi.fn(),
    getWorkspaceTree: vi.fn(),
    listBranches: vi.fn(),
    listCommits: vi.fn(),
    unloadPanel: vi.fn(),
    ensurePanelLoaded: vi.fn(),
    forceRepaint: vi.fn(),
    listAgents: vi.fn(),
    handleHistoryPushState: vi.fn(),
    handleHistoryReplaceState: vi.fn(),
    goToHistoryOffset: vi.fn(),
    reloadPanel: vi.fn(),
    isDescendantOf: vi.fn(),
    updateBrowserState: vi.fn(),
  };
  const cdpServer = {
    panelOwnsBrowser: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(handleCommonBridgeMethod).mockResolvedValue({ handled: false });
  });

  it("returns result when handleCommonBridgeMethod handles the call", async () => {
    vi.mocked(handleCommonBridgeMethod).mockResolvedValue({
      handled: true,
      result: { id: "child-1" },
    });
    const result = await handleBridgeCall(
      pm as any,
      cdpServer as any,
      "panel-1",
      "createChild",
      [{ type: "chat" }],
    );
    expect(result).toEqual({ id: "child-1" });
    // Should not proceed to switch cases
    expect(pm.goBack).not.toHaveBeenCalled();
  });

  it("goBack validates parent-child relationship", async () => {
    pm.findParentId.mockReturnValue("panel-1");
    await handleBridgeCall(
      pm as any,
      cdpServer as any,
      "panel-1",
      "goBack",
      ["child-1"],
    );
    expect(pm.findParentId).toHaveBeenCalledWith("child-1");
    expect(pm.goBack).toHaveBeenCalledWith("child-1");

    // Should throw when caller is not the parent
    pm.findParentId.mockReturnValue("other-panel");
    await expect(
      handleBridgeCall(
        pm as any,
        cdpServer as any,
        "panel-1",
        "goBack",
        ["child-1"],
      ),
    ).rejects.toThrow('Panel "panel-1" is not the parent of "child-1"');
  });

  it("goForward validates parent-child relationship", async () => {
    pm.findParentId.mockReturnValue("panel-1");
    await handleBridgeCall(
      pm as any,
      cdpServer as any,
      "panel-1",
      "goForward",
      ["child-1"],
    );
    expect(pm.findParentId).toHaveBeenCalledWith("child-1");
    expect(pm.goForward).toHaveBeenCalledWith("child-1");

    // Should throw when caller is not the parent
    pm.findParentId.mockReturnValue("other-panel");
    await expect(
      handleBridgeCall(
        pm as any,
        cdpServer as any,
        "panel-1",
        "goForward",
        ["child-1"],
      ),
    ).rejects.toThrow('Panel "panel-1" is not the parent of "child-1"');
  });

  it("navigatePanel validates parent-child relationship", async () => {
    pm.findParentId.mockReturnValue("panel-1");
    await handleBridgeCall(
      pm as any,
      cdpServer as any,
      "panel-1",
      "navigatePanel",
      ["child-1", "ns://source", "chat"],
    );
    expect(pm.findParentId).toHaveBeenCalledWith("child-1");
    expect(pm.navigatePanel).toHaveBeenCalledWith(
      "child-1",
      "ns://source",
      "chat",
    );

    // Should throw when caller is not the parent
    pm.findParentId.mockReturnValue("other-panel");
    await expect(
      handleBridgeCall(
        pm as any,
        cdpServer as any,
        "panel-1",
        "navigatePanel",
        ["child-1", "ns://source", "chat"],
      ),
    ).rejects.toThrow('Panel "panel-1" is not the parent of "child-1"');
  });

  it("throws on unknown method not handled by common handler", async () => {
    await expect(
      handleBridgeCall(
        pm as any,
        cdpServer as any,
        "panel-1",
        "totallyUnknownMethod",
        [],
      ),
    ).rejects.toThrow("Unknown bridge method: totallyUnknownMethod");
  });
});
