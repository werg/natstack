import { describe, expect, it, vi } from "vitest";
import { PanelRegistry } from "@natstack/shared/panelRegistry";
import type { Panel } from "@natstack/shared/types";
import { getCurrentSnapshot } from "@natstack/shared/panel/accessors";
import { asPanelEntityId, asPanelSlotId } from "@natstack/shared/panel/ids";
import { PanelOrchestrator } from "./panelOrchestrator.js";

function makePanel(id: string, children: Panel[] = [], overrides?: Partial<Panel>): Panel {
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
    ...overrides,
  };
}

function createOrchestrator(
  registry: PanelRegistry,
  emit = vi.fn(),
  opts: {
    panelRestorePolicy?: "focused" | "none";
    runtimeClient?: ConstructorParameters<typeof PanelOrchestrator>[0]["runtimeClient"];
    workspaceConfig?: ConstructorParameters<typeof PanelOrchestrator>[0]["workspaceConfig"];
  } = {}
) {
  const closedIds: string[] = [];
  const panelView = {
    createViewForPanel: vi.fn(async (_panelId: string, _url: string, _contextId?: string) => {}),
    createViewForBrowser: vi.fn(async (_panelId: string, _url: string, _contextId?: string) => {}),
    hasView: vi.fn((_panelId: string) => false),
    getWebContents: vi.fn((_panelId: string) => null),
    setViewVisible: vi.fn((_panelId: string, _visible: boolean) => {}),
    destroyView: vi.fn((_panelId: string) => {}),
  };
  const panelHttpServer = {
    hasBuild: vi.fn(() => false),
    getBuildRevision: vi.fn(() => undefined as number | undefined),
    invalidateBuild: vi.fn(),
    getPort: vi.fn(),
  };
  const shellCore = {
    close: vi.fn(async (panelId: string) => ({ closedIds: [panelId, ...closedIds] })),
    create: vi.fn(async (_source?: string, _options?: unknown) => ({
      panelId: "created-panel",
      title: "created-panel",
      contextId: "ctx-created-panel",
      source: "panels/created-panel",
      options: {},
    })),
    updateStateArgs: vi.fn(async (panelId: string, updates: Record<string, unknown>) => {
      const panel = registry.getPanel(panelId);
      const current = panel
        ? ((getCurrentSnapshot(panel).stateArgs ?? {}) as Record<string, unknown>)
        : {};
      return { ...current, ...updates };
    }),
    onStateArgsChanged: vi.fn(() => () => {}),
    notifyFocused: vi.fn(async () => {}),
    getPanelInit: vi.fn(async (panelId: string) => ({
      entityId: panelId,
      gatewayConfig: { serverUrl: "http://127.0.0.1:1234", token: "token" },
    })),
    getCurrentEntityId: vi.fn(async (panelId: string) => `panel:nav-${panelId}`),
    loadTree: vi.fn(async () => ({
      rootPanels: registry.getRootPanels(),
      collapsedIds: [],
    })),
  };
  const serverClient = {
    call: vi.fn(async (_service: string, method: string) => {
      if (method === "registerClient") return undefined;
      if (method === "acquire" || method === "takeOver") return { acquired: true };
      if (method === "getSnapshot") return { version: { epoch: "test", counter: 1 }, leases: [] };
      return undefined;
    }),
  };
  const cdpHost = {
    cleanupPanelAccess: vi.fn(),
    unregisterTarget: vi.fn(),
  };
  const orchestrator = new PanelOrchestrator({
    registry,
    eventService: { emit } as never,
    serverClient: serverClient as never,
    shellCore: shellCore as never,
    cdpHost,
    panelHttpServer,
    externalHost: "localhost",
    protocol: "http",
    gatewayPort: 1234,
    sendPanelEvent: vi.fn(),
    getPanelView: () => panelView as never,
    workspaceConfig:
      opts.workspaceConfig ??
      (opts.panelRestorePolicy
        ? ({ id: "test", panelRestorePolicy: opts.panelRestorePolicy } as never)
        : undefined),
    runtimeClient: opts.runtimeClient,
  });

  return {
    orchestrator,
    emit,
    shellCore,
    closedIds,
    panelView,
    panelHttpServer,
    serverClient,
    cdpHost,
  };
}

