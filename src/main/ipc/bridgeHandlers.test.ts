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
    getWorkspaceTree: vi.fn(),
    listBranches: vi.fn(),
    listCommits: vi.fn(),
    unloadPanel: vi.fn(),
    focusPanel: vi.fn(),
    listAgents: vi.fn(),
    reloadPanel: vi.fn(),
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
