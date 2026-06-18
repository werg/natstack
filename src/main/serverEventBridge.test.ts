import { describe, expect, it, vi } from "vitest";
import { asPanelEntityId, asPanelSlotId } from "@natstack/shared/panel/ids";
import { createServerEventBridge } from "./serverEventBridge.js";

function createHarness() {
  const eventService = { emit: vi.fn() };
  const panelOrchestrator = {
    applyBuildComplete: vi.fn(),
    applyRuntimeLeaseChanged: vi.fn(async () => {}),
    applyServerPanelTreeSnapshot: vi.fn(async () => undefined),
    applyServerPanelTitleUpdate: vi.fn(),
    createBrowserUrlPanel: vi.fn(async () => ({ id: "browser", title: "Browser" })),
    recoverShellSnapshot: vi.fn(async () => undefined),
  };
  const appOrchestrator = {
    applyAppAvailable: vi.fn(async () => {}),
  };
  const serverClient = {
    call: vi.fn(async () => undefined),
  };
  const warn = vi.fn();
  const onAppHostTargetChanged = vi.fn();
  const handle = createServerEventBridge({
    eventService: eventService as never,
    getPanelOrchestrator: () => panelOrchestrator as never,
    getAppOrchestrator: () => appOrchestrator as never,
    getServerClient: () => serverClient as never,
    openExternal: vi.fn(async () => {}),
    onAppHostTargetChanged,
    warn,
  });
  return {
    handle,
    eventService,
    panelOrchestrator,
    appOrchestrator,
    serverClient,
    onAppHostTargetChanged,
    warn,
  };
}

describe("createServerEventBridge", () => {
  it("normalizes build completion into orchestrator state updates instead of emitting raw events", () => {
    const { handle, eventService, panelOrchestrator } = createHarness();

    handle("build:complete", { source: "panels/chat", error: "failed" });

    expect(panelOrchestrator.applyBuildComplete).toHaveBeenCalledWith("panels/chat", "failed");
    expect(eventService.emit).not.toHaveBeenCalled();
  });

  it("normalizes runtime lease changes through the orchestrator", async () => {
    const { handle, eventService, panelOrchestrator } = createHarness();
    const payload = {
      type: "panel:runtimeLeaseChanged" as const,
      version: { epoch: "test", counter: 1 },
      slotId: asPanelSlotId("slot-a"),
      runtimeEntityId: asPanelEntityId("panel:nav-a"),
      previous: null,
      next: null,
      reason: "released" as const,
    };

    handle("event:panel:runtimeLeaseChanged", payload);
    await Promise.resolve();

    expect(panelOrchestrator.applyRuntimeLeaseChanged).toHaveBeenCalledWith(payload);
    expect(eventService.emit).not.toHaveBeenCalled();
  });

  it("re-emits ordinary server EventService events as local shell events", () => {
    const { handle, eventService } = createHarness();

    handle("event:notification:show", { id: "n1", type: "info", title: "Hello" });

    expect(eventService.emit).toHaveBeenCalledWith("notification:show", {
      id: "n1",
      type: "info",
      title: "Hello",
    });
  });

  it("applies server panel tree snapshots without reloading the tree", async () => {
    const { handle, eventService, panelOrchestrator } = createHarness();
    const snapshot = { revision: 2, rootPanels: [] };

    handle("event:panel-tree-updated", snapshot);
    await Promise.resolve();

    expect(panelOrchestrator.applyServerPanelTreeSnapshot).toHaveBeenCalledWith(snapshot);
    expect(panelOrchestrator.recoverShellSnapshot).not.toHaveBeenCalled();
    expect(eventService.emit).not.toHaveBeenCalled();
  });

  it("applies server panel title updates without forwarding raw events", () => {
    const { handle, eventService, panelOrchestrator } = createHarness();

    handle("event:panel-title-updated", { panelId: "panel-1", title: "New title", explicit: true });

    expect(panelOrchestrator.applyServerPanelTitleUpdate).toHaveBeenCalledWith({
      panelId: "panel-1",
      title: "New title",
      explicit: true,
    });
    expect(eventService.emit).not.toHaveBeenCalled();
  });

  it("handles browser-panel requests locally instead of forwarding raw events", async () => {
    const { handle, eventService, panelOrchestrator } = createHarness();

    handle("event:browser-panel:open", {
      url: "https://example.com/",
      parentPanelId: "slot-a",
    });
    await Promise.resolve();

    expect(panelOrchestrator.createBrowserUrlPanel).toHaveBeenCalledWith(
      "slot-a",
      "https://example.com/",
      { focus: true }
    );
    expect(eventService.emit).not.toHaveBeenCalled();
  });

  it("applies app availability locally and still forwards the app event to shell UI", async () => {
    const { handle, eventService, appOrchestrator, onAppHostTargetChanged } = createHarness();
    const payload = {
      appId: "@workspace-apps/shell",
      target: "electron",
      url: "http://127.0.0.1/_a/app/index.html",
      adoptionPolicy: "prompt",
    };

    handle("event:apps:available", payload);
    await Promise.resolve();

    expect(appOrchestrator.applyAppAvailable).toHaveBeenCalledWith(payload);
    expect(onAppHostTargetChanged).toHaveBeenCalledWith({ event: "apps:available", payload });
    expect(eventService.emit).toHaveBeenCalledWith("apps:available", payload);
  });

  it("only wakes desktop host sync for host-target changes that can affect Electron", () => {
    const { handle, onAppHostTargetChanged } = createHarness();

    handle("event:host-targets:changed", { target: "react-native", reason: "app-status" });
    expect(onAppHostTargetChanged).not.toHaveBeenCalled();

    const payload = { target: "electron", reason: "selection-changed" };
    handle("event:host-targets:changed", payload);

    expect(onAppHostTargetChanged).toHaveBeenCalledWith({
      event: "host-targets:changed",
      payload,
    });
  });
});
