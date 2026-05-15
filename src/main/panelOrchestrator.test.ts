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
    selectedChildId: null,
    history: { entries: [snapshot], index: 0 },
    artifacts: {},
  };
}

function createOrchestrator(registry: PanelRegistry, emit = vi.fn()) {
  const closedIds: string[] = [];
  const shellCore = {
    close: vi.fn(async (panelId: string) => ({ closedIds: [panelId, ...closedIds] })),
  };
  const orchestrator = new PanelOrchestrator({
    registry,
    tokenManager: { revokeToken: vi.fn() } as never,
    eventService: { emit } as never,
    serverClient: {} as never,
    shellCore: shellCore as never,
    cdpServer: { revokeTokenForPanel: vi.fn() },
    panelHttpServer: {} as never,
    externalHost: "localhost",
    protocol: "http",
    gatewayPort: 1234,
    sendPanelEvent: vi.fn(),
    getPanelView: () =>
      ({
        hasView: vi.fn(() => false),
        destroyView: vi.fn(),
      }) as never,
  });

  return { orchestrator, emit, shellCore, closedIds };
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