describe("PanelOrchestrator.closePanel", () => {
  it("registers the runtime host before CDP provider startup can claim its host id", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const { orchestrator, serverClient } = createOrchestrator(registry, vi.fn(), {
      runtimeClient: {
        clientSessionId: "host-session",
        platform: "headless",
        label: "Headless",
        supportsCdp: true,
      },
    });

    await orchestrator.registerRuntimeClient();
    await orchestrator.registerRuntimeClient();

    expect(serverClient.call).toHaveBeenCalledTimes(1);
    expect(serverClient.call).toHaveBeenCalledWith("panelRuntime", "registerClient", [
      {
        clientSessionId: "host-session",
        hostConnectionId: "host-session",
        label: "Headless",
        platform: "headless",
        supportsCdp: true,
      },
    ]);
  });

  it("unregisters the runtime host once during shutdown", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const { orchestrator, serverClient } = createOrchestrator(registry, vi.fn(), {
      runtimeClient: {
        clientSessionId: "host-session",
        platform: "headless",
        label: "Headless",
        supportsCdp: true,
      },
    });

    await orchestrator.registerRuntimeClient();
    await orchestrator.unregisterRuntimeClient();
    await orchestrator.unregisterRuntimeClient();

    expect(serverClient.call).toHaveBeenCalledWith("panelRuntime", "unregisterClient", [
      "host-session",
    ]);
    expect(
      serverClient.call.mock.calls.filter(
        ([service, method]) => service === "panelRuntime" && method === "unregisterClient"
      )
    ).toHaveLength(1);
  });

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

  it("uses orchestrator-owned local runtime cleanup for closed panels", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const root = makePanel("root");
    registry.addPanel(root, null, { addAsRoot: true });
    const { orchestrator, panelView, cdpHost } = createOrchestrator(registry);
    panelView.hasView.mockReturnValue(true);

    await orchestrator.closePanel(root.id);

    expect(cdpHost.cleanupPanelAccess).toHaveBeenCalledWith(root.id);
    expect(cdpHost.unregisterTarget).toHaveBeenCalledWith(root.id);
    expect(panelView.destroyView).toHaveBeenCalledWith(root.id);
  });
});

describe("PanelOrchestrator.ensureLoaded", () => {
  it("loads a panel without selecting or focusing it", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const panel = makePanel("target");
    registry.addPanel(panel, null, { addAsRoot: true });

    const { orchestrator, panelView, shellCore, emit } = createOrchestrator(registry);
    let loaded = false;
    panelView.createViewForPanel.mockImplementationOnce(async () => {
      loaded = true;
    });
    panelView.hasView.mockImplementation((panelId: string) => panelId === "target" && loaded);

    await expect(orchestrator.ensureLoaded("target")).resolves.toMatchObject({
      panelId: "target",
      status: "loaded",
      focused: false,
      loaded: true,
    });

    expect(shellCore.notifyFocused).not.toHaveBeenCalled();
    expect(panelView.setViewVisible).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalledWith("navigate-to-panel", expect.anything());
  });
});

