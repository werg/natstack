import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { PanelView } from "./panelView.js";

function makePanelView(appPreloadPath?: string): PanelView {
  return new PanelView({
    viewManager: {
      hasView: vi.fn(() => false),
      getViewUrl: vi.fn(() => null),
      navigateView: vi.fn(async () => undefined),
      updateAppView: vi.fn(async () => undefined),
      createView: vi.fn(() => {
        throw new Error("createView should not be called");
      }),
    },
    panelRegistry: { findParentId: vi.fn(() => null) },
    serverInfo: { gatewayPort: 1234, externalHost: "127.0.0.1" },
    cdpServer: {
      registerBrowser: vi.fn(),
      unregisterBrowser: vi.fn(),
      cleanupPanelAccess: vi.fn(),
    },
    panelOrchestrator: {},
    appPreloadPath,
  } as never);
}

describe("PanelView app views", () => {
  it("fails closed instead of falling back to the panel preload", async () => {
    const panelView = makePanelView();

    await expect(
      panelView.createViewForApp("@workspace-apps/shell", "http://127.0.0.1:1234/_a/app/index.html")
    ).rejects.toThrow("App preload is required for privileged app views");
  });

  it("creates panel-hosting app views as full-window host chrome", async () => {
    const viewManager = {
      hasView: vi.fn(() => false),
      getViewUrl: vi.fn(() => null),
      navigateView: vi.fn(async () => undefined),
      updateAppView: vi.fn(async () => undefined),
      createView: vi.fn(() => ({
        webContents: {
          id: 10,
          on: vi.fn(),
          once: vi.fn(),
          off: vi.fn(),
          setWindowOpenHandler: vi.fn(),
        },
      })),
    };
    const panelView = new PanelView({
      viewManager,
      panelRegistry: { findParentId: vi.fn(() => null) },
      serverInfo: { gatewayPort: 1234, externalHost: "127.0.0.1" },
      cdpServer: {
        registerBrowser: vi.fn(),
        unregisterBrowser: vi.fn(),
        cleanupPanelAccess: vi.fn(),
      },
      panelOrchestrator: {},
      appPreloadPath: "/app-preload.js",
    } as never);

    await panelView.createViewForApp(
      "@workspace-apps/shell",
      "http://127.0.0.1:1234/_a/app/index.html",
      undefined,
      ["panel-hosting"]
    );

    expect(viewManager.createView).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "@workspace-apps/shell",
        type: "app",
        hostChrome: true,
      })
    );
  });

  it("updates existing app view metadata when loading a new app build", async () => {
    const viewManager = {
      hasView: vi.fn(() => true),
      getViewUrl: vi.fn(() => "http://127.0.0.1:1234/_a/old/index.html"),
      navigateView: vi.fn(async () => undefined),
      updateAppView: vi.fn(async () => undefined),
      createView: vi.fn(),
    };
    const panelView = new PanelView({
      viewManager,
      panelRegistry: { findParentId: vi.fn(() => null) },
      serverInfo: { gatewayPort: 1234, externalHost: "127.0.0.1" },
      cdpServer: {
        registerBrowser: vi.fn(),
        unregisterBrowser: vi.fn(),
        cleanupPanelAccess: vi.fn(),
      },
      panelOrchestrator: {},
      appPreloadPath: "/app-preload.js",
    } as never);

    await panelView.createViewForApp(
      "@workspace-apps/shell",
      "http://127.0.0.1:1234/_a/new/index.html",
      undefined,
      ["notifications"],
      { source: "apps/shell", effectiveVersion: "ev-new" }
    );

    expect(viewManager.updateAppView).toHaveBeenCalledWith(
      "@workspace-apps/shell",
      "http://127.0.0.1:1234/_a/new/index.html",
      ["notifications"],
      { source: "apps/shell", effectiveVersion: "ev-new" }
    );
    expect(viewManager.navigateView).not.toHaveBeenCalled();
    expect(viewManager.createView).not.toHaveBeenCalled();
  });

  it("retries transient main-frame load failures for app views", async () => {
    vi.useFakeTimers();
    const url = "https://server.example/_workspace/dev/_a/app/index.html";
    const loadURL = vi.fn(async () => undefined);
    const webContents = Object.assign(new EventEmitter(), {
      id: 10,
      isDestroyed: vi.fn(() => false),
      getURL: vi.fn(() => url),
      canGoBack: vi.fn(() => false),
      canGoForward: vi.fn(() => false),
      loadURL,
      setWindowOpenHandler: vi.fn(),
    });
    const viewManager = {
      hasView: vi.fn(() => false),
      getViewUrl: vi.fn(() => null),
      navigateView: vi.fn(async () => undefined),
      updateAppView: vi.fn(async () => undefined),
      createView: vi.fn(() => ({ webContents })),
      getWebContents: vi.fn(() => webContents),
    };
    const panelView = new PanelView({
      viewManager,
      panelRegistry: {
        findParentId: vi.fn(() => null),
        getPanel: vi.fn(() => null),
      },
      serverInfo: { gatewayPort: 1234, externalHost: "server.example" },
      cdpHost: {
        registerTarget: vi.fn(),
        unregisterTarget: vi.fn(),
        cleanupPanelAccess: vi.fn(),
      },
      panelOrchestrator: {},
      appPreloadPath: "/app-preload.js",
    } as never);

    await panelView.createViewForApp("@workspace-apps/shell", url, undefined, ["panel-hosting"]);
    webContents.emit("did-fail-load", {}, -21, "ERR_NETWORK_CHANGED", url, true);
    await vi.advanceTimersByTimeAsync(500);

    expect(loadURL).toHaveBeenCalledWith(url);
    vi.useRealTimers();
  });
});
