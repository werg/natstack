/**
 * Tests for browser service.
 */

import {
  getCdpEndpointForCaller,
  createBrowserService,
} from "../services/browserService.js";
import type { ServiceContext } from "../../shared/serviceDispatcher.js";

describe("getCdpEndpointForCaller", () => {
  it("returns endpoint when cdpServer.getCdpEndpoint succeeds", () => {
    const cdpServer = {
      getCdpEndpoint: vi.fn().mockReturnValue("ws://127.0.0.1:9222"),
    };
    const result = getCdpEndpointForCaller(cdpServer as any, "browser-1", "panel-1");
    expect(cdpServer.getCdpEndpoint).toHaveBeenCalledWith("browser-1", "panel-1");
    expect(result).toBe("ws://127.0.0.1:9222");
  });

  it("throws when cdpServer returns null", () => {
    const cdpServer = {
      getCdpEndpoint: vi.fn().mockReturnValue(null),
    };
    expect(() =>
      getCdpEndpointForCaller(cdpServer as any, "browser-1", "panel-1"),
    ).toThrow("Access denied: you do not own this browser panel");
  });
});

describe("browserService handler", () => {
  const cdpServer = {
    getCdpEndpoint: vi.fn().mockReturnValue("ws://127.0.0.1:9222"),
    panelOwnsBrowser: vi.fn().mockReturnValue(true),
  };
  const mockWc = {
    loadURL: vi.fn().mockResolvedValue(undefined),
    reload: vi.fn(),
    stop: vi.fn(),
    goBack: vi.fn(),
    goForward: vi.fn(),
  };
  const viewManager = {
    getWebContents: vi.fn().mockReturnValue(mockWc),
  };
  const panelManager = {};

  const svc = createBrowserService({
    cdpServer: cdpServer as any,
    getViewManager: () => viewManager as any,
    panelRegistry: panelManager as any,
  });
  const handler = svc.handler;
  const ctx: ServiceContext = { callerId: "panel-1", callerKind: "panel" };

  beforeEach(() => {
    vi.clearAllMocks();
    cdpServer.panelOwnsBrowser.mockReturnValue(true);
    cdpServer.getCdpEndpoint.mockReturnValue("ws://127.0.0.1:9222");
    viewManager.getWebContents.mockReturnValue(mockWc);
    mockWc.loadURL.mockResolvedValue(undefined);
  });

  it("getCdpEndpoint delegates correctly", async () => {
    const result = await handler(ctx, "getCdpEndpoint", ["browser-1"]);
    expect(cdpServer.getCdpEndpoint).toHaveBeenCalledWith("browser-1", "panel-1");
    expect(result).toBe("ws://127.0.0.1:9222");
  });

  it("navigate checks ownership, calls wc.loadURL, ignores ERR_ABORTED", async () => {
    await handler(ctx, "navigate", ["browser-1", "https://example.com"]);
    expect(cdpServer.panelOwnsBrowser).toHaveBeenCalledWith("panel-1", "browser-1");
    expect(mockWc.loadURL).toHaveBeenCalledWith("https://example.com");

    // ERR_ABORTED should be silently ignored
    mockWc.loadURL.mockRejectedValue({ code: "ERR_ABORTED" });
    await expect(
      handler(ctx, "navigate", ["browser-1", "https://example.com"]),
    ).resolves.toBeUndefined();
  });

  it("navigate throws when caller does not own browser", async () => {
    cdpServer.panelOwnsBrowser.mockReturnValue(false);
    await expect(
      handler(ctx, "navigate", ["browser-1", "https://example.com"]),
    ).rejects.toThrow("Access denied");
  });

  it("goBack checks ownership and delegates", async () => {
    await handler(ctx, "goBack", ["browser-1"]);
    expect(cdpServer.panelOwnsBrowser).toHaveBeenCalledWith("panel-1", "browser-1");
    expect(mockWc.goBack).toHaveBeenCalled();
  });

  it("goForward checks ownership and delegates", async () => {
    await handler(ctx, "goForward", ["browser-1"]);
    expect(cdpServer.panelOwnsBrowser).toHaveBeenCalledWith("panel-1", "browser-1");
    expect(mockWc.goForward).toHaveBeenCalled();
  });

  it("throws on unknown method", async () => {
    await expect(handler(ctx, "unknownMethod", ["browser-1"])).rejects.toThrow(
      "Unknown browser method: unknownMethod",
    );
  });
});
