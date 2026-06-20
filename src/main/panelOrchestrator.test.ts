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
    getViewPartition: vi.fn((_panelId: string) => undefined as string | undefined),
    setViewVisible: vi.fn((_panelId: string, _visible: boolean) => {}),
    destroyView: vi.fn((_panelId: string) => {}),
    reloadView: vi.fn((_panelId: string) => true),
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
    createBrowser: vi.fn(async (_parentId: string | null, url: string, _options?: unknown) => ({
      panelId: "created-browser",
      title: "created-browser",
      contextId: "ctx-created-browser",
      source: `browser:${url}`,
      options: {},
    })),
    updateTitle: vi.fn(async (_panelId: string, _title: string) => {}),
    onStateArgsChanged: vi.fn(() => () => {}),
    notifyFocused: vi.fn(async () => {}),
    getPanelInit: vi.fn(async (panelId: string) => ({
      entityId: panelId,
      gatewayConfig: { serverUrl: "http://127.0.0.1:1234", token: "token" },
    })),
    getCurrentEntityId: vi.fn(async (panelId: string) => `panel:nav-${panelId}`),
    refreshSlotEntity: vi.fn(async (panelId: string) => `panel:nav-${panelId}`),
    syncEntityCachesFromRegistry: vi.fn(() => {}),
    loadTree: vi.fn(async () => ({
      rootPanels: registry.getRootPanels(),
      collapsedIds: [],
    })),
  };
  let createCounter = 0;
  const handleServerCall = async (service: string, method: string, args?: unknown[]) => {
    if (method === "registerClient") return undefined;
    if (method === "acquire" || method === "takeOver") return { acquired: true };
    if (method === "getSnapshot") return { version: { epoch: "test", counter: 1 }, leases: [] };
    // Simulate the server panel-tree authority: create adds a panel to the
    // mirror (as the broadcast would) and returns its identity; archive removes
    // it. This lets the desktop orchestrator's panelTree create/close paths
    // resolve in tests.
    if (service === "panelTree" && method === "create") {
      const [src, opts] = (args ?? []) as [
        string,
        { parentId?: string | null; name?: string } | undefined,
      ];
      const isBrowser = /^https?:\/\//i.test(String(src));
      const id = `panel:tree/created-${++createCounter}`;
      const contextId = `ctx-${id}`;
      const snapshotSource = isBrowser ? `browser:${src}` : String(src);
      registry.addPanel(
        makePanel(id, [], {
          snapshot: { source: snapshotSource, contextId, options: {} },
          ...(isBrowser ? { artifacts: { buildState: "ready" } } : {}),
        }),
        opts?.parentId ?? null,
        { addAsRoot: opts?.parentId == null }
      );
      return {
        id,
        title: id,
        kind: isBrowser ? "browser" : "workspace",
        contextId,
        source: snapshotSource,
      };
    }
    if (service === "panelTree" && method === "archive") {
      const [id] = (args ?? []) as [string];
      registry.removePanel(String(id));
      return { closedIds: [String(id)] };
    }
    if (service === "panelTree" && method === "snapshot") {
      const [panelId] = (args ?? []) as [string];
      const panel = registry.getPanel(String(panelId));
      return panel ? getCurrentSnapshot(panel) : null;
    }
    return undefined;
  };
  const serverClient = {
    call: vi.fn(handleServerCall),
    callAs: vi.fn(
      async (
        _caller: { callerId: string; callerKind: string },
        service: string,
        method: string,
        args?: unknown[]
      ) => handleServerCall(service, method, args)
    ),
  };
  const cdpHost = {
    cleanupPanelAccess: vi.fn(),
    unregisterTarget: vi.fn(),
  };
  const sendPanelEvent = vi.fn();
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
    sendPanelEvent,
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
    sendPanelEvent,
  };
}

