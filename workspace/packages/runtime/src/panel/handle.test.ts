import { beforeEach, describe, expect, it, vi } from "vitest";

function createRpcCall() {
  return vi.fn(async (_target: string, method: string, args: unknown[]) => {
    switch (method) {
      case "panelTree.create": {
        const source = args[0] as string;
        return {
          id: source.startsWith("http") ? "browser-1" : "panel-1",
          title: "Created",
          kind: source.startsWith("http") ? "browser" : "workspace",
        };
      }
      case "panelTree.list": {
        const parentId = args[0] as string | null | undefined;
        return parentId
          ? [
              {
                panelId: "child-1",
                title: "Child",
                source: "panels/child",
                kind: "workspace",
                parentId,
                contextId: "ctx",
                runtimeEntityId: "panel:child-entity",
                effectiveVersion: "ev-child",
              },
            ]
          : [
              {
                panelId: "browser-1",
                title: "Browser",
                source: "browser:https://example.com",
                kind: "browser",
                parentId: null,
                contextId: "ctx",
                runtimeEntityId: "panel:browser-entity",
                effectiveVersion: "ev-browser",
              },
            ];
      }
      case "panelTree.roots":
        return [
          {
            panelId: "root-1",
            title: "Root",
            source: "panels/root",
            kind: "workspace",
            parentId: null,
            contextId: "ctx",
            runtimeEntityId: "panel:root-entity",
            effectiveVersion: "ev-root",
          },
        ];
      case "panelTree.metadata":
        return {
          id: args[0],
          title: String(args[0]).includes("parent") ? "Parent" : "Panel",
          source: String(args[0]).includes("parent") ? "panels/parent" : "panels/self",
          kind: "workspace",
          parentId: String(args[0]).includes("parent") ? null : "panel-parent",
          contextId: "ctx-meta",
          runtimeEntityId: `panel:${String(args[0])}-entity`,
          effectiveVersion: `ev-${String(args[0])}`,
        };
      case "panelCdp.getCdpEndpoint":
        return { wsEndpoint: "ws://localhost", token: "t" };
      case "panelCdp.consoleHistory":
        return {
          entries: [
            {
              timestamp: 1,
              level: "info",
              message: "loaded",
              line: 1,
              sourceId: "app.tsx",
              url: "https://example.com",
            },
          ],
          errors: [],
          dropped: { entries: 0, errors: 0 },
          capacity: { entries: 1000, errors: 500 },
        };
      case "panelTree.reload":
        return {
          panelId: args[0],
          operation: "reload",
          status: "reloaded",
          loaded: true,
          rebuilt: false,
          reloaded: true,
        };
      case "panelTree.rebuildPanel":
        return {
          panelId: args[0],
          operation: "rebuild",
          status: "rebuild_requested",
          loaded: true,
          rebuilt: true,
          reloaded: false,
        };
      case "panelTree.rebuildAndReload":
        return {
          panelId: args[0],
          operation: "rebuildAndReload",
          status: "rebuilt_and_reloaded",
          loaded: true,
          rebuilt: true,
          reloaded: true,
        };
      case "panelTree.navigate":
        return {
          id: args[0],
          title: "Navigated",
        };
      default:
        return undefined;
    }
  });
}

