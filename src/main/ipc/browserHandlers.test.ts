import { createVerifiedCaller } from "@natstack/shared/serviceDispatcher";
/**
 * Tests for browser service.
 */

import { getCdpEndpointForCaller, createBrowserService } from "../services/browserService.js";
import type { ServiceContext } from "@natstack/shared/serviceDispatcher";
import type { CdpServer } from "../cdpServer.js";
import type { ViewManager } from "../viewManager.js";
import type { PanelRegistry } from "@natstack/shared/panelRegistry";

describe("getCdpEndpointForCaller", () => {
  it("returns endpoint when cdpServer.getCdpEndpoint succeeds", () => {
    const endpoint = { wsEndpoint: "ws://127.0.0.1:9222", token: "token" };
    const cdpServer = {
      getCdpEndpoint: vi.fn().mockReturnValue(endpoint),
    };
    const result = getCdpEndpointForCaller(
      cdpServer as unknown as CdpServer,
      "browser-1",
      "panel-1"
    );
    expect(cdpServer.getCdpEndpoint).toHaveBeenCalledWith("browser-1", "panel-1");
    expect(result).toEqual(endpoint);
  });

  it("throws when cdpServer returns null", () => {
    const cdpServer = {
      getCdpEndpoint: vi.fn().mockReturnValue(null),
    };
    expect(() =>
      getCdpEndpointForCaller(cdpServer as unknown as CdpServer, "browser-1", "panel-1")
    ).toThrow("Access denied: you do not own this browser panel");
  });
});

describe("browserService handler", () => {
  const endpoint = { wsEndpoint: "ws://127.0.0.1:9222", token: "token" };
  const cdpServer = {
    getCdpEndpoint: vi.fn().mockReturnValue(endpoint),
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
  const panelRegistry = {};

  const svc = createBrowserService({
    cdpServer: cdpServer as unknown as CdpServer,
    getViewManager: () => viewManager as unknown as ViewManager,
    panelRegistry: panelRegistry as unknown as PanelRegistry,
  });
  const handler = svc.handler;
  const ctx: ServiceContext = { caller: createVerifiedCaller("panel-1", "panel") };

  beforeEach(() => {
    vi.clearAllMocks();
    cdpServer.panelOwnsBrowser.mockReturnValue(true);
    cdpServer.getCdpEndpoint.mockReturnValue(endpoint);
    viewManager.getWebContents.mockReturnValue(mockWc);
    mockWc.loadURL.mockResolvedValue(undefined);
  });

  it("allows app principals to use the browser service surface", () => {
    expect(svc.policy.allowed).toContain("app");
  });

  it("getCdpEndpoint delegates correctly", async () => {
    const result = await handler(ctx, "getCdpEndpoint", ["browser-1"]);
    expect(cdpServer.getCdpEndpoint).toHaveBeenCalledWith("browser-1", "panel-1");
    expect(result).toEqual(endpoint);
  });

  it("navigate checks ownership, calls wc.loadURL, ignores ERR_ABORTED", async () => {
    await handler(ctx, "navigate", ["browser-1", "https://example.com"]);
    expect(cdpServer.panelOwnsBrowser).toHaveBeenCalledWith("panel-1", "browser-1");
    expect(mockWc.loadURL).toHaveBeenCalledWith("https://example.com");

    // ERR_ABORTED should be silently ignored
    mockWc.loadURL.mockRejectedValue({ code: "ERR_ABORTED" });
    await expect(
      handler(ctx, "navigate", ["browser-1", "https://example.com"])
    ).resolves.toBeUndefined();
  });

  it("navigate throws when caller does not own browser", async () => {
    cdpServer.panelOwnsBrowser.mockReturnValue(false);
    await expect(handler(ctx, "navigate", ["browser-1", "https://example.com"])).rejects.toThrow(
      "Access denied"
    );
  });

  describe("navigate URL scheme allow-list", () => {
    it("allows https:// URLs", async () => {
      await expect(
        handler(ctx, "navigate", ["browser-1", "https://example.com"])
      ).resolves.toBeUndefined();
      expect(mockWc.loadURL).toHaveBeenCalledWith("https://example.com");
    });

    it("allows http:// URLs", async () => {
      await expect(
        handler(ctx, "navigate", ["browser-1", "http://example.com"])
      ).resolves.toBeUndefined();
      expect(mockWc.loadURL).toHaveBeenCalledWith("http://example.com");
    });

    it("rejects file:// URLs", async () => {
      await expect(handler(ctx, "navigate", ["browser-1", "file:///etc/passwd"])).rejects.toThrow(
        "only http and https are allowed"
      );
      expect(mockWc.loadURL).not.toHaveBeenCalled();
    });

    it("rejects javascript: URLs", async () => {
      await expect(handler(ctx, "navigate", ["browser-1", "javascript:alert(1)"])).rejects.toThrow(
        "only http and https are allowed"
      );
      expect(mockWc.loadURL).not.toHaveBeenCalled();
    });

    it("rejects javascript: URLs case-insensitively", async () => {
      await expect(handler(ctx, "navigate", ["browser-1", "JavaScript:alert(1)"])).rejects.toThrow(
        "only http and https are allowed"
      );
      expect(mockWc.loadURL).not.toHaveBeenCalled();
    });

    it("rejects empty string", async () => {
      await expect(handler(ctx, "navigate", ["browser-1", ""])).rejects.toThrow(
        "only http and https are allowed"
      );
      expect(mockWc.loadURL).not.toHaveBeenCalled();
    });

    it("rejects chrome:// URLs", async () => {
      await expect(handler(ctx, "navigate", ["browser-1", "chrome://settings"])).rejects.toThrow(
        "only http and https are allowed"
      );
      expect(mockWc.loadURL).not.toHaveBeenCalled();
    });

    it("rejects data: URLs", async () => {
      await expect(
        handler(ctx, "navigate", ["browser-1", "data:text/html,<h1>hi</h1>"])
      ).rejects.toThrow("only http and https are allowed");
      expect(mockWc.loadURL).not.toHaveBeenCalled();
    });
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
      "Unknown browser method: unknownMethod"
    );
  });
});