describe("PanelOrchestrator.closePanel", () => {
  it("registers the runtime host before CDP provider startup can claim its host id", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const { orchestrator, serverClient } = createOrchestrator(registry, vi.fn(), {
      runtimeClient: {
        clientSessionId: "host-session",
        platform: "headless",
        loadOnLeaseAssignment: true,
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
        loadOnLeaseAssignment: true,
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
        loadOnLeaseAssignment: true,
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
    const closingRoot = makePanel("panel:tree/closing-root");
    const nextRoot = makePanel("panel:tree/next-root");
    registry.addPanel(nextRoot, null, { addAsRoot: true });
    registry.addPanel(closingRoot, null, { addAsRoot: true });
    const focusedChild = makePanel("panel:tree/focused-child");
    registry.addPanel(focusedChild, closingRoot.id);
    registry.updateSelectedPath(focusedChild.id);

    const { orchestrator, emit, closedIds } = createOrchestrator(registry);
    closedIds.push(focusedChild.id);

    await orchestrator.closePanel(closingRoot.id);

    expect(emit).toHaveBeenCalledWith("navigate-to-panel", { panelId: nextRoot.id });
  });

  it("does not navigate when closing a sibling outside the focused subtree", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const root = makePanel("panel:tree/root");
    registry.addPanel(root, null, { addAsRoot: true });
    const sibling = makePanel("panel:tree/sibling");
    registry.addPanel(sibling, root.id);
    const focusedChild = makePanel("panel:tree/focused-child");
    registry.addPanel(focusedChild, root.id);
    registry.updateSelectedPath(focusedChild.id);

    const { orchestrator, emit } = createOrchestrator(registry);

    await orchestrator.closePanel(sibling.id);

    expect(emit).not.toHaveBeenCalledWith("navigate-to-panel", expect.anything());
  });

  it("routes close through the server authority (reactive prune handles teardown)", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const root = makePanel("panel:tree/root");
    registry.addPanel(root, null, { addAsRoot: true });
    const { orchestrator, serverClient } = createOrchestrator(registry);

    await orchestrator.closePanel(root.id);

    // The server closes the subtree + broadcasts; local view/lease teardown is
    // reactive (applyServerPanelTreeSnapshot → pruneRemovedPanelLocally, covered
    // by the prune test).
    expect(serverClient.call).toHaveBeenCalledWith("panelTree", "archive", [root.id]);
  });
});