describe("PanelHandle", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("@workspace/cdp-client");
    delete (globalThis as any).__natstackShell;
    delete (globalThis as any).__natstackRequire__;
    delete (globalThis as any).__natstackRequireAsync__;
    delete (globalThis as any).__natstackLoadImport__;
  });

  it("returns a workspace handle from openPanel", async () => {
    const { _initPanelHandleBridge, openPanel } = await import("./handle.js");
    _initPanelHandleBridge({ call: createRpcCall(), on: vi.fn() } as never);

    const handle = await openPanel("panels/example");

    expect(handle).toMatchObject({
      id: "panel-1",
      title: "Created",
      source: "panels/example",
      kind: "workspace",
    });
    await expect(handle.cdp.getCdpEndpoint()).resolves.toEqual({
      wsEndpoint: "ws://localhost",
      token: "t",
    });
    await expect(handle.cdp.consoleHistory()).resolves.toMatchObject({
      capacity: { entries: 1000, errors: 500 },
    });
  });

  it("defaults panel opens under self but treats parentId null as root", async () => {
    const { _initPanelHandleBridge, openPanel } = await import("./handle.js");
    const rpcCall = createRpcCall();
    _initPanelHandleBridge({ call: rpcCall, on: vi.fn() } as never, {
      selfId: "panel-self",
    });

    await openPanel("panels/child");
    await openPanel("panels/root", { parentId: null });

    expect(rpcCall).toHaveBeenCalledWith("main", "panelTree.create", [
      "panels/child",
      { parentId: "panel-self" },
    ]);
    expect(rpcCall).toHaveBeenCalledWith("main", "panelTree.create", [
      "panels/root",
      { parentId: null },
    ]);
  });

  it("hydrates rediscovered browser handles with CDP automation", async () => {
    const { _initPanelHandleBridge, listPanels } = await import("./handle.js");
    _initPanelHandleBridge({ call: createRpcCall(), on: vi.fn() } as never);

    const [handle] = await listPanels();

    expect(handle?.kind).toBe("browser");
    expect(handle?.source).toBe("https://example.com");
    await expect(handle?.cdp.getCdpEndpoint()).resolves.toEqual({
      wsEndpoint: "ws://localhost",
      token: "t",
    });
  });

  it("routes hydrated handle RPC to the current runtime entity", async () => {
    const rpcCall = createRpcCall();
    const rpcEmit = vi.fn(async () => undefined);
    const eventHandlers: Array<
      (event: { caller: { callerId: string }; payload: unknown }) => void
    > = [];
    const rpcOn = vi.fn(
      (
        _event: string,
        handler: (event: { caller: { callerId: string }; payload: unknown }) => void
      ) => {
        eventHandlers.push(handler);
        return vi.fn();
      }
    );
    const { _initPanelHandleBridge, panelTree } = await import("./handle.js");
    _initPanelHandleBridge({ call: rpcCall, emit: rpcEmit, on: rpcOn } as never);

    const [child] = await panelTree.children("parent-1");
    expect(child).toBeDefined();
    await (child!.call as Record<string, () => Promise<unknown>>)["ping"]!();
    await child!.emit("ready", { ok: true });
    const listener = vi.fn();
    child!.on("status", listener);
    eventHandlers[0]?.({ caller: { callerId: "panel:other-entity" }, payload: { ignored: true } });
    eventHandlers[0]?.({ caller: { callerId: "panel:child-entity" }, payload: { ok: true } });

    expect(rpcCall).toHaveBeenCalledWith("panel:child-entity", "ping", []);
    expect(rpcEmit).toHaveBeenCalledWith("panel:child-entity", "ready", { ok: true });
    expect(rpcOn).toHaveBeenCalledWith("status", expect.any(Function));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ ok: true });
  });

  it("keeps child contract handles unified with the underlying panel target", async () => {
    const rpcCall = createRpcCall();
    const rpcEmit = vi.fn(async () => undefined);
    const { _initPanelHandleBridge, panelTree } = await import("./handle.js");
    _initPanelHandleBridge({ call: rpcCall, emit: rpcEmit, on: vi.fn() } as never);

    const [child] = await panelTree.children("parent-1");
    const typedChild = child!.withContract({ source: "panels/child" }, "child");

    expect(typedChild).toBe(child);
    expect(typedChild.id).toBe("child-1");
    await (typedChild.call as Record<string, () => Promise<unknown>>)["ping"]!();
    await typedChild.emit("ready", { ok: true });
    await expect(typedChild.cdp.getCdpEndpoint()).resolves.toEqual({
      wsEndpoint: "ws://localhost",
      token: "t",
    });
    await typedChild.stateArgs.set({ mode: "live" });

    expect(rpcCall).toHaveBeenCalledWith("panel:child-entity", "ping", []);
    expect(rpcEmit).toHaveBeenCalledWith("panel:child-entity", "ready", { ok: true });
    expect(rpcCall).toHaveBeenCalledWith("main", "panelTree.setStateArgs", [
      "child-1",
      { mode: "live" },
    ]);
  });

  it("exposes panelTree roots/list/get and self handles", async () => {
    const { _initPanelHandleBridge, panelTree } = await import("./handle.js");
    const rpcCall = createRpcCall();
    _initPanelHandleBridge({ call: rpcCall, on: vi.fn() } as never, {
      selfId: "panel-self",
      selfRpcTargetId: "panel:self-entity",
      parentId: "panel-parent",
      parentRpcTargetId: "panel:parent-entity",
    });

    const roots = await panelTree.roots();
    const all = await panelTree.list();
    const self = panelTree.self();
    const parent = self.parent();

    expect(roots).toHaveLength(1);
    expect(roots[0]?.id).toBe("root-1");
    await expect(roots[0]?.getInfo()).resolves.toMatchObject({
      runtimeEntityId: "panel:root-entity",
      effectiveVersion: "ev-root",
    });
    expect(all.map((handle) => handle.id)).toEqual(["browser-1"]);
    expect(panelTree.get("arbitrary").id).toBe("arbitrary");
    expect(self.id).toBe("panel-self");
    await expect(self.getInfo()).resolves.toMatchObject({
      id: "panel-self",
      parentId: "panel-parent",
    });
    await (self.call as Record<string, () => Promise<unknown>>)["ping"]!();
    expect(rpcCall).toHaveBeenCalledWith("panel:self-entity", "ping", []);
    expect(parent?.id).toBe("panel-parent");
    await expect(parent?.getInfo()).resolves.toMatchObject({
      id: "panel-parent",
      parentId: null,
    });
    await (parent!.call as Record<string, () => Promise<unknown>>)["ping"]!();
    expect(rpcCall).toHaveBeenCalledWith("panel:parent-entity", "ping", []);
  });

  it("lazily resolves arbitrary panel handles before target RPC", async () => {
    const { _initPanelHandleBridge, panelTree } = await import("./handle.js");
    const rpcCall = createRpcCall();
    const rpcEmit = vi.fn(async () => undefined);
    _initPanelHandleBridge({ call: rpcCall, emit: rpcEmit, on: vi.fn() } as never);

    const handle = panelTree.get("arbitrary");
    await (handle.call as Record<string, () => Promise<unknown>>)["ping"]!();
    await handle.emit("ready", { ok: true });

    expect(rpcCall).toHaveBeenCalledWith("main", "panelTree.metadata", ["arbitrary"]);
    expect(rpcCall).toHaveBeenCalledWith("panel:arbitrary-entity", "ping", []);
    expect(rpcEmit).toHaveBeenCalledWith("panel:arbitrary-entity", "ready", { ok: true });
  });

  it("resolves arbitrary panel event targets once and filters synchronously afterward", async () => {
    const { _initPanelHandleBridge, panelTree } = await import("./handle.js");
    let resolveMetadata!: (value: unknown) => void;
    const metadataPromise = new Promise<unknown>((resolve) => {
      resolveMetadata = resolve;
    });
    const rpcCall = vi.fn(async (_target: string, method: string) => {
      if (method === "panelTree.metadata") return metadataPromise;
      return undefined;
    });
    const eventHandlers: Array<
      (event: { caller: { callerId: string }; payload: unknown }) => void
    > = [];
    const rpcOn = vi.fn(
      (
        _event: string,
        handler: (event: { caller: { callerId: string }; payload: unknown }) => void
      ) => {
        eventHandlers.push(handler);
        return vi.fn();
      }
    );
    _initPanelHandleBridge({ call: rpcCall, on: rpcOn } as never);

    const handle = panelTree.get("arbitrary-events");
    const listener = vi.fn();
    handle.on("status", listener);

    for (let i = 0; i < 5; i += 1) {
      eventHandlers[0]?.({
        caller: { callerId: "panel:arbitrary-events-entity" },
        payload: { before: i },
      });
    }
    expect(rpcCall).toHaveBeenCalledTimes(1);
    expect(rpcCall).toHaveBeenCalledWith("main", "panelTree.metadata", ["arbitrary-events"]);
    expect(listener).not.toHaveBeenCalled();

    resolveMetadata({
      id: "arbitrary-events",
      title: "Events",
      source: "panels/events",
      kind: "workspace",
      parentId: null,
      runtimeEntityId: "panel:arbitrary-events-entity",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    eventHandlers[0]?.({
      caller: { callerId: "panel:other-entity" },
      payload: { ignored: true },
    });
    eventHandlers[0]?.({
      caller: { callerId: "panel:arbitrary-events-entity" },
      payload: { ok: true },
    });

    expect(rpcCall).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ ok: true });
  });

  it("targets parent slot, not self, when navigating, reloading, and rebuilding parent handles", async () => {
    const { _initPanelHandleBridge, panelTree } = await import("./handle.js");
    const rpcCall = createRpcCall();
    _initPanelHandleBridge({ call: rpcCall, on: vi.fn() } as never, {
      selfId: "panel-self",
      selfRpcTargetId: "panel:self-entity",
      parentId: "panel-parent",
      parentRpcTargetId: "panel:parent-entity",
    });

    const parent = panelTree.self().parent();
    await expect(parent?.rebuildPanel()).resolves.toMatchObject({
      panelId: "panel-parent",
      operation: "rebuild",
    });
    await expect(parent?.reload()).resolves.toMatchObject({
      panelId: "panel-parent",
      operation: "reload",
    });
    await expect(parent?.rebuildAndReload()).resolves.toMatchObject({
      panelId: "panel-parent",
      operation: "rebuildAndReload",
    });
    await expect(
      parent?.navigate("panels/next", { contextId: "ctx-next", stateArgs: { mode: "live" } })
    ).resolves.toEqual({ id: "panel-parent", title: "Navigated" });

    expect(rpcCall).toHaveBeenCalledWith("main", "panelTree.rebuildPanel", ["panel-parent"]);
    expect(rpcCall).toHaveBeenCalledWith("main", "panelTree.reload", ["panel-parent"]);
    expect(rpcCall).toHaveBeenCalledWith("main", "panelTree.rebuildAndReload", ["panel-parent"]);
    expect(rpcCall).toHaveBeenCalledWith("main", "panelTree.navigate", [
      "panel-parent",
      "panels/next",
      { contextId: "ctx-next", stateArgs: { mode: "live" } },
    ]);
    expect(rpcCall).not.toHaveBeenCalledWith("main", "panelTree.rebuildPanel", ["panel-self"]);
    expect(rpcCall).not.toHaveBeenCalledWith("main", "panelTree.reload", ["panel-self"]);
    expect(rpcCall).not.toHaveBeenCalledWith("main", "panelTree.rebuildAndReload", ["panel-self"]);
    expect(rpcCall).not.toHaveBeenCalledWith(
      "main",
      "panelTree.navigate",
      expect.arrayContaining(["panel-self"])
    );
  });

  it("hydrates arbitrary parent handles from discovered tree metadata", async () => {
    const { _initPanelHandleBridge, panelTree } = await import("./handle.js");
    _initPanelHandleBridge({ call: createRpcCall(), on: vi.fn() } as never, {
      selfId: "panel-self",
      parentId: "panel-parent",
    });

    const [child] = await panelTree.children("parent-1");
    const parent = child?.parent();

    expect(child?.id).toBe("child-1");
    expect(panelTree.parent("child-1")?.id).toBe("parent-1");
    expect(parent?.id).toBe("parent-1");
  });

  it("creates non-panel runtime handles that cannot be targeted", async () => {
    const { createNonPanelRuntimeHandle } = await import("../shared/handles.js");
    const parent = createNonPanelRuntimeHandle({ id: "panel-parent" });
    const handle = createNonPanelRuntimeHandle({
      id: "worker:agent",
      parentId: "panel-parent",
      parent: () => parent,
    });

    expect(handle.id).toBe("worker:agent");
    expect(handle.parent()?.id).toBe("panel-parent");
    await expect(handle.getInfo()).resolves.toMatchObject({
      id: "worker:agent",
      parentId: "panel-parent",
    });
    await expect(handle.cdp.getCdpEndpoint()).rejects.toThrow(
      "CDP is not available for panel worker:agent"
    );
    await expect(handle.call["anything"]!()).rejects.toThrow("worker:agent is not a panel target");
    await expect(handle.emit("event", {})).rejects.toThrow("worker:agent is not a panel target");
  });

  it("fails loudly for operations on the unified no-parent handle", async () => {
    const { createNoPanelHandle } = await import("../shared/handles.js");
    const handle = createNoPanelHandle();

    expect(handle.parent()).toBeNull();
    await expect(handle.call["anything"]!()).rejects.toThrow("No parent panel");
    await expect(handle.close()).rejects.toThrow("No parent panel");
    await expect(handle.stateArgs.set({ mode: "fixture" })).rejects.toThrow("No parent panel");
    await expect(handle.emit("event", {})).rejects.toThrow("No parent panel");
  });

  it("routes non-Electron CDP calls through the server panelCdp service", async () => {
    const rpcCall = vi.fn(async () => ({ wsEndpoint: "ws://server/cdp/panel-1", token: "t" }));
    const { _initPanelHandleBridge, getPanelHandle } = await import("./handle.js");
    _initPanelHandleBridge({ call: rpcCall, on: vi.fn() } as never);

    await expect(getPanelHandle("panel-1", "browser").cdp.getCdpEndpoint()).resolves.toEqual({
      wsEndpoint: "ws://server/cdp/panel-1",
      token: "t",
    });

    expect(rpcCall).toHaveBeenCalledWith("main", "panelCdp.getCdpEndpoint", ["panel-1"]);
  });

  it("routes non-Electron CDP drive verbs through panelCdp", async () => {
    const rpcCall = vi.fn(async () => undefined);
    const { _initPanelHandleBridge, getPanelHandle } = await import("./handle.js");
    _initPanelHandleBridge({ call: rpcCall, on: vi.fn() } as never);

    await getPanelHandle("panel-1", "browser").cdp.navigate("https://example.com");

    expect(rpcCall).toHaveBeenCalledWith("main", "panelCdp.navigate", [
      "panel-1",
      "https://example.com",
    ]);
  });

  it("routes historical console access through panelCdp", async () => {
    const rpcCall = createRpcCall();
    const { _initPanelHandleBridge, getPanelHandle } = await import("./handle.js");
    _initPanelHandleBridge({ call: rpcCall, on: vi.fn() } as never);

    await expect(
      getPanelHandle("panel-1").cdp.consoleHistory({ limit: 50, errorLimit: 50 })
    ).resolves.toMatchObject({
      entries: [expect.objectContaining({ message: "loaded" })],
      capacity: { entries: 1000, errors: 500 },
    });

    expect(rpcCall).toHaveBeenCalledWith("main", "panelCdp.consoleHistory", [
      "panel-1",
      { limit: 50, errorLimit: 50 },
    ]);
  });

  it("exposes a unified panel diagnostics bundle", async () => {
    const rpcCall = createRpcCall();
    const { _initPanelHandleBridge, getPanelHandle } = await import("./handle.js");
    _initPanelHandleBridge({ call: rpcCall, on: vi.fn() } as never);

    await expect(getPanelHandle("panel-1").diagnostics({ errorLimit: 25 })).resolves.toMatchObject({
      info: { id: "panel-1" },
      consoleHistory: {
        entries: [expect.objectContaining({ message: "loaded" })],
      },
    });

    expect(rpcCall).toHaveBeenCalledWith("main", "panelCdp.consoleHistory", [
      "panel-1",
      { errorLimit: 25 },
    ]);
  });

  it("supports handle.click as a CDP automation convenience", async () => {
    const click = vi.fn(async () => undefined);
    const page = { click };
    const connect = vi.fn(async () => ({
      contexts: () => [{ pages: () => [page] }],
    }));
    (globalThis as any).__natstackRequireAsync__ = vi.fn(async (id: string) => {
      if (id === "@workspace/cdp-client") return { BrowserImpl: { connect } };
      throw new Error(`unexpected module: ${id}`);
    });
    const rpcCall = vi.fn(async () => ({
      wsEndpoint: "ws://server/cdp/panel-1",
      token: "token-1",
    }));
    const { _initPanelHandleBridge, getPanelHandle } = await import("./handle.js");
    _initPanelHandleBridge({ call: rpcCall, on: vi.fn() } as never);

    await getPanelHandle("panel-1", "browser").click("button.submit");

    expect(rpcCall).toHaveBeenCalledWith("main", "panelCdp.getCdpEndpoint", ["panel-1"]);
    expect(click).toHaveBeenCalledWith("button.submit");
    expect((globalThis as any).__natstackRequireAsync__).toHaveBeenCalledWith(
      "@workspace/cdp-client"
    );
  });

  it("loads the explicit lightweight CDP client only when requested", async () => {
    const page = { marker: "async-page" };
    const connect = vi.fn(async () => ({
      contexts: () => [{ pages: () => [page] }],
    }));
    (globalThis as any).__natstackRequire__ = vi.fn(() => {
      throw new Error("not in map");
    });
    (globalThis as any).__natstackRequireAsync__ = vi.fn(async (id: string) => {
      if (id === "@workspace/cdp-client") return { BrowserImpl: { connect } };
      throw new Error(`unexpected module: ${id}`);
    });
    const rpcCall = vi.fn(async () => ({
      wsEndpoint: "ws://server/cdp/panel-1",
      token: "token-1",
    }));
    const { _initPanelHandleBridge, getPanelHandle } = await import("./handle.js");
    _initPanelHandleBridge({ call: rpcCall, on: vi.fn() } as never);

    await expect(getPanelHandle("panel-1", "browser").cdp.lightweightPage()).resolves.toBe(page);

    expect((globalThis as any).__natstackRequireAsync__).toHaveBeenNthCalledWith(
      1,
      "@workspace/cdp-client"
    );
  });

  it("routes CDP operations through rpc for workspace and self handles", async () => {
    const rpcCall = createRpcCall();
    const { _initPanelHandleBridge, getPanelHandle, panelTree } = await import("./handle.js");
    _initPanelHandleBridge({ call: rpcCall, on: vi.fn() } as never, {
      selfId: "panel-self",
    });

    // CDP automation is available for every panel target, including workspace
    // panels and the panel the agent is running in (panelTree.self()).
    await expect(
      getPanelHandle("workspace-1").cdp.navigate("https://example.com")
    ).resolves.toBeUndefined();
    await expect(getPanelHandle("workspace-1").cdp.getCdpEndpoint()).resolves.toEqual({
      wsEndpoint: "ws://localhost",
      token: "t",
    });
    await expect(panelTree.self().cdp.reload()).resolves.toBeUndefined();

    expect(rpcCall).toHaveBeenCalledWith("main", "panelCdp.navigate", [
      "workspace-1",
      "https://example.com",
    ]);
    expect(rpcCall).toHaveBeenCalledWith("main", "panelCdp.getCdpEndpoint", ["workspace-1"]);
    expect(rpcCall).toHaveBeenCalledWith("main", "panelCdp.reload", ["panel-self"]);
  });

  it("hydrates direct children from the host each call", async () => {
    const { _initPanelHandleBridge, openPanel } = await import("./handle.js");
    const rpcCall = createRpcCall();
    _initPanelHandleBridge({ call: rpcCall, on: vi.fn() } as never);
    const handle = await openPanel("panels/example");

    const children = await handle.children();

    expect(children).toHaveLength(1);
    expect(children[0]?.id).toBe("child-1");
    expect(rpcCall).toHaveBeenCalledWith("main", "panelTree.list", ["panel-1"]);
  });
});
