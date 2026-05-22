import { describe, expect, it, vi } from "vitest";
import { asPanelEntityId, asPanelSlotId } from "@natstack/shared/panel/ids";
import { createServerEventBridge } from "./serverEventBridge.js";

function createHarness() {
  const eventService = { emit: vi.fn() };
  const panelOrchestrator = {
    applyBuildComplete: vi.fn(),
    applyRuntimeLeaseChanged: vi.fn(async () => {}),
    createBrowserUrlPanel: vi.fn(async () => ({ id: "browser", title: "Browser" })),
  };
  const serverClient = {
    call: vi.fn(async () => undefined),
  };
  const warn = vi.fn();
  const handle = createServerEventBridge({
    eventService: eventService as never,
    getPanelOrchestrator: () => panelOrchestrator as never,
    getServerClient: () => serverClient as never,
    openExternal: vi.fn(async () => {}),
    warn,
  });
  return { handle, eventService, panelOrchestrator, serverClient, warn };
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
});