describe("PanelOrchestrator.ensureLoaded", () => {
  it("loads a panel without selecting or focusing it", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const panel = makePanel("panel:tree/target");
    registry.addPanel(panel, null, { addAsRoot: true });

    const { orchestrator, panelView, shellCore, emit } = createOrchestrator(registry);
    let loaded = false;
    panelView.createViewForPanel.mockImplementationOnce(async () => {
      loaded = true;
    });
    panelView.hasView.mockImplementation(
      (panelId: string) => panelId === "panel:tree/target" && loaded
    );

    await expect(orchestrator.ensureLoaded("panel:tree/target")).resolves.toMatchObject({
      panelId: "panel:tree/target",
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
    const panel = makePanel("panel:tree/panel-1");
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
    const panel = makePanel("panel:tree/panel-1", [], {
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
      expect.stringContaining("/panels/panel%3Atree/panel-1/"),
      "ctx-panel:tree/panel-1"
    );
    expect(panelView.setViewVisible).toHaveBeenCalledWith(panel.id, true);
    expect(result).toMatchObject({ status: "loaded", focused: true, loaded: true });
  });

  it("acquires and releases runtime leases for browser panels", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const panel = makePanel("panel:tree/browser-1", [], {
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
    const panel = makePanel("panel:tree/panel-1", [], {
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
  it("rejects unscoped child panel creation instead of falling back to server authority", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const caller = makePanel("caller");
    registry.addPanel(caller, null, { addAsRoot: true });
    const { orchestrator, serverClient } = createOrchestrator(registry);

    await expect(orchestrator.createPanel(caller.id, "panels/created-panel")).rejects.toThrow(
      "Panel creation requires an authenticated panelTree caller"
    );
    expect(serverClient.call).not.toHaveBeenCalledWith("panelTree", "create", expect.anything());
  });

  it("focuses after creating the native view for focused panels", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const caller = makePanel("panel:tree/caller");
    registry.addPanel(caller, null, { addAsRoot: true });

    const { orchestrator, panelView, emit, serverClient } = createOrchestrator(registry);
    panelView.hasView.mockReturnValue(true);
    const scopedCaller = { callerId: "@workspace-apps/shell", callerKind: "app" as const };

    // Scoped panelTree create: the harness mock adds the panel to the mirror
    // and returns its identity; the desktop builds the view from the response.
    const { id } = await orchestrator.createPanel(
      caller.id,
      "panels/created-panel",
      {
        focus: true,
      },
      undefined,
      scopedCaller
    );

    expect(serverClient.callAs).toHaveBeenCalledWith(scopedCaller, "panelTree", "create", [
      "panels/created-panel",
      expect.objectContaining({ parentId: caller.id }),
    ]);
    expect(panelView.createViewForPanel).toHaveBeenCalledWith(
      id,
      expect.stringContaining("/panels/created-panel/"),
      `ctx-${id}`
    );
    expect(panelView.setViewVisible).toHaveBeenCalledWith(id, true);
    expect(emit).toHaveBeenCalledWith("navigate-to-panel", { panelId: id });
    expect(panelView.createViewForPanel.mock.invocationCallOrder[0]).toBeLessThan(
      panelView.setViewVisible.mock.invocationCallOrder[0] ?? 0
    );
  });

  it("acquires a runtime lease before creating browser panel views", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const caller = makePanel("panel:tree/caller");
    registry.addPanel(caller, null, { addAsRoot: true });

    const { orchestrator, panelView, serverClient } = createOrchestrator(registry);
    const scopedCaller = { callerId: "@workspace-apps/shell", callerKind: "app" as const };

    const { id } = await orchestrator.createBrowserUrlPanel(
      caller.id,
      "https://example.com/",
      {
        focus: false,
      },
      scopedCaller
    );

    const acquireCallIndex = serverClient.call.mock.calls.findIndex(
      ([service, method]) => service === "panelRuntime" && method === "acquire"
    );
    expect(acquireCallIndex).toBeGreaterThanOrEqual(0);
    expect(serverClient.call).toHaveBeenCalledWith("panelRuntime", "acquire", [
      `panel:nav-${id}`,
      expect.objectContaining({
        slotId: id,
        clientSessionId: orchestrator.getRuntimeClientSessionId(),
      }),
    ]);
    expect(panelView.createViewForBrowser).toHaveBeenCalledWith(
      id,
      "https://example.com/",
      `ctx-${id}`
    );
    const acquireOrder = serverClient.call.mock.invocationCallOrder[acquireCallIndex];
    const createViewOrder = panelView.createViewForBrowser.mock.invocationCallOrder[0];
    expect(acquireOrder).toBeDefined();
    expect(createViewOrder).toBeDefined();
    expect(acquireOrder!).toBeLessThan(createViewOrder!);
  });

  it("rejects unscoped browser child creation instead of falling back to server authority", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const caller = makePanel("panel:tree/caller");
    registry.addPanel(caller, null, { addAsRoot: true });
    const { orchestrator, serverClient } = createOrchestrator(registry);

    await expect(
      orchestrator.createBrowserUrlPanel(caller.id, "https://example.com/")
    ).rejects.toThrow("Browser panel creation requires an authenticated panelTree caller");
    expect(serverClient.call).not.toHaveBeenCalledWith("panelTree", "create", expect.anything());
  });

  it("releases the browser panel runtime lease when native browser view creation fails", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const caller = makePanel("panel:tree/caller");
    registry.addPanel(caller, null, { addAsRoot: true });

    const { orchestrator, panelView, serverClient } = createOrchestrator(registry);
    panelView.createViewForBrowser.mockRejectedValueOnce(new Error("native view failed"));
    const scopedCaller = { callerId: "@workspace-apps/shell", callerKind: "app" as const };

    await expect(
      orchestrator.createBrowserUrlPanel(
        caller.id,
        "https://example.com/",
        {
          focus: false,
        },
        scopedCaller
      )
    ).rejects.toThrow("native view failed");

    const acquireCall = serverClient.call.mock.calls.find(
      ([service, method]) => service === "panelRuntime" && method === "acquire"
    );
    expect(acquireCall).toBeDefined();
    // The harness assigns the first server-created panel id "panel:tree/created-1"; on browser
    // view failure attachCreatedPanel releases its lease before rethrowing.
    expect(serverClient.call).toHaveBeenCalledWith("panelRuntime", "release", [
      "panel:nav-panel:tree/created-1",
      expect.stringMatching(/^desktop-panel:tree\/created-1-/),
    ]);
    // ...and the scoped create path archives the orphaned slot with the same caller.
    expect(serverClient.callAs).toHaveBeenCalledWith(scopedCaller, "panelTree", "archive", [
      "panel:tree/created-1",
    ]);
  });
});

describe("PanelOrchestrator.applyBuildComplete", () => {
  it("updates duplicate-source slots without pretending unloaded slots have native views", () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const first = makePanel("panel:tree/slot-a", [], {
      snapshot: {
        source: "panels/chat",
        contextId: "ctx-a",
        options: {},
      },
      artifacts: { buildState: "building", buildProgress: "Waiting for build..." },
    });
    const second = makePanel("panel:tree/slot-b", [], {
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

describe("PanelOrchestrator.rebuildPanel", () => {
  it("forces a rebuild for the named panel without rebuilding child panels", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const child = makePanel("panel:tree/child", [], {
      snapshot: {
        source: "panels/child",
        contextId: "ctx-panel:tree/child",
        options: {},
      },
      artifacts: { buildState: "ready", buildRevision: 7 },
    });
    const parent = makePanel("panel:tree/parent", [], {
      snapshot: {
        source: "panels/parent",
        contextId: "ctx-panel:tree/parent",
        options: {},
      },
      artifacts: { buildState: "ready", buildRevision: 3 },
    });
    registry.addPanel(parent, null, { addAsRoot: true });
    registry.addPanel(child, parent.id);

    const { orchestrator, panelView, panelHttpServer } = createOrchestrator(registry);
    panelView.hasView.mockReturnValue(true);

    const result = await orchestrator.rebuildPanel(parent.id);

    expect(panelHttpServer.invalidateBuild).toHaveBeenCalledWith("panels/parent");
    expect(panelHttpServer.invalidateBuild).not.toHaveBeenCalledWith("panels/child");
    expect(panelView.createViewForPanel).toHaveBeenCalledTimes(1);
    expect(panelView.createViewForPanel).toHaveBeenCalledWith(
      parent.id,
      expect.stringContaining("/panels/parent/"),
      "ctx-panel:tree/parent"
    );
    expect(registry.getPanel(parent.id)?.artifacts).toMatchObject({
      buildState: "building",
      buildProgress: "Rebuilding panel...",
    });
    expect(registry.getPanel(child.id)?.artifacts).toMatchObject({
      buildState: "ready",
      buildRevision: 7,
    });
    expect(result).toMatchObject({
      panelId: parent.id,
      operation: "rebuild",
      status: "rebuild_requested",
      rebuilt: true,
      reloaded: false,
    });
  });

  it("rebuilds and reloads only the named panel", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const parent = makePanel("panel:tree/parent", [], {
      snapshot: {
        source: "panels/parent",
        contextId: "ctx-panel:tree/parent",
        options: {},
      },
      artifacts: { buildState: "ready", buildRevision: 3 },
    });
    const child = makePanel("panel:tree/child", [], {
      snapshot: {
        source: "panels/child",
        contextId: "ctx-panel:tree/child",
        options: {},
      },
      artifacts: { buildState: "ready", buildRevision: 7 },
    });
    registry.addPanel(parent, null, { addAsRoot: true });
    registry.addPanel(child, parent.id);

    const { orchestrator, panelView, panelHttpServer } = createOrchestrator(registry);
    panelView.hasView.mockImplementation((panelId: string) => panelId === parent.id);

    const result = await orchestrator.rebuildAndReloadPanel(parent.id);

    expect(panelHttpServer.invalidateBuild).toHaveBeenCalledWith("panels/parent");
    expect(panelHttpServer.invalidateBuild).not.toHaveBeenCalledWith("panels/child");
    expect(panelView.reloadView).toHaveBeenCalledWith(parent.id);
    expect(panelView.reloadView).not.toHaveBeenCalledWith(child.id);
    expect(panelView.destroyView).not.toHaveBeenCalledWith(child.id);
    expect(result).toMatchObject({
      panelId: parent.id,
      operation: "rebuildAndReload",
      status: "rebuilt_and_reloaded",
      loaded: true,
      rebuilt: true,
      reloaded: true,
    });
  });
});

describe("PanelOrchestrator.recoverShellSnapshot", () => {
  it("syncs tree and leases, resolves focus, and publishes one normalized snapshot", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const root = makePanel("panel:tree/root");
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
    const root = makePanel("panel:tree/root", [], { artifacts: { buildState: "pending" } });
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
      expect.stringContaining("/panels/panel%3Atree/root/"),
      "ctx-panel:tree/root"
    );
    expect(snapshot.focus).toMatchObject({ status: "loaded", loaded: true });
  });

  it("can restore only tree state when policy is none", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const root = makePanel("panel:tree/root", [], { artifacts: { buildState: "pending" } });
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
    const { orchestrator, serverClient } = createOrchestrator(registry, vi.fn(), {
      workspaceConfig: {
        id: "test",
        panelRestorePolicy: "none",
        initPanels: [
          { source: "panels/chat", stateArgs: { initialPrompt: "first" } },
          { source: "panels/chat", stateArgs: { initialPrompt: "second" } },
        ],
      } as never,
    });

    await orchestrator.initializePanelTree();

    // Init-panel creation routes through the server authority (panelTree.create);
    // each call yields a distinct root in the broadcast mirror.
    const createCalls = serverClient.call.mock.calls.filter(
      ([service, method]) => service === "panelTree" && method === "create"
    );
    expect(createCalls).toHaveLength(2);
    expect(createCalls.map((c) => (c[2] as unknown[])[0])).toEqual(["panels/chat", "panels/chat"]);
    expect(registry.getRootPanels().map((panel) => panel.id)).toEqual([
      "panel:tree/created-1",
      "panel:tree/created-2",
    ]);
  });
});

describe("PanelOrchestrator.applyServerPanelTreeSnapshot", () => {
  it("ignores server echo snapshots that match the optimistic local tree", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const root = makePanel("panel:tree/root", [], {
      title: "Runtime title",
      artifacts: { buildState: "ready", htmlPath: "http://localhost/panels/panel:tree/root/" },
    });
    registry.addPanel(root, null, { addAsRoot: true });
    const { orchestrator, serverClient } = createOrchestrator(registry);
    const repopulate = vi.spyOn(registry, "repopulate");

    await orchestrator.applyServerPanelTreeSnapshot({
      revision: 1,
      rootPanels: [
        makePanel("panel:tree/root", [], {
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
    registry.addPanel(makePanel("panel:tree/root", [], { title: "Old title" }), null, {
      addAsRoot: true,
    });
    const { orchestrator } = createOrchestrator(registry);
    const repopulate = vi.spyOn(registry, "repopulate");

    await orchestrator.applyServerPanelTreeSnapshot({
      revision: 1,
      rootPanels: [
        makePanel("panel:tree/root", [makePanel("panel:tree/child")], { title: "New title" }),
      ],
    });

    expect(repopulate).toHaveBeenCalledOnce();
    expect(registry.getPanel("panel:tree/root")?.title).toBe("New title");
    expect(registry.getPanel("panel:tree/child")).toBeDefined();
  });

  it("prunes the local view of a panel removed from the authoritative tree", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    registry.repopulate([makePanel("panel:tree/root", [makePanel("panel:tree/child")])]);
    const { orchestrator, panelView } = createOrchestrator(registry);
    // The child currently has a live view hosted on this desktop.
    panelView.hasView.mockImplementation((id: string) => id === "panel:tree/child");

    await orchestrator.applyServerPanelTreeSnapshot({
      revision: 1,
      rootPanels: [makePanel("panel:tree/root")], // child closed by another client
    });

    expect(registry.getPanel("panel:tree/child")).toBeUndefined();
    expect(panelView.destroyView).toHaveBeenCalledWith("panel:tree/child");
  });

  it("reloads a hosted panel's view when the authoritative snapshot navigated it", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    registry.repopulate([makePanel("panel:tree/root")]); // source panels/root, ctx-root
    const { orchestrator, panelView } = createOrchestrator(registry);
    // The desktop currently hosts a live view for this panel.
    panelView.hasView.mockImplementation((id: string) => id === "panel:tree/root");

    await orchestrator.applyServerPanelTreeSnapshot({
      revision: 1,
      rootPanels: [
        makePanel("panel:tree/root", [], {
          // Server navigated the panel to a new source/context (it is the sole
          // writer); the desktop view-host must reload the view reactively.
          snapshot: { source: "panels/other", contextId: "ctx-other", options: {} },
        }),
      ],
    });

    expect(panelView.createViewForPanel).toHaveBeenCalled();
    const lastCall = panelView.createViewForPanel.mock.calls.at(-1);
    expect(lastCall?.[0]).toBe("panel:tree/root");
  });

  it("pushes state-args-only authoritative changes to hosted panels", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    registry.repopulate([
      makePanel("root", [], {
        snapshot: {
          source: "panels/root",
          contextId: "ctx-root",
          options: {},
          stateArgs: { mode: "old" },
        },
      }),
    ]);
    const { orchestrator, panelView, sendPanelEvent } = createOrchestrator(registry);
    panelView.hasView.mockImplementation((id: string) => id === "root");

    await orchestrator.applyServerPanelTreeSnapshot({
      revision: 1,
      rootPanels: [
        makePanel("root", [], {
          snapshot: {
            source: "panels/root",
            contextId: "ctx-root",
            options: {},
            stateArgs: { mode: "new" },
          },
        }),
      ],
    });

    expect(sendPanelEvent).toHaveBeenCalledWith("root", "runtime:stateArgsChanged", {
      mode: "new",
    });
    expect(panelView.createViewForPanel).not.toHaveBeenCalled();
  });

  it("patches title-only server snapshots without repopulating the tree", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    registry.addPanel(makePanel("panel:tree/root", [], { title: "Old title" }), null, {
      addAsRoot: true,
    });
    const { orchestrator, serverClient } = createOrchestrator(registry);
    const repopulate = vi.spyOn(registry, "repopulate");

    await orchestrator.applyServerPanelTreeSnapshot({
      revision: 1,
      rootPanels: [makePanel("panel:tree/root", [], { title: "New title" })],
    });

    expect(repopulate).not.toHaveBeenCalled();
    expect(serverClient.call).not.toHaveBeenCalledWith("panelRuntime", "getSnapshot", []);
    expect(registry.getPanel("panel:tree/root")?.title).toBe("New title");
  });

  it("treats workspace external navigation state as non-semantic snapshot drift", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    registry.addPanel(
      makePanel("panel:tree/root", [], {
        title: "Runtime title",
        navigation: {
          url: "https://example.com/",
          pageTitle: "Example Domain",
          isLoading: false,
          canGoBack: false,
          canGoForward: false,
        },
        snapshot: {
          source: "panels/root",
          contextId: "ctx-panel:tree/root",
          options: {},
          resolvedUrl: "https://example.com/",
        },
      }),
      null,
      { addAsRoot: true }
    );
    const { orchestrator, serverClient } = createOrchestrator(registry);
    const repopulate = vi.spyOn(registry, "repopulate");

    await orchestrator.applyServerPanelTreeSnapshot({
      revision: 1,
      rootPanels: [
        makePanel("panel:tree/root", [], {
          title: "Runtime title",
          snapshot: {
            source: "panels/root",
            contextId: "ctx-panel:tree/root",
            options: {},
          },
        }),
      ],
    });

    expect(repopulate).not.toHaveBeenCalled();
    expect(serverClient.call).not.toHaveBeenCalledWith("panelRuntime", "getSnapshot", []);
    expect(getCurrentSnapshot(registry.getPanel("panel:tree/root")!).source).toBe("panels/root");
    expect(getCurrentSnapshot(registry.getPanel("panel:tree/root")!).resolvedUrl).toBe(
      "https://example.com/"
    );
  });

  it("prevents non-explicit server title updates from overwriting explicit runtime titles", () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    registry.addPanel(makePanel("panel:tree/root", [], { title: "Old title" }), null, {
      addAsRoot: true,
    });
    const { orchestrator } = createOrchestrator(registry);

    orchestrator.applyServerPanelTitleUpdate({
      panelId: "panel:tree/root",
      title: "Explicit title",
      explicit: true,
    });
    orchestrator.applyServerPanelTitleUpdate({
      panelId: "panel:tree/root",
      title: "Agentic Chat",
    });

    expect(registry.getPanel("panel:tree/root")?.title).toBe("Explicit title");
  });

  it("prevents title-only server snapshots from overwriting explicit runtime titles", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    registry.addPanel(makePanel("panel:tree/root", [], { title: "Old title" }), null, {
      addAsRoot: true,
    });
    const { orchestrator, serverClient } = createOrchestrator(registry);
    const repopulate = vi.spyOn(registry, "repopulate");

    orchestrator.applyServerPanelTitleUpdate({
      panelId: "panel:tree/root",
      title: "Explicit title",
      explicit: true,
    });
    await orchestrator.applyServerPanelTreeSnapshot({
      revision: 1,
      rootPanels: [makePanel("panel:tree/root", [], { title: "Agentic Chat" })],
    });

    expect(repopulate).not.toHaveBeenCalled();
    expect(serverClient.call).not.toHaveBeenCalledWith("panelRuntime", "getSnapshot", []);
    expect(registry.getPanel("panel:tree/root")?.title).toBe("Explicit title");
  });

  it("preserves explicit runtime titles when applying structural server snapshots", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    registry.addPanel(makePanel("panel:tree/root", [], { title: "Old title" }), null, {
      addAsRoot: true,
    });
    const { orchestrator } = createOrchestrator(registry);
    const repopulate = vi.spyOn(registry, "repopulate");

    orchestrator.applyServerPanelTitleUpdate({
      panelId: "panel:tree/root",
      title: "Explicit title",
      explicit: true,
    });
    await orchestrator.applyServerPanelTreeSnapshot({
      revision: 1,
      rootPanels: [
        makePanel("panel:tree/root", [makePanel("panel:tree/child")], { title: "Agentic Chat" }),
      ],
    });

    expect(repopulate).toHaveBeenCalledOnce();
    expect(registry.getPanel("panel:tree/root")?.title).toBe("Explicit title");
    expect(registry.getPanel("panel:tree/child")).toBeDefined();
  });

  it("prevents page-title fallback updates from overwriting explicit runtime titles", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    registry.addPanel(makePanel("panel:tree/root", [], { title: "Old title" }), null, {
      addAsRoot: true,
    });
    const { orchestrator, shellCore } = createOrchestrator(registry);

    orchestrator.applyServerPanelTitleUpdate({
      panelId: "panel:tree/root",
      title: "Explicit title",
      explicit: true,
    });
    await orchestrator.updatePanelTitle("panel:tree/root", "Fallback page title");

    expect(shellCore.updateTitle).not.toHaveBeenCalled();
    expect(registry.getPanel("panel:tree/root")?.title).toBe("Explicit title");
  });
});