describe("PanelOrchestrator.focusPanel", () => {
  it("shows an existing native panel view from main when focusing", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const panel = makePanel("panel-1");
    registry.addPanel(panel, null, { addAsRoot: true });

    const { orchestrator, panelView, emit } = createOrchestrator(registry);
    panelView.hasView.mockReturnValue(true);

    const result = await orchestrator.focusPanel(panel.id);

    expect(panelView.setViewVisible).toHaveBeenCalledWith(panel.id, true);
    expect(emit).toHaveBeenCalledWith("navigate-to-panel", { panelId: panel.id });
    expect(result).toMatchObject({ status: "loaded", focused: true, loaded: true });
  });

  it("loads a missing native view during focus even when build is already ready", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const panel = makePanel("panel-1", [], {
      artifacts: { buildState: "ready" },
    });
    registry.addPanel(panel, null, { addAsRoot: true });

    const { orchestrator, panelView, panelHttpServer } = createOrchestrator(registry);
    const loadedPanels = new Set<string>();
    panelView.hasView.mockImplementation((panelId: string) => loadedPanels.has(panelId));
    panelView.createViewForPanel.mockImplementation(async (panelId: string) => {
      loadedPanels.add(panelId);
    });
    panelHttpServer.hasBuild.mockReturnValue(true);

    const result = await orchestrator.focusPanel(panel.id, { loadIfNeeded: true });

    expect(panelView.createViewForPanel).toHaveBeenCalledWith(
      panel.id,
      expect.stringContaining("/panels/panel-1/"),
      "ctx-panel-1"
    );
    expect(panelView.setViewVisible).toHaveBeenCalledWith(panel.id, true);
    expect(result).toMatchObject({ status: "loaded", focused: true, loaded: true });
  });

  it("acquires and releases runtime leases for browser panels", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const panel = makePanel("browser-1", [], {
      snapshot: {
        source: "browser:https://example.com",
        contextId: "ctx-browser-1",
        options: {},
      },
      artifacts: { buildState: "ready" },
    });
    registry.addPanel(panel, null, { addAsRoot: true });

    const { orchestrator, panelView, serverClient } = createOrchestrator(registry);
    const loadedPanels = new Set<string>();
    panelView.hasView.mockImplementation((panelId: string) => loadedPanels.has(panelId));
    panelView.createViewForBrowser.mockImplementation(async (panelId: string) => {
      loadedPanels.add(panelId);
    });

    await expect(orchestrator.ensureLoaded(panel.id)).resolves.toMatchObject({
      status: "loaded",
      loaded: true,
    });

    expect(serverClient.call).toHaveBeenCalledWith("panelRuntime", "acquire", [
      `panel:nav-${panel.id}`,
      expect.objectContaining({
        slotId: panel.id,
        clientSessionId: orchestrator.getRuntimeClientSessionId(),
      }),
    ]);

    await orchestrator.unloadPanel(panel.id);

    expect(serverClient.call).toHaveBeenCalledWith("panelRuntime", "release", [
      `panel:nav-${panel.id}`,
      expect.stringContaining(`desktop-${panel.id}-`),
    ]);
  });

  it("returns a structured leased_elsewhere result when focus cannot acquire runtime", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const panel = makePanel("panel-1", [], {
      artifacts: { buildState: "pending" },
    });
    registry.addPanel(panel, null, { addAsRoot: true });

    const { orchestrator, serverClient } = createOrchestrator(registry);
    serverClient.call.mockImplementation(async (_service: string, method: string) => {
      if (method === "registerClient") return undefined;
      if (method === "acquire") {
        return { acquired: false, lease: { holderLabel: "Desktop B" } };
      }
      return undefined;
    });

    const result = await orchestrator.focusPanel(panel.id, { loadIfNeeded: true });

    expect(result).toMatchObject({
      status: "leased_elsewhere",
      focused: true,
      loaded: false,
      message: expect.stringContaining("Desktop B"),
    });
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

describe("PanelOrchestrator.handleSetStateArgs", () => {
  it("serializes concurrent updates for the same panel", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const panel = makePanel("panel-1");
    registry.addPanel(panel, null, { addAsRoot: true });

    const { orchestrator, shellCore } = createOrchestrator(registry);
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    shellCore.updateStateArgs.mockImplementationOnce(
      async (panelId: string, updates: Record<string, unknown>) => {
        await firstGate;
        const current = (getCurrentSnapshot(registry.getPanel(panelId)!).stateArgs ?? {}) as Record<
          string,
          unknown
        >;
        return { ...current, ...updates };
      }
    );

    const first = orchestrator.handleSetStateArgs(panel.id, { channelName: "chat-1" });
    const second = orchestrator.handleSetStateArgs(panel.id, {
      actionBarFile: "panels/chat/Bar.tsx",
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(shellCore.updateStateArgs).toHaveBeenCalledTimes(1);

    releaseFirst();
    await Promise.all([first, second]);

    expect(shellCore.updateStateArgs).toHaveBeenCalledTimes(2);
    expect(getCurrentSnapshot(registry.getPanel(panel.id)!).stateArgs).toEqual({
      channelName: "chat-1",
      actionBarFile: "panels/chat/Bar.tsx",
    });
  });
});

describe("PanelOrchestrator.applyBuildComplete", () => {
  it("updates duplicate-source slots without pretending unloaded slots have native views", () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const first = makePanel("slot-a", [], {
      snapshot: {
        source: "panels/chat",
        contextId: "ctx-a",
        options: {},
      },
      artifacts: { buildState: "building", buildProgress: "Waiting for build..." },
    });
    const second = makePanel("slot-b", [], {
      snapshot: {
        source: "panels/chat",
        contextId: "ctx-b",
        options: {},
      },
      artifacts: { buildState: "building", buildProgress: "Waiting for build..." },
    });
    registry.addPanel(first, null, { addAsRoot: true });
    registry.addPanel(second, null, { addAsRoot: true });

    const { orchestrator, panelView, panelHttpServer } = createOrchestrator(registry);
    panelView.hasView.mockImplementation((panelId: string) => panelId === first.id);
    panelHttpServer.getBuildRevision.mockReturnValue(12);

    orchestrator.applyBuildComplete("panels/chat");

    expect(registry.getPanel(first.id)?.artifacts).toMatchObject({
      buildState: "ready",
      buildRevision: 12,
      htmlPath: expect.stringContaining("/panels/chat/"),
    });
    expect(registry.getPanel(first.id)?.state?.view.exists).toBe(true);
    expect(registry.getPanel(second.id)?.artifacts).toMatchObject({
      buildState: "ready",
      buildRevision: 12,
    });
    expect(registry.getPanel(second.id)?.artifacts.htmlPath).toBeUndefined();
    expect(registry.getPanel(second.id)?.state?.view.exists).toBe(false);
  });
});

describe("PanelOrchestrator.recoverShellSnapshot", () => {
  it("syncs tree and leases, resolves focus, and publishes one normalized snapshot", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const root = makePanel("root");
    registry.addPanel(root, null, { addAsRoot: true });
    const emit = vi.fn();
    const { orchestrator, shellCore, serverClient } = createOrchestrator(registry, emit);

    const snapshot = await orchestrator.recoverShellSnapshot({ loadFocusedView: false });

    expect(shellCore.loadTree).toHaveBeenCalled();
    expect(serverClient.call).toHaveBeenCalledWith("panelRuntime", "getSnapshot", []);
    expect(snapshot.focusedPanelId).toBe(root.id);
    expect(snapshot.focus).toMatchObject({
      panelId: root.id,
      status: "focused",
      focused: true,
      loaded: false,
    });
    expect(emit).toHaveBeenCalledWith(
      "panel:snapshot",
      expect.objectContaining({
        focusedPanelId: root.id,
        rootPanels: expect.arrayContaining([expect.objectContaining({ id: root.id })]),
      })
    );
  });

  it("loads the focused view by default restore policy", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const root = makePanel("root", [], { artifacts: { buildState: "pending" } });
    registry.addPanel(root, null, { addAsRoot: true });
    registry.updateSelectedPath(root.id);
    const { orchestrator, panelView } = createOrchestrator(registry);
    const loadedPanels = new Set<string>();
    panelView.hasView.mockImplementation((panelId: string) => loadedPanels.has(panelId));
    panelView.createViewForPanel.mockImplementation(async (panelId: string) => {
      loadedPanels.add(panelId);
    });

    const snapshot = await orchestrator.recoverShellSnapshot();

    expect(panelView.createViewForPanel).toHaveBeenCalledWith(
      root.id,
      expect.stringContaining("/panels/root/"),
      "ctx-root"
    );
    expect(snapshot.focus).toMatchObject({ status: "loaded", loaded: true });
  });

  it("can restore only tree state when policy is none", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const root = makePanel("root", [], { artifacts: { buildState: "pending" } });
    registry.addPanel(root, null, { addAsRoot: true });
    registry.updateSelectedPath(root.id);
    const { orchestrator, panelView } = createOrchestrator(registry, vi.fn(), {
      panelRestorePolicy: "none",
    });

    const snapshot = await orchestrator.recoverShellSnapshot();

    expect(panelView.createViewForPanel).not.toHaveBeenCalled();
    expect(snapshot.focus).toMatchObject({ status: "focused", loaded: false });
  });
});

