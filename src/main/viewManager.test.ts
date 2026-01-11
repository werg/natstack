/**
 * ViewManager Unit Tests
 *
 * These tests use mocked Electron APIs to verify ViewManager logic.
 * For integration testing with real Electron, use Playwright or Spectron.
 *
 * Run with: npx vitest run src/main/viewManager.test.ts
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

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
    canGoBack: vi.fn().mockReturnValue(false),
    canGoForward: vi.fn().mockReturnValue(false),
    goBack: vi.fn(),
    goForward: vi.fn(),
    reload: vi.fn(),
    stop: vi.fn(),
    close: vi.fn(),
    send: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    insertCSS: vi.fn().mockResolvedValue("css-key"),
    removeInsertedCSS: vi.fn().mockResolvedValue(undefined),
    capturePage: vi.fn().mockResolvedValue({ isEmpty: () => false }),
  });

  const createMockWebContentsView = () => ({
    webContents: createMockWebContents(),
    setBounds: vi.fn(),
    setVisible: vi.fn(),
    getBounds: vi.fn().mockReturnValue({ x: 0, y: 0, width: 100, height: 100 }),
  });

  const mockContentView = {
    addChildView: vi.fn(),
    removeChildView: vi.fn(),
  };

  const mockBaseWindow = {
    contentView: mockContentView,
    getContentSize: vi.fn().mockReturnValue([1200, 800]),
    on: vi.fn(),
  };

  const mockSession = {
    protocol: {
      handle: vi.fn(),
    },
  };

  return {
    BaseWindow: vi.fn(() => mockBaseWindow),
    WebContentsView: vi.fn(createMockWebContentsView),
    session: {
      fromPartition: vi.fn(() => mockSession),
      defaultSession: mockSession,
    },
  };
});

// Mock panelProtocol
vi.mock("./panelProtocol.js", () => ({
  handleProtocolRequest: vi.fn(),
}));

// Import after mocks are set up
import {
  ViewManager,
  initViewManager,
  getViewManager,
  isViewManagerInitialized,
  _resetViewManagerForTesting,
} from "./viewManager.js";
import { BaseWindow, WebContentsView, session } from "electron";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MockBaseWindow = any;

describe("ViewManager", () => {
  let mockWindow: MockBaseWindow;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset singleton for each test
    _resetViewManagerForTesting();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockWindow = new (BaseWindow as any)();
  });

  describe("initialization", () => {
    it("creates shell view on construction", () => {
      const vm = new ViewManager({
        window: mockWindow,
        shellPreload: "/path/to/preload.js",
        safePreload: "/path/to/safePreload.js",
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
        safePreload: "/path/to/safePreload.js",
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
        safePreload: "/path/to/safePreload.js",
        shellHtmlPath: "/path/to/index.html",
      });
    });

    it("creates a panel view with isolated partition", () => {
      const view = vm.createView({
        id: "test-panel",
        type: "panel",
        partition: "persist:test-panel",
        url: "natstack-panel://test-panel/",
      });

      expect(view).toBeDefined();
      expect(vm.hasView("test-panel")).toBe(true);
      expect(session.fromPartition).toHaveBeenCalledWith("persist:test-panel");
    });

    it("creates a browser view with default session", () => {
      const view = vm.createView({
        id: "test-browser",
        type: "browser",
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
        url: "natstack-panel://test/",
      });

      expect(() => {
        vm.createView({
          id: "test-view",
          type: "panel",
          url: "natstack-panel://test/",
        });
      }).toThrow("View already exists: test-view");
    });

    it("passes additional arguments to webPreferences", () => {
      vm.createView({
        id: "test-panel",
        type: "panel",
        additionalArguments: ["--arg1=value1", "--arg2=value2"],
      });

      expect(WebContentsView).toHaveBeenCalledWith(
        expect.objectContaining({
          webPreferences: expect.objectContaining({
            additionalArguments: ["--arg1=value1", "--arg2=value2"],
          }),
        })
      );
    });
  });

  describe("view lifecycle", () => {
    let vm: ViewManager;

    beforeEach(() => {
      vm = new ViewManager({
        window: mockWindow,
        shellPreload: "/path/to/preload.js",
        safePreload: "/path/to/safePreload.js",
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
        safePreload: "/path/to/safePreload.js",
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
  });

  describe("getWebContents", () => {
    let vm: ViewManager;

    beforeEach(() => {
      vm = new ViewManager({
        window: mockWindow,
        shellPreload: "/path/to/preload.js",
        safePreload: "/path/to/safePreload.js",
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
        safePreload: "/path/to/safePreload.js",
        shellHtmlPath: "/path/to/index.html",
      });
    });

    it("navigateView loads URL", async () => {
      const view = vm.createView({
        id: "test-view",
        type: "browser",
        preload: null,
      });

      await vm.navigateView("test-view", "https://example.com");

      expect(view.webContents.loadURL).toHaveBeenCalledWith("https://example.com");
    });

    it("getViewUrl returns current URL", () => {
      const view = vm.createView({
        id: "test-view",
        type: "browser",
        preload: null,
      });

      (view.webContents.getURL as Mock).mockReturnValue("https://example.com");

      expect(vm.getViewUrl("test-view")).toBe("https://example.com");
    });

    it("navigation methods delegate to webContents", () => {
      const view = vm.createView({
        id: "test-view",
        type: "browser",
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
        safePreload: "/path/to/safePreload.js",
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

  describe("singleton functions", () => {
    it("isViewManagerInitialized returns false before init", () => {
      expect(isViewManagerInitialized()).toBe(false);
    });

    it("getViewManager throws before init", () => {
      expect(() => getViewManager()).toThrow("ViewManager not initialized");
    });

    it("initViewManager creates and returns singleton", () => {
      const vm = initViewManager({
        window: mockWindow,
        shellPreload: "/path/to/preload.js",
        safePreload: "/path/to/safePreload.js",
        shellHtmlPath: "/path/to/index.html",
      });

      expect(vm).toBeInstanceOf(ViewManager);
      expect(isViewManagerInitialized()).toBe(true);
      expect(getViewManager()).toBe(vm);
    });

    it("initViewManager throws if called twice", () => {
      initViewManager({
        window: mockWindow,
        shellPreload: "/path/to/preload.js",
        safePreload: "/path/to/safePreload.js",
        shellHtmlPath: "/path/to/index.html",
      });

      expect(() => {
        initViewManager({
          window: mockWindow,
          shellPreload: "/path/to/preload.js",
          safePreload: "/path/to/safePreload.js",
          shellHtmlPath: "/path/to/index.html",
        });
      }).toThrow("ViewManager already initialized");
    });
  });
});