describe("PanelOrchestrator.getBootstrapConfig", () => {
  it("returns the leased runtime connection id string", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const panel = makePanel("panel:tree/panel-1");
    registry.addPanel(panel, null, { addAsRoot: true });
    const { orchestrator, shellCore, panelView } = createOrchestrator(registry);

    await orchestrator.ensureLoaded(panel.id);
    const loadedUrl = panelView.createViewForPanel.mock.calls[0]?.[1] ?? "";

    const config = await orchestrator.getBootstrapConfig(panel.id);

    expect(shellCore.getPanelInit).toHaveBeenCalledWith(panel.id);
    expect(loadedUrl).not.toContain("connectionId=");
    expect(config).toMatchObject({
      entityId: panel.id,
      connectionId: expect.stringMatching(/^desktop-panel:tree\/panel-1-/),
      clientLabel: "Desktop",
    });
  });
});

describe("PanelOrchestrator.handleRuntimeLeaseChanged", () => {
  it("unloads local panel resources when the local runtime lease is released", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const panel = makePanel("panel:tree/panel-1", [], {
      artifacts: {
        htmlPath: "http://localhost:1234/panels/panel:tree/panel-1/",
        buildState: "ready",
      },
    });
    registry.addPanel(panel, null, { addAsRoot: true });
    const { orchestrator, panelView, cdpHost } = createOrchestrator(registry);
    panelView.hasView.mockReturnValue(true);

    await orchestrator.handleRuntimeLeaseChanged({
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
        loadOnLeaseAssignment: false,
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
    const panel = makePanel("panel:tree/panel-1");
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

    await orchestrator.handleRuntimeLeaseChanged({
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
        loadOnLeaseAssignment: true,
        supportsCdp: true,
        acquiredAt: 1,
      },
      reason: "acquired",
    });

    expect(panelView.createViewForPanel).toHaveBeenCalledWith(
      panel.id,
      expect.not.stringContaining("connectionId="),
      "ctx-panel:tree/panel-1"
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
      const panel = makePanel("panel:tree/panel-1");
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

      await orchestrator.handleRuntimeLeaseChanged({
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
          loadOnLeaseAssignment: true,
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
    const first = makePanel("panel:tree/panel-1");
    const second = makePanel("panel:tree/panel-2");
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

    await orchestrator.handleRuntimeLeaseChanged({
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
        loadOnLeaseAssignment: true,
        supportsCdp: true,
        acquiredAt: 1,
      },
      reason: "acquired",
    });
    await orchestrator.handleRuntimeLeaseChanged({
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
        loadOnLeaseAssignment: true,
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

  it("routes panel snapshots through panelTree without loading local views", async () => {
    const registry = new PanelRegistry({ onTreeUpdated: vi.fn() });
    const panel = makePanel("panel:tree/panel-1");
    registry.addPanel(panel, null, { addAsRoot: true });
    const { orchestrator, panelView, serverClient } = createOrchestrator(registry);

    await expect(orchestrator.snapshot(panel.id)).resolves.toEqual(getCurrentSnapshot(panel));

    expect(serverClient.call).toHaveBeenCalledWith("panelTree", "snapshot", [panel.id]);
    expect(panelView.createViewForPanel).not.toHaveBeenCalled();
  });
});
