import { describe, expect, it, vi } from "vitest";
import { PanelRegistry } from "@natstack/shared/panelRegistry";
import type { Panel } from "@natstack/shared/types";
import { PanelOrchestrator } from "./panelOrchestrator.js";

function makePanel(id: string, children: Panel[] = []): Panel {
  const snapshot = {
    source: `panels/${id}`,
    contextId: `ctx-${id}`,
    options: {},
  };
  return {
    id,
    title: id,
    children,
    snapshot,
    artifacts: {},
  };
}

function createOrchestrator(registry: PanelRegistry, emit = vi.fn()) {
  const closedIds: string[] = [];
  const panelView = {
    createViewForPanel: vi.fn(async () => {}),
    hasView: vi.fn(() => false),
    setViewVisible: vi.fn(),
    destroyView: vi.fn(),
  };
  const shellCore = {
    close: vi.fn(async (panelId: string) => ({ closedIds: [panelId, ...closedIds] })),
    create: vi.fn(async () => ({
      panelId: "created-panel",
      title: "created-panel",
      contextId: "ctx-created-panel",
      source: "panels/created-panel",
      options: {},
    })),
    notifyFocused: vi.fn(async () => {}),
    getCurrentEntityId: vi.fn(async (panelId: string) => `panel:nav-${panelId}`),
  };
  const serverClient = {
    call: vi.fn(async (_service: string, method: string) => {
      if (method === "registerClient") return undefined;
      if (method === "acquire" || method === "takeOver") return { acquired: true };
      return undefined;
    }),
  };
  const orchestrator = new PanelOrchestrator({
    registry,
    eventService: { emit } as never,
    serverClient: serverClient as never,
    shellCore: shellCore as never,
    cdpServer: { cleanupPanelAccess: vi.fn() },
    panelHttpServer: { hasBuild: vi.fn(() => false), invalidateBuild: vi.fn(), getPort: vi.fn() },
    externalHost: "localhost",
    protocol: "http",
    gatewayPort: 1234,
    sendPanelEvent: vi.fn(),
    getPanelView: () => panelView as never,
  });

  return { orchestrator, emit, shellCore, closedIds, panelView, serverClient };
}

describe("PanelOrchestrator.closePanel", () => {
  it("navigates away when closing a root that contains the focused panel", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const closingRoot = makePanel("closing-root");
    const nextRoot = makePanel("next-root");
    registry.addPanel(nextRoot, null, { addAsRoot: true });
    registry.addPanel(closingRoot, null, { addAsRoot: true });
    const focusedChild = makePanel("focused-child");
    registry.addPanel(focusedChild, closingRoot.id);
    registry.updateSelectedPath(focusedChild.id);

    const { orchestrator, emit, closedIds } = createOrchestrator(registry);
    closedIds.push(focusedChild.id);

    await orchestrator.closePanel(closingRoot.id);

    expect(emit).toHaveBeenCalledWith("navigate-to-panel", { panelId: nextRoot.id });
  });

  it("does not navigate when closing a sibling outside the focused subtree", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const root = makePanel("root");
    registry.addPanel(root, null, { addAsRoot: true });
    const sibling = makePanel("sibling");
    registry.addPanel(sibling, root.id);
    const focusedChild = makePanel("focused-child");
    registry.addPanel(focusedChild, root.id);
    registry.updateSelectedPath(focusedChild.id);

    const { orchestrator, emit } = createOrchestrator(registry);

    await orchestrator.closePanel(sibling.id);

    expect(emit).not.toHaveBeenCalledWith("navigate-to-panel", expect.anything());
  });
});

describe("PanelOrchestrator.focusPanel", () => {
  it("shows an existing native panel view from main when focusing", () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const panel = makePanel("panel-1");
    registry.addPanel(panel, null, { addAsRoot: true });

    const { orchestrator, panelView, emit } = createOrchestrator(registry);
    panelView.hasView.mockReturnValue(true);

    orchestrator.focusPanel(panel.id);

    expect(panelView.setViewVisible).toHaveBeenCalledWith(panel.id, true);
    expect(emit).toHaveBeenCalledWith("navigate-to-panel", { panelId: panel.id });
  });
});

describe("PanelOrchestrator.createPanel", () => {
  it("focuses after creating the native view for focused panels", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const caller = makePanel("caller");
    const createdPanel = makePanel("created-panel");
    registry.addPanel(caller, null, { addAsRoot: true });
    registry.addPanel(createdPanel, null, { addAsRoot: true });

    const { orchestrator, panelView, emit } = createOrchestrator(registry);
    panelView.hasView.mockReturnValue(true);

    await orchestrator.createPanel(caller.id, "panels/created-panel", { focus: true });

    expect(panelView.createViewForPanel).toHaveBeenCalledWith(
      createdPanel.id,
      expect.stringContaining("/panels/created-panel/"),
      "ctx-created-panel"
    );
    expect(panelView.setViewVisible).toHaveBeenCalledWith(createdPanel.id, true);
    expect(emit).toHaveBeenCalledWith("navigate-to-panel", { panelId: createdPanel.id });
    expect(panelView.createViewForPanel.mock.invocationCallOrder[0]).toBeLessThan(
      panelView.setViewVisible.mock.invocationCallOrder[0] ?? 0
    );
  });
});
