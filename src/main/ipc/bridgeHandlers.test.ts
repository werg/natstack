/**
 * Tests for bridge service.
 */

import { handleCommonBridgeMethod } from "@natstack/shared/bridgeHandlersCommon";

vi.mock("electron", () => ({
  dialog: { showOpenDialog: vi.fn() },
}));
vi.mock("../panelManager.js");
vi.mock("../cdpServer.js");
vi.mock("@natstack/shared/bridgeHandlersCommon", () => ({
  handleCommonBridgeMethod: vi.fn(),
}));

import { createBridgeService } from "../services/bridgeService.js";
import type { ServiceContext } from "@natstack/shared/serviceDispatcher";

const mockGetViewManager = vi.fn();

describe("bridgeService", () => {
  const pm = {
    getWorkspaceTree: vi.fn(),
    listBranches: vi.fn(),
    listCommits: vi.fn(),
    unloadPanel: vi.fn(),
    focusPanel: vi.fn(),
    reloadPanel: vi.fn(),
    closePanel: vi.fn(),
    getInfo: vi.fn(),
    handleSetStateArgs: vi.fn(),
    getBootstrapConfig: vi.fn(),
    getPanel: vi.fn(),
    findParentId: vi.fn(),
    isDescendantOf: vi.fn(),
  };
  const cdpServer = {
    panelOwnsBrowser: vi.fn(),
  };

  const svc = createBridgeService({
    panelOrchestrator: pm as any,
    cdpServer: cdpServer as any,
    getViewManager: mockGetViewManager as any,
    serverInfo: {} as any,
  });
  const handler = svc.handler;
  const ctx: ServiceContext = { callerId: "panel-1", callerKind: "panel" };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(handleCommonBridgeMethod).mockResolvedValue({ handled: false });
  });

  it("returns result when handleCommonBridgeMethod handles the call", async () => {
    vi.mocked(handleCommonBridgeMethod).mockResolvedValue({
      handled: true,
      result: { id: "child-1" },
    });
    const result = await handler(ctx, "createChild", [{ type: "chat" }]);
    expect(result).toEqual({ id: "child-1" });
  });

  it("throws on unknown method not handled by common handler", async () => {
    await expect(handler(ctx, "totallyUnknownMethod", [])).rejects.toThrow(
      "Unknown bridge method: totallyUnknownMethod",
    );
  });
});