describe("PanelOrchestrator.initializePanelTree", () => {
  it("creates distinct root panels for duplicate init panel sources", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const { orchestrator, shellCore } = createOrchestrator(registry, vi.fn(), {
      workspaceConfig: {
        id: "test",
        panelRestorePolicy: "none",
        initPanels: [
          { source: "panels/chat", stateArgs: { initialPrompt: "first" } },
          { source: "panels/chat", stateArgs: { initialPrompt: "second" } },
        ],
      } as never,
    });
    shellCore.create.mockImplementation(async (_source?: string, options?: unknown) => {
      const createOptions = options as { stateArgs?: Record<string, unknown> } | undefined;
      const index = registry.getRootPanels().length + 1;
      const panel = makePanel(`chat-${index}`, [], {
        title: `Chat ${index}`,
        snapshot: {
          source: "panels/chat",
          contextId: `ctx-chat-${index}`,
          options: {},
          stateArgs: createOptions?.stateArgs,
        },
      });
      registry.addPanel(panel, null, { addAsRoot: true });
      return {
        panelId: panel.id,
        title: panel.title,
        contextId: getCurrentSnapshot(panel).contextId,
        source: "panels/chat",
        options: {},
      };
    });

    await orchestrator.initializePanelTree();

    expect(shellCore.create).toHaveBeenCalledTimes(2);
    expect(registry.getRootPanels().map((panel) => panel.id)).toEqual(["chat-1", "chat-2"]);
  });
});

