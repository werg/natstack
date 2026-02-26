/**
 * Tests for browser service handlers.
 */

import {
  getCdpEndpointForCaller,
  handleBrowserCall,
} from "./browserHandlers.js";

describe("getCdpEndpointForCaller", () => {
  it("returns endpoint when cdpServer.getCdpEndpoint succeeds", () => {
    const cdpServer = {
      getCdpEndpoint: vi.fn().mockReturnValue("ws://127.0.0.1:9222"),
    };
    const result = getCdpEndpointForCaller(
      cdpServer as any,
      "browser-1",
      "panel-1",
    );
    expect(cdpServer.getCdpEndpoint).toHaveBeenCalledWith(
      "browser-1",
      "panel-1",
    );
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

describe("handleBrowserCall", () => {
  const cdpServer = {
    getCdpEndpoint: vi.fn().mockReturnValue("ws://127.0.0.1:9222"),
    panelOwnsBrowser: vi.fn().mockReturnValue(true),
  };
  const mockWc = {
    loadURL: vi.fn().mockResolvedValue(undefined),
    reload: vi.fn(),
    stop: vi.fn(),
  };
  const viewManager = {
    getWebContents: vi.fn().mockReturnValue(mockWc),
  };
  const panelManager = {
    goBack: vi.fn().mockResolvedValue(undefined),
    goForward: vi.fn().mockResolvedValue(undefined),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    cdpServer.panelOwnsBrowser.mockReturnValue(true);
    cdpServer.getCdpEndpoint.mockReturnValue("ws://127.0.0.1:9222");
    viewManager.getWebContents.mockReturnValue(mockWc);
    mockWc.loadURL.mockResolvedValue(undefined);
  });

  it("getCdpEndpoint delegates to getCdpEndpointForCaller", async () => {
    const result = await handleBrowserCall(
      cdpServer as any,
      viewManager as any,
      panelManager as any,
      "panel-1",
      "panel",
      "getCdpEndpoint",
      ["browser-1"],
    );
    expect(cdpServer.getCdpEndpoint).toHaveBeenCalledWith(
      "browser-1",
      "panel-1",
    );
    expect(result).toBe("ws://127.0.0.1:9222");
  });

  it("navigate checks ownership, calls wc.loadURL, ignores ERR_ABORTED", async () => {
    await handleBrowserCall(
      cdpServer as any,
      viewManager as any,
      panelManager as any,
      "panel-1",
      "panel",
      "navigate",
      ["browser-1", "https://example.com"],
    );
    expect(cdpServer.panelOwnsBrowser).toHaveBeenCalledWith(
      "panel-1",
      "browser-1",
    );
    expect(mockWc.loadURL).toHaveBeenCalledWith("https://example.com");

    // ERR_ABORTED should be silently ignored
    mockWc.loadURL.mockRejectedValue({ code: "ERR_ABORTED" });
    await expect(
      handleBrowserCall(
        cdpServer as any,
        viewManager as any,
        panelManager as any,
        "panel-1",
        "panel",
        "navigate",
        ["browser-1", "https://example.com"],
      ),
    ).resolves.toBeUndefined();
  });

  it("navigate throws when caller does not own browser", async () => {
    cdpServer.panelOwnsBrowser.mockReturnValue(false);
    await expect(
      handleBrowserCall(
        cdpServer as any,
        viewManager as any,
        panelManager as any,
        "panel-1",
        "panel",
        "navigate",
        ["browser-1", "https://example.com"],
      ),
    ).rejects.toThrow("Access denied");
  });

  it("goBack checks ownership and delegates to panelManager", async () => {
    await handleBrowserCall(
      cdpServer as any,
      viewManager as any,
      panelManager as any,
      "panel-1",
      "panel",
      "goBack",
      ["browser-1"],
    );
    expect(cdpServer.panelOwnsBrowser).toHaveBeenCalledWith(
      "panel-1",
      "browser-1",
    );
    expect(panelManager.goBack).toHaveBeenCalledWith("browser-1");
  });

  it("goForward checks ownership and delegates to panelManager", async () => {
    await handleBrowserCall(
      cdpServer as any,
      viewManager as any,
      panelManager as any,
      "panel-1",
      "panel",
      "goForward",
      ["browser-1"],
    );
    expect(cdpServer.panelOwnsBrowser).toHaveBeenCalledWith(
      "panel-1",
      "browser-1",
    );
    expect(panelManager.goForward).toHaveBeenCalledWith("browser-1");
  });

  it("throws on unknown method", async () => {
    await expect(
      handleBrowserCall(
        cdpServer as any,
        viewManager as any,
        panelManager as any,
        "panel-1",
        "panel",
        "unknownMethod",
        ["browser-1"],
      ),
    ).rejects.toThrow("Unknown browser method: unknownMethod");
  });
});
