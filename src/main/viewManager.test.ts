/**
 * ViewManager Unit Tests
 *
 * These tests use mocked Electron APIs to verify ViewManager logic.
 * For integration testing with real Electron, use Playwright or Spectron.
 *
 * Run with: npx vitest run src/main/viewManager.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";

// Mock Electron modules before importing ViewManager
vi.mock("electron", () => {
  // Create a fresh webContents mock for each view
  const createMockWebContents = () => ({
    id: Math.random(),
    loadFile: vi.fn().mockResolvedValue(undefined),
    loadURL: vi.fn().mockResolvedValue(undefined),
    openDevTools: vi.fn(),
    isDestroyed: vi.fn().mockReturnValue(false),
    getURL: vi.fn().mockReturnValue(""),
    getTitle: vi.fn().mockReturnValue("Mock Title"),
    isLoading: vi.fn().mockReturnValue(false),
    getOSProcessId: vi.fn().mockReturnValue(1234),
    canGoBack: vi.fn().mockReturnValue(false),
    canGoForward: vi.fn().mockReturnValue(false),
    goBack: vi.fn(),
    goForward: vi.fn(),
    reload: vi.fn(),
    stop: vi.fn(),
    close: vi.fn(),
    focus: vi.fn(),
    send: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    once: vi.fn(),
    insertCSS: vi.fn().mockResolvedValue("css-key"),
    removeInsertedCSS: vi.fn().mockResolvedValue(undefined),
    capturePage: vi.fn().mockResolvedValue({
      isEmpty: () => false,
      getSize: () => ({ width: 100, height: 100 }),
    }),
    invalidate: vi.fn(),
    executeJavaScript: vi.fn().mockResolvedValue(undefined),
    setBackgroundThrottling: vi.fn(),
  });

  const createMockWebContentsView = () => ({
    webContents: createMockWebContents(),
    setBounds: vi.fn(),
    setVisible: vi.fn(),
    setBackgroundColor: vi.fn(),
    getBounds: vi.fn().mockReturnValue({ x: 0, y: 0, width: 100, height: 100 }),
  });

  const children: unknown[] = [];
  const mockContentView = {
    children,
    addChildView: vi.fn((view: unknown) => {
      const index = children.indexOf(view);
      if (index !== -1) children.splice(index, 1);
      children.push(view);
    }),
    removeChildView: vi.fn((view: unknown) => {
      const index = children.indexOf(view);
      if (index !== -1) children.splice(index, 1);
    }),
  };

  const mockBaseWindow = {
    contentView: mockContentView,
    getContentSize: vi.fn().mockReturnValue([1200, 800]),
    isDestroyed: vi.fn().mockReturnValue(false),
    isVisible: vi.fn().mockReturnValue(true),
    on: vi.fn(),
  };

  const mockSession = {
    protocol: {
      handle: vi.fn(),
    },
  };

  return {
    app: {
      getAppMetrics: vi.fn(() => [
        {
          pid: 1234,
          type: "Tab",
          memory: { workingSetSize: 20480 },
          cpu: { percentCPUUsage: 1.25 },
        },
      ]),
    },
    BaseWindow: vi.fn(() => mockBaseWindow),
    WebContentsView: vi.fn(createMockWebContentsView),
    ipcMain: {
      on: vi.fn(),
      removeListener: vi.fn(),
    },
    session: {
      fromPartition: vi.fn(() => mockSession),
      defaultSession: mockSession,
    },
  };
});

// Import after mocks are set up
import { ViewManager } from "./viewManager.js";
import { BaseWindow, WebContentsView } from "electron";

type MockBaseWindow = InstanceType<typeof BaseWindow>;

describe("ViewManager", () => {
  let mockWindow: MockBaseWindow;

  beforeEach(() => {
    vi.clearAllMocks();

    mockWindow = new BaseWindow();
  });

  describe("initialization", () => {
    it("creates shell view on construction", () => {
      const vm = new ViewManager({
        window: mockWindow,
        shellPreload: "/path/to/preload.js",
        shellHtmlPath: "/path/to/index.html",
      });

      expect(WebContentsView).toHaveBeenCalled();
      expect(mockWindow.contentView.addChildView).toHaveBeenCalled();
      expect(vm.hasView("shell")).toBe(true);
    });

    it("opens devtools when devTools option is true", () => {
      const vm = new ViewManager({
        window: mockWindow,
        shellPreload: "/path/to/preload.js",
        shellHtmlPath: "/path/to/index.html",
        devTools: true,
      });

      const shellContents = vm.getShellWebContents();
      expect(shellContents.openDevTools).toHaveBeenCalled();
    });
  });

  describe("createView", () => {
    let vm: ViewManager;

    beforeEach(() => {
      vm = new ViewManager({
        window: mockWindow,
        shellPreload: "/path/to/preload.js",
        shellHtmlPath: "/path/to/index.html",
      });
    });

    it("creates a panel view via path-based HTTP URL", () => {
      const view = vm.createView({
        id: "test-panel",
        type: "panel",
        preload: null,
        url: "http://localhost:9100/panels/test-panel/?state=abc",
      });

      expect(view).toBeDefined();
      expect(vm.hasView("test-panel")).toBe(true);
    });

    it("tracks views by webContents id without scanning", () => {
      const view = vm.createView({
        id: "test-panel",
        type: "panel",
      });

      expect(vm.findViewIdByWebContentsId(view.webContents.id)).toBe("test-panel");

      vm.destroyView("test-panel");

      expect(vm.findViewIdByWebContentsId(view.webContents.id)).toBeNull();
    });

    it("creates a browser view with default session", () => {
      const view = vm.createView({
        id: "test-browser",
        type: "panel",
        preload: null,
        url: "https://example.com",
      });

      expect(view).toBeDefined();
      expect(vm.hasView("test-browser")).toBe(true);
    });

    it("throws when creating duplicate view", () => {
      vm.createView({
        id: "test-view",
        type: "panel",
        preload: null,
        url: "http://localhost:9100/panels/test-view/",
      });

      expect(() => {
        vm.createView({
          id: "test-view",
          type: "panel",
          preload: null,
          url: "http://localhost:9100/panels/test-view/",
        });
      }).toThrow("View already exists: test-view");
    });
  });

  describe("native shell overlays", () => {
    it("creates a bounded overlay view above panel views", () => {
      const vm = new ViewManager({
        window: mockWindow,
        shellPreload: "/path/to/preload.js",
        shellOverlayPreload: "/path/to/shellOverlayPreload.js",
        shellHtmlPath: "/path/to/index.html",
      });
      const panelView = vm.createView({ id: "panel-1", type: "panel" });

      vm.setViewVisible("panel-1", true);
      vm.showNativeShellOverlay({
        id: "menu-1",
        html: "<!doctype html><button>Menu</button>",
        bounds: { x: 20, y: 40, width: 240, height: 180 },
      });

      const results = (WebContentsView as unknown as Mock).mock.results;
      const overlayView = results[results.length - 1]?.value;
      expect(overlayView).toBeTruthy();
      expect(overlayView.setBounds).toHaveBeenCalledWith({ x: 20, y: 40, width: 240, height: 180 });
      expect(overlayView.setVisible).toHaveBeenCalledWith(true);
      expect(overlayView.webContents.loadURL).toHaveBeenCalledWith(
        expect.stringContaining("data:text/html")
      );
      const loadedUrl = overlayView.webContents.loadURL.mock.calls[0]?.[0] as string;
      const overlayHtml = decodeURIComponent(loadedUrl.slice(loadedUrl.indexOf(",") + 1));
      expect(overlayHtml).toContain("Content-Security-Policy");
      expect(overlayHtml).toContain("script-src 'none'");
      expect(mockWindow.contentView.removeChildView).toHaveBeenCalledWith(overlayView);
      expect(mockWindow.contentView.addChildView).toHaveBeenCalledWith(overlayView);
      expect(panelView.setVisible).toHaveBeenCalledWith(true);
    });
  });

  describe("native panel slots", () => {
    let vm: ViewManager;

    beforeEach(() => {
      vm = new ViewManager({
        window: mockWindow,
        shellPreload: "/path/to/preload.js",
        shellHtmlPath: "/path/to/index.html",
      });
    });

    it("binds a panel slot with measured bounds and focus", () => {
      const hostView = vm.createView({
        id: "@workspace-apps/shell",
        type: "app",
        hostChrome: true,
        appCapabilities: ["panel-hosting"],
      });
      const panelView = vm.createView({ id: "panel-1", type: "panel" });

      vm.setHostedShellReady("@workspace-apps/shell", true);
      vm.bindPanelSlot("@workspace-apps/shell", {
        nativeSlotId: "panel-stack:primary",
        panelId: "panel-1",
        bounds: { x: 11.4, y: 23.6, width: 500.2, height: 300.8 },
        focused: true,
      });

      expect(hostView.setVisible).toHaveBeenCalledWith(true);
      expect(panelView.setBounds).toHaveBeenLastCalledWith({
        x: 11,
        y: 24,
        width: 500,
        height: 301,
      });
      expect(panelView.setVisible).toHaveBeenCalledWith(true);
      expect(panelView.webContents.focus).toHaveBeenCalled();
      expect(vm.isPanelSlotted("panel-1")).toBe(true);
    });

    it("updates and clears a panel slot", () => {
      const panelView = vm.createView({ id: "panel-1", type: "panel" });
      vm.createView({
        id: "@workspace-apps/shell",
        type: "app",
        hostChrome: true,
        appCapabilities: ["panel-hosting"],
      });

      vm.setHostedShellReady("@workspace-apps/shell", true);
      vm.bindPanelSlot("@workspace-apps/shell", {
        nativeSlotId: "panel-stack:primary",
        panelId: "panel-1",
        bounds: { x: 10, y: 20, width: 300, height: 200 },
      });
      expect(
        vm.updatePanelSlot("@workspace-apps/shell", {
          nativeSlotId: "panel-stack:primary",
          bounds: { x: 12, y: 24, width: 320, height: 220 },
        })
      ).toEqual({ status: "updated" });

      expect(panelView.setBounds).toHaveBeenLastCalledWith({
        x: 12,
        y: 24,
        width: 320,
        height: 220,
      });

      vm.clearPanelSlot("@workspace-apps/shell", "panel-stack:primary");

      expect(panelView.setVisible).toHaveBeenLastCalledWith(false);
      expect(vm.isPanelSlotted("panel-1")).toBe(false);
    });

    it("reports missing slots so the hosted shell can rebind", () => {
      vm.createView({
        id: "@workspace-apps/shell",
        type: "app",
        hostChrome: true,
        appCapabilities: ["panel-hosting"],
      });

      vm.setHostedShellReady("@workspace-apps/shell", true);

      expect(
        vm.updatePanelSlot("@workspace-apps/shell", {
          nativeSlotId: "panel-stack:primary",
          bounds: { x: 12, y: 24, width: 320, height: 220 },
        })
      ).toEqual({
        status: "missing",
        reason: "unknown native panel slot: panel-stack:primary",
      });
    });

    it("reasserts active slot surfaces when a hidden window is shown again", () => {
      const panelView = vm.createView({ id: "panel-1", type: "panel" });
      vm.createView({
        id: "@workspace-apps/shell",
        type: "app",
        hostChrome: true,
        appCapabilities: ["panel-hosting"],
      });

      vm.setHostedShellReady("@workspace-apps/shell", true);
      vm.bindPanelSlot("@workspace-apps/shell", {
        nativeSlotId: "panel-stack:primary",
        panelId: "panel-1",
        bounds: { x: 10, y: 20, width: 300, height: 200 },
      });

      (panelView.setBounds as Mock).mockClear();
      (panelView.setVisible as Mock).mockClear();
      const showHandler = (mockWindow.on as Mock).mock.calls.find(
        (call: unknown[]) => call[0] === "show"
      )?.[1] as (() => void) | undefined;
      expect(showHandler).toBeDefined();
      showHandler?.();

      expect(panelView.setBounds).toHaveBeenLastCalledWith({
        x: 10,
        y: 20,
        width: 300,
        height: 200,
      });
      expect(panelView.setVisible).toHaveBeenLastCalledWith(true);
    });

    it("reasserts active slot visibility when shell overlay state changes", () => {
      const panelView = vm.createView({ id: "panel-1", type: "panel" });
      vm.createView({
        id: "@workspace-apps/shell",
        type: "app",
        hostChrome: true,
        appCapabilities: ["panel-hosting"],
      });

      vm.setHostedShellReady("@workspace-apps/shell", true);
      vm.bindPanelSlot("@workspace-apps/shell", {
        nativeSlotId: "panel-stack:primary",
        panelId: "panel-1",
        bounds: { x: 10, y: 20, width: 300, height: 200 },
      });

      vm.setShellOverlayActive(true);
      expect(panelView.setVisible).toHaveBeenLastCalledWith(false);
      vm.setShellOverlayActive(false);
      expect(panelView.setBounds).toHaveBeenLastCalledWith({
        x: 10,
        y: 20,
        width: 300,
        height: 200,
      });
      expect(panelView.setVisible).toHaveBeenLastCalledWith(true);
    });

    it("rejects binding one panel to two native slots", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      vm.createView({ id: "panel-1", type: "panel" });
      vm.createView({
        id: "@workspace-apps/shell",
        type: "app",
        hostChrome: true,
        appCapabilities: ["panel-hosting"],
      });

      vm.setHostedShellReady("@workspace-apps/shell", true);
      vm.bindPanelSlot("@workspace-apps/shell", {
        nativeSlotId: "slot-a",
        panelId: "panel-1",
        bounds: { x: 0, y: 0, width: 100, height: 100 },
      });

      expect(() =>
        vm.bindPanelSlot("@workspace-apps/shell", {
          nativeSlotId: "slot-b",
          panelId: "panel-1",
          bounds: { x: 0, y: 0, width: 100, height: 100 },
        })
      ).toThrow(/already bound/);
      warnSpy.mockRestore();
    });

    it("hosted shell not-ready clears active slots", () => {
      const panelView = vm.createView({ id: "panel-1", type: "panel" });
      const hostView = vm.createView({
        id: "@workspace-apps/shell",
        type: "app",
        hostChrome: true,
        appCapabilities: ["panel-hosting"],
      });

      vm.setHostedShellReady("@workspace-apps/shell", true);
      vm.bindPanelSlot("@workspace-apps/shell", {
        nativeSlotId: "panel-stack:primary",
        panelId: "panel-1",
        bounds: { x: 0, y: 0, width: 100, height: 100 },
      });
      vm.setHostedShellReady("@workspace-apps/shell", false);

      expect(panelView.setVisible).toHaveBeenLastCalledWith(false);
      expect(hostView.setVisible).toHaveBeenLastCalledWith(false);
      expect(vm.isPanelSlotted("panel-1")).toBe(false);
      expect(vm.getVisibleHostChromeAppId()).toBeNull();
    });

    it("keeps active slots when the hosted shell reasserts readiness", () => {
      const panelView = vm.createView({ id: "panel-1", type: "panel" });
      vm.createView({
        id: "@workspace-apps/shell",
        type: "app",
        hostChrome: true,
        appCapabilities: ["panel-hosting"],
      });

      vm.setHostedShellReady("@workspace-apps/shell", true);
      vm.bindPanelSlot("@workspace-apps/shell", {
        nativeSlotId: "panel-stack:primary",
        panelId: "panel-1",
        bounds: { x: 10, y: 20, width: 300, height: 200 },
      });

      (panelView.setVisible as Mock).mockClear();
      vm.setHostedShellReady("@workspace-apps/shell", true);

      expect(vm.isPanelSlotted("panel-1")).toBe(true);
      expect(panelView.setVisible).toHaveBeenLastCalledWith(true);
    });

    it("restacks slotted panels above the hosted shell when it is re-shown", () => {
      const panelView = vm.createView({ id: "panel-1", type: "panel" });
      const hostView = vm.createView({
        id: "@workspace-apps/shell",
        type: "app",
        hostChrome: true,
        appCapabilities: ["panel-hosting"],
      });

      vm.setHostedShellReady("@workspace-apps/shell", true);
      vm.bindPanelSlot("@workspace-apps/shell", {
        nativeSlotId: "panel-stack:primary",
        panelId: "panel-1",
        bounds: { x: 10, y: 20, width: 300, height: 200 },
      });

      // Late app-update mount re-shows the hosted shell (bringToFront).
      vm.setViewVisible("@workspace-apps/shell", true);

      const children = mockWindow.contentView.children as unknown[];
      expect(children.indexOf(panelView)).toBeGreaterThan(children.indexOf(hostView));
    });

    it("keepalive restacks a slotted panel occluded by the hosted shell", () => {
      vi.useFakeTimers();
      try {
        const localVm = new ViewManager({
          window: mockWindow,
          shellPreload: "/path/to/preload.js",
          shellHtmlPath: "/path/to/index.html",
        });
        const panelView = localVm.createView({ id: "panel-1", type: "panel" });
        const hostView = localVm.createView({
          id: "@workspace-apps/shell",
          type: "app",
          hostChrome: true,
          appCapabilities: ["panel-hosting"],
        });

        localVm.setHostedShellReady("@workspace-apps/shell", true);
        localVm.bindPanelSlot("@workspace-apps/shell", {
          nativeSlotId: "panel-stack:primary",
          panelId: "panel-1",
          bounds: { x: 10, y: 20, width: 300, height: 200 },
        });

        // Simulate something stacking the shell above the slotted panel.
        localVm.bringToFront("@workspace-apps/shell");
        const children = mockWindow.contentView.children as unknown[];
        expect(children.indexOf(panelView)).toBeLessThan(children.indexOf(hostView));

        vi.advanceTimersByTime(5000);

        expect(children.indexOf(panelView)).toBeGreaterThan(children.indexOf(hostView));
      } finally {
        vi.useRealTimers();
      }
    });

    it("restores the slot binding when a panel view is recreated", () => {
      vm.createView({ id: "panel-1", type: "panel" });
      vm.createView({
        id: "@workspace-apps/shell",
        type: "app",
        hostChrome: true,
        appCapabilities: ["panel-hosting"],
      });

      vm.setHostedShellReady("@workspace-apps/shell", true);
      vm.bindPanelSlot("@workspace-apps/shell", {
        nativeSlotId: "panel-stack:primary",
        panelId: "panel-1",
        bounds: { x: 10, y: 20, width: 300, height: 200 },
        focused: true,
      });

      vm.destroyView("panel-1");
      expect(vm.isPanelSlotted("panel-1")).toBe(false);

      const recreated = vm.createView({ id: "panel-1", type: "panel" });

      expect(vm.isPanelSlotted("panel-1")).toBe(true);
      expect(recreated.setBounds).toHaveBeenLastCalledWith({
        x: 10,
        y: 20,
        width: 300,
        height: 200,
      });
      expect(recreated.setVisible).toHaveBeenLastCalledWith(true);
      expect(recreated.webContents.focus).toHaveBeenCalled();
    });

    it("does not restore a slot the shell explicitly cleared", () => {
      vm.createView({ id: "panel-1", type: "panel" });
      vm.createView({
        id: "@workspace-apps/shell",
        type: "app",
        hostChrome: true,
        appCapabilities: ["panel-hosting"],
      });

      vm.setHostedShellReady("@workspace-apps/shell", true);
      vm.bindPanelSlot("@workspace-apps/shell", {
        nativeSlotId: "panel-stack:primary",
        panelId: "panel-1",
        bounds: { x: 10, y: 20, width: 300, height: 200 },
      });

      vm.destroyView("panel-1");
      vm.clearPanelSlot("@workspace-apps/shell", "panel-stack:primary");

      const recreated = vm.createView({ id: "panel-1", type: "panel" });

      expect(vm.isPanelSlotted("panel-1")).toBe(false);
      expect(recreated.setVisible).not.toHaveBeenCalledWith(true);
    });

    it("does not restore a slot across a hosted shell generation change", () => {
      vm.createView({ id: "panel-1", type: "panel" });
      vm.createView({
        id: "@workspace-apps/shell",
        type: "app",
        hostChrome: true,
        appCapabilities: ["panel-hosting"],
      });

      vm.setHostedShellReady("@workspace-apps/shell", true);
      vm.bindPanelSlot("@workspace-apps/shell", {
        nativeSlotId: "panel-stack:primary",
        panelId: "panel-1",
        bounds: { x: 10, y: 20, width: 300, height: 200 },
      });

      vm.destroyView("panel-1");
      vm.setHostedShellReady("@workspace-apps/shell", false);
      vm.setHostedShellReady("@workspace-apps/shell", true);

      const recreated = vm.createView({ id: "panel-1", type: "panel" });

      expect(vm.isPanelSlotted("panel-1")).toBe(false);
      expect(recreated.setVisible).not.toHaveBeenCalledWith(true);
    });

    it("captures display diagnostics for slotted panels", async () => {
      const panelView = vm.createView({ id: "panel-1", type: "panel" });
      const hostView = vm.createView({
        id: "@workspace-apps/shell",
        type: "app",
        hostChrome: true,
        appCapabilities: ["panel-hosting"],
      });
      (hostView.webContents.executeJavaScript as Mock).mockResolvedValue([
        {
          nativeSlotId: "panel-stack:primary",
          panelId: "panel-1",
          bounds: { x: 10, y: 20, width: 300, height: 200 },
        },
      ]);

      vm.setHostedShellReady("@workspace-apps/shell", true);
      vm.bindPanelSlot("@workspace-apps/shell", {
        nativeSlotId: "panel-stack:primary",
        panelId: "panel-1",
        bounds: { x: 10, y: 20, width: 300, height: 200 },
        focused: true,
      });

      const diagnostics = await vm.getPanelDisplayDiagnostics();

      expect(diagnostics.nativePanelSlots.slots).toEqual([
        expect.objectContaining({
          nativeSlotId: "panel-stack:primary",
          panelId: "panel-1",
          focused: true,
        }),
      ]);
      expect(diagnostics.hostedShellSurfaces).toEqual([
        {
          nativeSlotId: "panel-stack:primary",
          panelId: "panel-1",
          bounds: { x: 10, y: 20, width: 300, height: 200 },
        },
      ]);
      expect(diagnostics.views).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "panel-1",
            managedVisible: true,
            webContents: expect.objectContaining({ osProcessId: 1234, memoryMb: 20 }),
          }),
        ])
      );
      expect(diagnostics.captures).toEqual([
        {
          id: "panel-1",
          ok: true,
          empty: false,
          size: { width: 100, height: 100 },
        },
      ]);
      expect(panelView.webContents.capturePage).toHaveBeenCalled();
    });
  });

  describe("view lifecycle", () => {
    let vm: ViewManager;

    beforeEach(() => {
      vm = new ViewManager({
        window: mockWindow,
        shellPreload: "/path/to/preload.js",
        shellHtmlPath: "/path/to/index.html",
      });
    });

    it("destroyView removes view from window and map", () => {
      const view = vm.createView({
        id: "test-view",
        type: "panel",
      });

      expect(vm.hasView("test-view")).toBe(true);

      vm.destroyView("test-view");

      expect(vm.hasView("test-view")).toBe(false);
      expect(mockWindow.contentView.removeChildView).toHaveBeenCalledWith(view);
    });

    it("destroyView is safe to call on non-existent view", () => {
      expect(() => vm.destroyView("non-existent")).not.toThrow();
    });
  });

  describe("view bounds and visibility", () => {
    let vm: ViewManager;

    beforeEach(() => {
      vm = new ViewManager({
        window: mockWindow,
        shellPreload: "/path/to/preload.js",
        shellHtmlPath: "/path/to/index.html",
      });
    });

    it("setViewBounds updates view bounds", () => {
      const view = vm.createView({
        id: "test-view",
        type: "panel",
      });

      const bounds = { x: 100, y: 50, width: 400, height: 300 };
      vm.setViewBounds("test-view", bounds);

      expect(view.setBounds).toHaveBeenCalledWith(bounds);
    });

    it("uses reported panel viewport bounds over reconstructed shell chrome layout", () => {
      const view = vm.createView({
        id: "test-view",
        type: "panel",
      });

      vm.updateLayout({
        titleBarHeight: 32,
        sidebarVisible: true,
        sidebarWidth: 260,
        consentBarHeight: 0,
      });
      vm.setPanelViewportBounds({ x: 8.4, y: 164.6, width: 1180.2, height: 620.7 });
      vm.setViewVisible("test-view", true);

      expect(view.setBounds).toHaveBeenLastCalledWith({
        x: 8,
        y: 165,
        width: 1180,
        height: 621,
      });

      vm.updateLayout({ sidebarVisible: false, consentBarHeight: 0 });

      expect(view.setBounds).toHaveBeenLastCalledWith({
        x: 8,
        y: 165,
        width: 1180,
        height: 621,
      });
    });

    it("clamps stale reported panel viewport bounds below host chrome", () => {
      const view = vm.createView({
        id: "test-view",
        type: "panel",
      });

      vm.setPanelViewportBounds({ x: 248, y: 32, width: 952, height: 768 });
      vm.setViewVisible("test-view", true);
      vm.updateLayout({
        titleBarHeight: 32,
        notificationBarHeight: 0,
        saveBarHeight: 0,
        consentBarHeight: 130,
      });

      expect(view.setBounds).toHaveBeenLastCalledWith({
        x: 248,
        y: 162,
        width: 952,
        height: 638,
      });
    });

    it("falls back to chrome layout when no panel viewport bounds are reported", () => {
      const view = vm.createView({
        id: "test-view",
        type: "panel",
      });

      vm.setPanelViewportBounds({ x: 8, y: 164, width: 1180, height: 620 });
      vm.setPanelViewportBounds(null);
      vm.updateLayout({ sidebarVisible: true, sidebarWidth: 260, titleBarHeight: 32 });
      vm.setViewVisible("test-view", true);

      expect(view.setBounds).toHaveBeenLastCalledWith({
        x: 260,
        y: 32,
        width: 940,
        height: 768,
      });
    });

    it("setViewVisible shows and hides view", () => {
      const view = vm.createView({
        id: "test-view",
        type: "panel",
      });

      expect(vm.isViewVisible("test-view")).toBe(false);

      vm.setViewVisible("test-view", true);
      expect(view.setVisible).toHaveBeenCalledWith(true);
      expect(vm.isViewVisible("test-view")).toBe(true);

      vm.setViewVisible("test-view", false);
      expect(view.setVisible).toHaveBeenCalledWith(false);
      expect(vm.isViewVisible("test-view")).toBe(false);
    });

    it("keeps host chrome app views full-window and out of panel layout", () => {
      const hostView = vm.createView({
        id: "@workspace-apps/shell",
        type: "app",
        hostChrome: true,
        appCapabilities: ["panel-hosting"],
      });
      const panelView = vm.createView({
        id: "panel-1",
        type: "panel",
      });

      vm.setViewVisible("@workspace-apps/shell", true);
      vm.updateLayout({ sidebarVisible: true, sidebarWidth: 260, titleBarHeight: 32 });

      expect(hostView.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 1200, height: 800 });

      vm.setViewVisible("panel-1", true);
      vm.updateLayout({ sidebarVisible: true, sidebarWidth: 260, titleBarHeight: 32 });

      expect(hostView.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 1200, height: 800 });
      expect(panelView.setBounds).toHaveBeenLastCalledWith({
        x: 260,
        y: 32,
        width: 940,
        height: 768,
      });
    });

    it("opens devtools on the visible host chrome app instead of the bootstrap shell", () => {
      const hostView = vm.createView({
        id: "@workspace-apps/shell",
        type: "app",
        hostChrome: true,
        appCapabilities: ["panel-hosting"],
      });
      const shellContents = vm.getShellWebContents();

      expect(vm.openHostChromeAppDevTools()).toBe(false);

      vm.setViewVisible("@workspace-apps/shell", true);

      expect(vm.getVisibleHostChromeAppId()).toBe("@workspace-apps/shell");
      expect(vm.openHostChromeAppDevTools()).toBe(true);
      expect(hostView.webContents.openDevTools).toHaveBeenCalledWith({ mode: "detach" });
      expect(shellContents.openDevTools).not.toHaveBeenCalled();
    });

    it("ignores hiding a missing view", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      expect(() => vm.setViewVisible("missing-view", false)).not.toThrow();

      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it("warns when showing a missing view", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      vm.setViewVisible("missing-view", true);

      expect(warnSpy).toHaveBeenCalledWith("[ViewManager] View not found: missing-view");
      warnSpy.mockRestore();
    });
  });

  describe("getWebContents", () => {
    let vm: ViewManager;

    beforeEach(() => {
      vm = new ViewManager({
        window: mockWindow,
        shellPreload: "/path/to/preload.js",
        shellHtmlPath: "/path/to/index.html",
      });
    });

    it("returns webContents for existing view", () => {
      vm.createView({
        id: "test-view",
        type: "panel",
      });

      const contents = vm.getWebContents("test-view");
      expect(contents).toBeDefined();
    });

    it("returns null for non-existent view", () => {
      const contents = vm.getWebContents("non-existent");
      expect(contents).toBeNull();
    });

    it("returns null for destroyed webContents", () => {
      const view = vm.createView({
        id: "test-view",
        type: "panel",
      });

      (view.webContents.isDestroyed as Mock).mockReturnValue(true);

      const contents = vm.getWebContents("test-view");
      expect(contents).toBeNull();
    });
  });

  describe("navigation", () => {
    let vm: ViewManager;

    beforeEach(() => {
      vm = new ViewManager({
        window: mockWindow,
        shellPreload: "/path/to/preload.js",
        shellHtmlPath: "/path/to/index.html",
      });
    });

    it("navigateView loads URL", async () => {
      const view = vm.createView({
        id: "test-view",
        type: "panel",
        preload: null,
      });

      await vm.navigateView("test-view", "https://example.com");

      expect(view.webContents.loadURL).toHaveBeenCalledWith("https://example.com");
    });

    it("getViewUrl returns current URL", () => {
      const view = vm.createView({
        id: "test-view",
        type: "panel",
        preload: null,
      });

      (view.webContents.getURL as Mock).mockReturnValue("https://example.com");

      expect(vm.getViewUrl("test-view")).toBe("https://example.com");
    });

    it("navigation methods delegate to webContents", () => {
      const view = vm.createView({
        id: "test-view",
        type: "panel",
        preload: null,
      });

      (view.webContents.canGoBack as Mock).mockReturnValue(true);
      (view.webContents.canGoForward as Mock).mockReturnValue(true);

      expect(vm.canGoBack("test-view")).toBe(true);
      expect(vm.canGoForward("test-view")).toBe(true);

      vm.goBack("test-view");
      expect(view.webContents.goBack).toHaveBeenCalled();

      vm.goForward("test-view");
      expect(view.webContents.goForward).toHaveBeenCalled();

      vm.reload("test-view");
      expect(view.webContents.reload).toHaveBeenCalled();

      vm.stop("test-view");
      expect(view.webContents.stop).toHaveBeenCalled();
    });
  });

  describe("theme CSS", () => {
    let vm: ViewManager;

    beforeEach(() => {
      vm = new ViewManager({
        window: mockWindow,
        shellPreload: "/path/to/preload.js",
        shellHtmlPath: "/path/to/index.html",
      });
    });

    it("setThemeCss stores CSS for new views", () => {
      vm.setThemeCss(":root { --color: red; }");

      // Create a view after setting theme
      vm.createView({
        id: "test-view",
        type: "panel",
        injectHostThemeVariables: true,
      });

      // Theme will be applied on dom-ready event
      expect(vm.hasView("test-view")).toBe(true);
    });
  });

  describe("compositor visibility cycling", () => {
    let vm: ViewManager;

    beforeEach(() => {
      vm = new ViewManager({
        window: mockWindow,
        shellPreload: "/path/to/preload.js",
        shellHtmlPath: "/path/to/index.html",
      });
    });

    it("refreshVisiblePanel reasserts visible state without cycling visibility", () => {
      const view = vm.createView({
        id: "panel-1",
        type: "panel",
      });

      // Make it the visible panel
      vm.setViewVisible("panel-1", true);
      (view.setVisible as Mock).mockClear();

      vm.refreshVisiblePanel();

      // setVisible(true) is reasserted, but there is no false/true cycle.
      expect(view.setVisible).toHaveBeenCalledTimes(1);
      expect(view.setVisible).toHaveBeenCalledWith(true);
      // But bounds should have been refreshed
      expect(view.setBounds).toHaveBeenCalled();
    });

    it("forceRepaint cycles visibility for visible views", () => {
      const view = vm.createView({
        id: "panel-2",
        type: "panel",
      });

      vm.setViewVisible("panel-2", true);
      (view.setVisible as Mock).mockClear();
      (view.setBounds as Mock).mockClear();

      vm.forceRepaint("panel-2");

      // Should cycle visibility (first call passes cooldown)
      const visibleCalls = (view.setVisible as Mock).mock.calls;
      const falseIdx = visibleCalls.findIndex((c: unknown[]) => c[0] === false);
      const trueIdx = visibleCalls.findIndex(
        (c: unknown[], i: number) => i > falseIdx && c[0] === true
      );
      expect(falseIdx).toBeGreaterThanOrEqual(0);
      expect(trueIdx).toBeGreaterThan(falseIdx);
    });

    it("visibility cycle does not change tracked isViewVisible() state", () => {
      vm.createView({
        id: "panel-3",
        type: "panel",
      });

      vm.setViewVisible("panel-3", true);
      expect(vm.isViewVisible("panel-3")).toBe(true);

      vm.forceRepaint("panel-3");
      expect(vm.isViewVisible("panel-3")).toBe(true);
    });
  });

  describe("compositor keepalive", () => {
    let vm: ViewManager;

    beforeEach(() => {
      vi.useFakeTimers();
      vm = new ViewManager({
        window: mockWindow,
        shellPreload: "/path/to/preload.js",
        shellHtmlPath: "/path/to/index.html",
      });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("keepalive invalidates and re-applies bounds without stealing focus", () => {
      const view = vm.createView({
        id: "keepalive-panel",
        type: "panel",
      });

      vm.setViewVisible("keepalive-panel", true);
      (view.setVisible as Mock).mockClear();
      (view.setBounds as Mock).mockClear();
      (view.webContents.invalidate as Mock).mockClear();

      // Advance past the keepalive interval (5s)
      vi.advanceTimersByTime(5000);

      // Should have refreshed bounds and invalidated
      expect(view.setBounds).toHaveBeenCalled();
      expect(view.webContents.invalidate).toHaveBeenCalled();
      // Should NOT have cycled visibility (would steal focus)
      expect(view.setVisible).not.toHaveBeenCalled();
    });

    it("keepalive skips when no panel is visible", () => {
      // No panel made visible — keepalive should be a no-op
      vi.advanceTimersByTime(5000);
      // No errors thrown = pass
    });

    it("keepalive skips when window is hidden", () => {
      const view = vm.createView({
        id: "hidden-window-panel",
        type: "panel",
      });

      vm.setViewVisible("hidden-window-panel", true);

      // Simulate window hide via the event handler
      const hideHandler = (mockWindow.on as Mock).mock.calls.find(
        (c: unknown[]) => c[0] === "hide"
      )?.[1] as (() => void) | undefined;
      hideHandler?.();

      (view.setVisible as Mock).mockClear();
      (view.webContents.invalidate as Mock).mockClear();

      vi.advanceTimersByTime(5000);

      // Should not have done anything (window hidden)
      expect(view.webContents.invalidate).not.toHaveBeenCalled();
    });

    it("cooldown prevents rapid successive visibility cycles", () => {
      const view = vm.createView({
        id: "cooldown-panel",
        type: "panel",
      });

      vm.setViewVisible("cooldown-panel", true);
      (view.setVisible as Mock).mockClear();

      // First forceRepaint should cycle
      vm.forceRepaint("cooldown-panel");
      expect(view.setVisible).toHaveBeenCalledTimes(2); // false + true

      (view.setVisible as Mock).mockClear();

      // Second call within 1s should be suppressed by cooldown
      vm.forceRepaint("cooldown-panel");
      const calls = (view.setVisible as Mock).mock.calls;
      const falseIdx = calls.findIndex((c: unknown[]) => c[0] === false);
      expect(falseIdx).toBe(-1); // no visibility cycle

      // Advance past cooldown
      vi.advanceTimersByTime(1000);
      (view.setVisible as Mock).mockClear();

      // Third call after cooldown should cycle again
      vm.forceRepaint("cooldown-panel");
      expect(view.setVisible).toHaveBeenCalledTimes(2); // false + true
    });

    it("visibility cycle cooldown is scoped per view", () => {
      const firstView = vm.createView({
        id: "cooldown-panel-a",
        type: "panel",
      });
      const secondView = vm.createView({
        id: "cooldown-panel-b",
        type: "panel",
      });

      vm.setViewVisible("cooldown-panel-a", true);
      vm.setViewVisible("cooldown-panel-b", true);
      (firstView.setVisible as Mock).mockClear();
      (secondView.setVisible as Mock).mockClear();

      vm.forceRepaint("cooldown-panel-a");
      vm.forceRepaint("cooldown-panel-b");

      expect(firstView.setVisible).toHaveBeenCalledTimes(2);
      expect(secondView.setVisible).toHaveBeenCalledTimes(2);
    });

    it("forceRepaintVisiblePanel delegates to forceRepaint with visible panel ID", () => {
      const view = vm.createView({
        id: "visible-panel",
        type: "panel",
      });

      vm.setViewVisible("visible-panel", true);
      (view.setVisible as Mock).mockClear();

      const result = vm.forceRepaintVisiblePanel();

      expect(result).toBe(true);
      // Should have cycled visibility via forceRepaint
      const calls = (view.setVisible as Mock).mock.calls;
      const falseIdx = calls.findIndex((c: unknown[]) => c[0] === false);
      const trueIdx = calls.findIndex((c: unknown[], i: number) => i > falseIdx && c[0] === true);
      expect(falseIdx).toBeGreaterThanOrEqual(0);
      expect(trueIdx).toBeGreaterThan(falseIdx);
    });

    it("forceRepaintVisiblePanel returns false when no panel is visible", () => {
      expect(vm.forceRepaintVisiblePanel()).toBe(false);
    });
  });

  describe("compositor stall detection", () => {
    let vm: ViewManager;

    beforeEach(() => {
      vi.useFakeTimers();
      vm = new ViewManager({
        window: mockWindow,
        shellPreload: "/path/to/preload.js",
        shellHtmlPath: "/path/to/index.html",
      });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("recovers aggressively when capturePage returns empty image (stall detected)", async () => {
      const view = vm.createView({
        id: "stall-panel",
        type: "panel",
      });

      // capturePage returns empty image (compositor stalled)
      (view.webContents.capturePage as Mock).mockResolvedValue({ isEmpty: () => true });

      vm.setViewVisible("stall-panel", true);
      (view.setVisible as Mock).mockClear();
      (view.webContents.invalidate as Mock).mockClear();

      // Advance past the stall detector interval (10s)
      await vi.advanceTimersByTimeAsync(10000);

      // Should have done aggressive recovery: invalidate + visibility cycle
      expect(view.webContents.invalidate).toHaveBeenCalled();
      const calls = (view.setVisible as Mock).mock.calls;
      const falseIdx = calls.findIndex((c: unknown[]) => c[0] === false);
      const trueIdx = calls.findIndex((c: unknown[], i: number) => i > falseIdx && c[0] === true);
      expect(falseIdx).toBeGreaterThanOrEqual(0);
      expect(trueIdx).toBeGreaterThan(falseIdx);
    });

    it("does not recover when capturePage returns non-empty image (healthy)", async () => {
      const view = vm.createView({
        id: "healthy-panel",
        type: "panel",
      });

      // capturePage returns non-empty image (compositor healthy)
      (view.webContents.capturePage as Mock).mockResolvedValue({ isEmpty: () => false });

      vm.setViewVisible("healthy-panel", true);
      (view.setVisible as Mock).mockClear();
      (view.webContents.invalidate as Mock).mockClear();

      // Advance past the stall detector interval (10s)
      await vi.advanceTimersByTimeAsync(10000);

      // Should NOT have cycled visibility
      expect(view.setVisible).not.toHaveBeenCalled();
    });

    it("skips recovery when capturePage rejects", async () => {
      const view = vm.createView({
        id: "error-panel",
        type: "panel",
      });

      // capturePage rejects (page navigating, etc.)
      (view.webContents.capturePage as Mock).mockRejectedValue(
        new Error("WebContents is destroyed")
      );

      vm.setViewVisible("error-panel", true);
      (view.setVisible as Mock).mockClear();

      // Advance past the stall detector interval (10s)
      await vi.advanceTimersByTimeAsync(10000);

      // Should NOT have cycled visibility
      expect(view.setVisible).not.toHaveBeenCalled();
    });
  });
});