describe("PanelOrchestrator.applyServerPanelTreeSnapshot", () => {
  it("ignores server echo snapshots that match the optimistic local tree", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const root = makePanel("root", [], {
      title: "Runtime title",
      artifacts: { buildState: "ready", htmlPath: "http://localhost/panels/root/" },
    });
    registry.addPanel(root, null, { addAsRoot: true });
    const { orchestrator, serverClient } = createOrchestrator(registry);
    const repopulate = vi.spyOn(registry, "repopulate");

    await orchestrator.applyServerPanelTreeSnapshot({
      revision: 1,
      rootPanels: [
        makePanel("root", [], {
          title: "Runtime title",
          artifacts: { buildState: "building", buildProgress: "Restoring..." },
        }),
      ],
    });

    expect(repopulate).not.toHaveBeenCalled();
    expect(serverClient.call).not.toHaveBeenCalledWith("panelRuntime", "getSnapshot", []);
  });

  it("applies server snapshots when the semantic tree changes", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    registry.addPanel(makePanel("root", [], { title: "Old title" }), null, { addAsRoot: true });
    const { orchestrator } = createOrchestrator(registry);
    const repopulate = vi.spyOn(registry, "repopulate");

    await orchestrator.applyServerPanelTreeSnapshot({
      revision: 1,
      rootPanels: [makePanel("root", [], { title: "New title" })],
    });

    expect(repopulate).toHaveBeenCalledOnce();
    expect(registry.getPanel("root")?.title).toBe("New title");
  });
});

describe("PanelOrchestrator.getBootstrapConfig", () => {
  it("returns the leased runtime connection id string", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const panel = makePanel("panel-1");
    registry.addPanel(panel, null, { addAsRoot: true });
    const { orchestrator, shellCore, panelView } = createOrchestrator(registry);

    await orchestrator.ensureLoaded(panel.id);
    const loadedUrl = panelView.createViewForPanel.mock.calls[0]?.[1] ?? "";

    const config = await orchestrator.getBootstrapConfig(panel.id);

    expect(shellCore.getPanelInit).toHaveBeenCalledWith(panel.id);
    expect(loadedUrl).not.toContain("connectionId=");
    expect(config).toMatchObject({
      entityId: panel.id,
      connectionId: expect.stringMatching(/^desktop-panel-1-/),
      clientLabel: "Desktop",
    });
  });
});

