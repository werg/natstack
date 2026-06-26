import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { Panel } from "@natstack/shared/types";
import { PanelView } from "./panelView.js";

function makePanel(id: string, source = "about/new"): Panel {
  return {
    id,
    title: id,
    children: [],
    snapshot: {
      source,
      contextId: "ctx-current",
      options: {},
    },
    artifacts: {},
    runtimeEntityId: "panel:nav-current",
  };
}

function makeWebContents() {
  type WindowOpenHandler = (details: { url: string }) => { action: "deny" };
  let windowOpenHandler: WindowOpenHandler | null = null;
  const webContents = Object.assign(new EventEmitter(), {
    id: 10,
    isDestroyed: vi.fn(() => false),
    getURL: vi.fn(() => "http://127.0.0.1:1234/about/new/"),
    loadURL: vi.fn(async () => undefined),
    setWindowOpenHandler: vi.fn((handler: WindowOpenHandler) => {
      windowOpenHandler = handler;
    }),
  });
  return {
    webContents,
    windowOpen(details: { url: string }) {
      if (!windowOpenHandler) throw new Error("window open handler not registered");
      return windowOpenHandler(details);
    },
  };
}

function createHarness(options: { viewType?: "panel" | "app" } = {}) {
  const panelId = options.viewType === "app" ? "@workspace-apps/shell" : "panel:tree/current";
  const panel = makePanel(panelId);
  const wc = makeWebContents();
  const viewManager = {
    hasView: vi.fn(() => false),
    getViewUrl: vi.fn(() => null),
    navigateView: vi.fn(async () => undefined),
    updateAppView: vi.fn(async () => undefined),
    createView: vi.fn(() => ({ webContents: wc.webContents })),
    getWebContents: vi.fn(() => wc.webContents),
    getViewInfo: vi.fn((id: string) =>
      id === panelId
        ? {
            type: options.viewType ?? "panel",
            visible: true,
            hostChrome: options.viewType === "app",
            bounds: { x: 0, y: 0, width: 100, height: 100 },
            capabilities: options.viewType === "app" ? ["panel-hosting"] : [],
          }
        : null
    ),
  };
  const panelRegistry = {
    findParentId: vi.fn(() => null),
    getPanel: vi.fn((id: string) => (id === panelId && options.viewType !== "app" ? panel : null)),
    notifyPanelTreeUpdate: vi.fn(),
  };
  const panelOrchestrator = {
    createPanel: vi.fn(async () => ({ id: "panel:tree/created", title: "Created" })),
    createBrowserUrlPanel: vi.fn(async () => ({ id: "panel:tree/browser", title: "Browser" })),
    navigatePanel: vi.fn(async () => ({ id: panelId, title: "Navigated" })),
    replaceCurrentSnapshot: vi.fn(async () => undefined),
    updatePanelTitle: vi.fn(async () => undefined),
  };
  const sendPanelEvent = vi.fn();
  const panelView = new PanelView({
    viewManager,
    panelRegistry,
    serverInfo: { gatewayPort: 1234, externalHost: "127.0.0.1" },
    cdpHost: {
      registerTarget: vi.fn(),
      unregisterTarget: vi.fn(),
      cleanupPanelAccess: vi.fn(),
    },
    panelOrchestrator,
    sendPanelEvent,
    appPreloadPath: "/app-preload.js",
  } as never);

  return { panelId, panelView, panelOrchestrator, sendPanelEvent, ...wc };
}

describe("PanelView plain panel links", () => {
  it("navigates the current panel slot for same-frame managed links", async () => {
    const { panelId, panelView, webContents, panelOrchestrator } = createHarness();
    await panelView.createViewForPanel(panelId, "http://127.0.0.1:1234/about/new/", "ctx-current");

    const event = { preventDefault: vi.fn() };
    webContents.emit(
      "will-navigate",
      event,
      "http://127.0.0.1:1234/panels/chat/?stateArgs=%7B%22initialPrompt%22%3A%22hi%22%7D"
    );

    await vi.waitFor(() => {
      expect(panelOrchestrator.navigatePanel).toHaveBeenCalledWith(panelId, "panels/chat", {
        stateArgs: { initialPrompt: "hi" },
      });
    });
    expect(event.preventDefault).toHaveBeenCalled();
    expect(panelOrchestrator.createPanel).not.toHaveBeenCalled();
  });

  it("creates child panels for managed window-open links", async () => {
    const { panelId, panelView, windowOpen, panelOrchestrator, sendPanelEvent } = createHarness();
    await panelView.createViewForPanel(panelId, "http://127.0.0.1:1234/about/new/", "ctx-current");

    const result = windowOpen({ url: "http://127.0.0.1:1234/panels/chat/?name=chat-link" });

    expect(result).toEqual({ action: "deny" });
    await vi.waitFor(() => {
      expect(panelOrchestrator.createPanel).toHaveBeenCalledWith(
        panelId,
        "panels/chat",
        { name: "chat-link" },
        undefined,
        undefined
      );
    });
    expect(sendPanelEvent).toHaveBeenCalledWith(panelId, "runtime:child-created", {
      childId: "panel:tree/created",
      url: "http://127.0.0.1:1234/panels/chat/?name=chat-link",
    });
  });

  it("creates browser child panels for same-frame external links", async () => {
    const { panelId, panelView, webContents, panelOrchestrator } = createHarness();
    await panelView.createViewForPanel(panelId, "http://127.0.0.1:1234/about/new/", "ctx-current");

    const event = { preventDefault: vi.fn() };
    webContents.emit("will-navigate", event, "https://example.com/");

    await vi.waitFor(() => {
      expect(panelOrchestrator.createBrowserUrlPanel).toHaveBeenCalledWith(
        panelId,
        "https://example.com/",
        { focus: true },
        undefined
      );
    });
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it("opens managed links from app views as app-scoped root panels", async () => {
    const { panelId, panelView, webContents, panelOrchestrator } = createHarness({
      viewType: "app",
    });
    await panelView.createViewForApp(
      panelId,
      "http://127.0.0.1:1234/_a/shell/index.html",
      undefined,
      ["panel-hosting"],
      { source: "apps/shell", effectiveVersion: "ev" }
    );

    const event = { preventDefault: vi.fn() };
    webContents.emit("will-navigate", event, "http://127.0.0.1:1234/about/help/");

    await vi.waitFor(() => {
      expect(panelOrchestrator.createPanel).toHaveBeenCalledWith(
        panelId,
        "about/help",
        {},
        undefined,
        { callerId: "@workspace-apps/shell", callerKind: "app" }
      );
    });
    expect(event.preventDefault).toHaveBeenCalled();
  });
});