describe("PanelOrchestrator.applyRuntimeLeaseChanged", () => {
  it("unloads local panel resources when the local runtime lease is released", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const panel = makePanel("panel-1", [], {
      artifacts: {
        htmlPath: "http://localhost:1234/panels/panel-1/",
        buildState: "ready",
      },
    });
    registry.addPanel(panel, null, { addAsRoot: true });
    const { orchestrator, panelView, cdpHost } = createOrchestrator(registry);
    panelView.hasView.mockReturnValue(true);

    await orchestrator.applyRuntimeLeaseChanged({
      type: "panel:runtimeLeaseChanged",
      version: { epoch: "test", counter: 2 },
      slotId: asPanelSlotId(panel.id),
      runtimeEntityId: asPanelEntityId("panel:nav-panel-1"),
      previous: {
        slotId: asPanelSlotId(panel.id),
        runtimeEntityId: asPanelEntityId("panel:nav-panel-1"),
        clientSessionId: orchestrator.getRuntimeClientSessionId(),
        hostConnectionId: orchestrator.getRuntimeClientSessionId(),
        connectionId: "desktop-conn",
        holderLabel: "Desktop",
        platform: "desktop",
        supportsCdp: true,
        acquiredAt: 1,
      },
      next: null,
      reason: "retired",
    });

    expect(cdpHost.cleanupPanelAccess).toHaveBeenCalledWith(panel.id);
    expect(cdpHost.unregisterTarget).toHaveBeenCalledWith(panel.id);
    expect(panelView.destroyView).toHaveBeenCalledWith(panel.id);
    expect(registry.getPanel(panel.id)?.artifacts).toMatchObject({
      buildState: "pending",
      buildProgress: "Panel unloaded - will rebuild when focused",
    });
  });

  it("loads panels assigned to a load-on-assignment host without reacquiring the lease", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const panel = makePanel("panel-1");
    registry.addPanel(panel, null, { addAsRoot: true });
    const { orchestrator, panelView, serverClient } = createOrchestrator(registry, vi.fn(), {
      runtimeClient: {
        clientSessionId: "headless-session",
        label: "Headless",
        platform: "headless",
        supportsCdp: true,
        loadOnLeaseAssignment: true,
        restorePolicy: "none",
      },
    });

    await orchestrator.applyRuntimeLeaseChanged({
      type: "panel:runtimeLeaseChanged",
      version: { epoch: "test", counter: 2 },
      slotId: asPanelSlotId(panel.id),
      runtimeEntityId: asPanelEntityId("panel:nav-panel-1"),
      previous: null,
      next: {
        slotId: asPanelSlotId(panel.id),
        runtimeEntityId: asPanelEntityId("panel:nav-panel-1"),
        clientSessionId: "headless-session",
        hostConnectionId: "headless-session",
        connectionId: "assigned-runtime-conn",
        holderLabel: "Headless",
        platform: "headless",
        supportsCdp: true,
        acquiredAt: 1,
      },
      reason: "acquired",
    });

    expect(panelView.createViewForPanel).toHaveBeenCalledWith(
      panel.id,
      expect.not.stringContaining("connectionId="),
      "ctx-panel-1"
    );
    expect(serverClient.call).not.toHaveBeenCalledWith(
      "panelRuntime",
      "acquire",
      expect.any(Array)
    );
  });

  it("unloads idle panels assigned to a load-on-assignment host", async () => {
    vi.useFakeTimers();
    try {
      const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
      const panel = makePanel("panel-1");
      registry.addPanel(panel, null, { addAsRoot: true });
      const { orchestrator, serverClient } = createOrchestrator(registry, vi.fn(), {
        runtimeClient: {
          clientSessionId: "headless-session",
          label: "Headless",
          platform: "headless",
          supportsCdp: true,
          loadOnLeaseAssignment: true,
          assignedPanelIdleMs: 1000,
          restorePolicy: "none",
        },
      });

      await orchestrator.applyRuntimeLeaseChanged({
        type: "panel:runtimeLeaseChanged",
        version: { epoch: "test", counter: 2 },
        slotId: asPanelSlotId(panel.id),
        runtimeEntityId: asPanelEntityId("panel:nav-panel-1"),
        previous: null,
        next: {
          slotId: asPanelSlotId(panel.id),
          runtimeEntityId: asPanelEntityId("panel:nav-panel-1"),
          clientSessionId: "headless-session",
          hostConnectionId: "headless-session",
          connectionId: "assigned-runtime-conn",
          holderLabel: "Headless",
          platform: "headless",
          supportsCdp: true,
          acquiredAt: 1,
        },
        reason: "acquired",
      });

      await vi.advanceTimersByTimeAsync(1000);

      expect(serverClient.call).toHaveBeenCalledWith("panelRuntime", "release", [
        asPanelEntityId("panel:nav-panel-1"),
        "assigned-runtime-conn",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps load-on-assignment host resources by unloading the oldest assigned panel", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const first = makePanel("panel-1");
    const second = makePanel("panel-2");
    registry.addPanel(first, null, { addAsRoot: true });
    registry.addPanel(second, null, { addAsRoot: true });
    const { orchestrator, serverClient } = createOrchestrator(registry, vi.fn(), {
      runtimeClient: {
        clientSessionId: "headless-session",
        label: "Headless",
        platform: "headless",
        supportsCdp: true,
        loadOnLeaseAssignment: true,
        maxAssignedPanelViews: 1,
        assignedPanelIdleMs: 0,
        restorePolicy: "none",
      },
    });

    await orchestrator.applyRuntimeLeaseChanged({
      type: "panel:runtimeLeaseChanged",
      version: { epoch: "test", counter: 2 },
      slotId: asPanelSlotId(first.id),
      runtimeEntityId: asPanelEntityId("panel:nav-panel-1"),
      previous: null,
      next: {
        slotId: asPanelSlotId(first.id),
        runtimeEntityId: asPanelEntityId("panel:nav-panel-1"),
        clientSessionId: "headless-session",
        hostConnectionId: "headless-session",
        connectionId: "assigned-runtime-1",
        holderLabel: "Headless",
        platform: "headless",
        supportsCdp: true,
        acquiredAt: 1,
      },
      reason: "acquired",
    });
    await orchestrator.applyRuntimeLeaseChanged({
      type: "panel:runtimeLeaseChanged",
      version: { epoch: "test", counter: 3 },
      slotId: asPanelSlotId(second.id),
      runtimeEntityId: asPanelEntityId("panel:nav-panel-2"),
      previous: null,
      next: {
        slotId: asPanelSlotId(second.id),
        runtimeEntityId: asPanelEntityId("panel:nav-panel-2"),
        clientSessionId: "headless-session",
        hostConnectionId: "headless-session",
        connectionId: "assigned-runtime-2",
        holderLabel: "Headless",
        platform: "headless",
        supportsCdp: true,
        acquiredAt: 2,
      },
      reason: "acquired",
    });

    expect(serverClient.call).toHaveBeenCalledWith("panelRuntime", "release", [
      asPanelEntityId("panel:nav-panel-1"),
      "assigned-runtime-1",
    ]);
    expect(serverClient.call).not.toHaveBeenCalledWith("panelRuntime", "release", [
      asPanelEntityId("panel:nav-panel-2"),
      "assigned-runtime-2",
    ]);
  });

  it("does not implicitly load unloaded panels for agent introspection", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const panel = makePanel("panel-1");
    registry.addPanel(panel, null, { addAsRoot: true });
    const { orchestrator, panelView } = createOrchestrator(registry);

    await expect(orchestrator.snapshot(panel.id)).rejects.toThrow("target-not-loaded: panel-1");

    expect(panelView.createViewForPanel).not.toHaveBeenCalled();
  });
});
