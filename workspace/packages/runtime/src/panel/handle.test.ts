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
          },
        ];
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
      default:
        return undefined;
    }
  });
}

describe("PanelHandle", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("@workspace/playwright-client");
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
    const eventHandlers: Array<(event: { caller: { callerId: string }; payload: unknown }) => void> = [];
    const rpcOn = vi.fn(
      (_event: string, handler: (event: { caller: { callerId: string }; payload: unknown }) => void) => {
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
    await typedChild.cdp.getCdpEndpoint();
    await typedChild.stateArgs.set({ mode: "live" });

    expect(rpcCall).toHaveBeenCalledWith("panel:child-entity", "ping", []);
    expect(rpcEmit).toHaveBeenCalledWith("panel:child-entity", "ready", { ok: true });
    expect(rpcCall).toHaveBeenCalledWith("main", "panelCdp.getCdpEndpoint", ["child-1"]);
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

    await expect(getPanelHandle("panel-1").cdp.getCdpEndpoint()).resolves.toEqual({
      wsEndpoint: "ws://server/cdp/panel-1",
      token: "t",
    });

    expect(rpcCall).toHaveBeenCalledWith("main", "panelCdp.getCdpEndpoint", ["panel-1"]);
  });

  it("routes non-Electron CDP drive verbs through panelCdp", async () => {
    const rpcCall = vi.fn(async () => undefined);
    const { _initPanelHandleBridge, getPanelHandle } = await import("./handle.js");
    _initPanelHandleBridge({ call: rpcCall, on: vi.fn() } as never);

    await getPanelHandle("panel-1").cdp.navigate("https://example.com");

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
      if (id === "@workspace/playwright-core") return { BrowserImpl: { connect } };
      throw new Error(`unexpected module: ${id}`);
    });
    const rpcCall = vi.fn(async () => ({
      wsEndpoint: "ws://server/cdp/panel-1",
      token: "token-1",
    }));
    const { _initPanelHandleBridge, getPanelHandle } = await import("./handle.js");
    _initPanelHandleBridge({ call: rpcCall, on: vi.fn() } as never);

    await getPanelHandle("panel-1").click("button.submit");

    expect(rpcCall).toHaveBeenCalledWith("main", "panelCdp.getCdpEndpoint", ["panel-1"]);
    expect(click).toHaveBeenCalledWith("button.submit");
  });

  it("loads the explicit Playwright CDP client through the async module hook", async () => {
    const page = { marker: "page" };
    const connect = vi.fn(async () => ({
      contexts: () => [{ pages: () => [page] }],
    }));
    (globalThis as any).__natstackRequireAsync__ = vi.fn(async (id: string) => {
      if (id === "@workspace/playwright-core") return { BrowserImpl: { connect } };
      throw new Error(`unexpected module: ${id}`);
    });
    const rpcCall = vi.fn(async () => ({
      wsEndpoint: "ws://server/cdp/panel-1",
      token: "token-1",
    }));
    const { _initPanelHandleBridge, getPanelHandle } = await import("./handle.js");
    _initPanelHandleBridge({ call: rpcCall, on: vi.fn() } as never);

    await expect(getPanelHandle("panel-1").cdp.playwrightPage()).resolves.toBe(page);
    await expect(getPanelHandle("panel-1").cdp.playwrightPage()).resolves.toBe(page);

    expect(rpcCall).toHaveBeenCalledWith("main", "panelCdp.getCdpEndpoint", ["panel-1"]);
    expect(connect).toHaveBeenCalledWith("ws://server/cdp/panel-1", {
      isElectronWebview: true,
      transportOptions: { authToken: "token-1" },
    });
    expect((globalThis as any).__natstackRequireAsync__).toHaveBeenCalledWith(
      "@workspace/playwright-core"
    );
  });

  it("loads the explicit Playwright CDP client through the sync worker module map", async () => {
    const page = { marker: "worker-page" };
    const connect = vi.fn(async () => ({
      contexts: () => [{ pages: () => [page] }],
    }));
    (globalThis as any).__natstackRequire__ = vi.fn((id: string) => {
      if (id === "@workspace/playwright-core") return { BrowserImpl: { connect } };
      throw new Error(`missing module: ${id}`);
    });
    const rpcCall = vi.fn(async () => ({
      wsEndpoint: "ws://server/cdp/panel-1",
      token: "token-1",
    }));
    const { _initPanelHandleBridge, getPanelHandle } = await import("./handle.js");
    _initPanelHandleBridge({ call: rpcCall, on: vi.fn() } as never);

    await expect(getPanelHandle("panel-1").cdp.playwrightPage()).resolves.toBe(page);

    expect((globalThis as any).__natstackRequire__).toHaveBeenCalledWith(
      "@workspace/playwright-core"
    );
    expect(connect).toHaveBeenCalledWith("ws://server/cdp/panel-1", {
      isElectronWebview: true,
      transportOptions: { authToken: "token-1" },
    });
  });

  it("loads the explicit Playwright CDP client through the eval lazy import hook", async () => {
    const page = { marker: "lazy-page" };
    const connect = vi.fn(async () => ({
      contexts: () => [{ pages: () => [page] }],
    }));
    (globalThis as any).__natstackRequire__ = vi.fn(() => {
      throw new Error("not in map");
    });
    (globalThis as any).__natstackLoadImport__ = vi.fn(async (id: string, ref?: string) => {
      if (id === "@workspace/playwright-core") return { BrowserImpl: { connect } };
      throw new Error(`unexpected module: ${id}@${ref}`);
    });
    const rpcCall = vi.fn(async () => ({
      wsEndpoint: "ws://server/cdp/panel-1",
      token: "token-1",
    }));
    const { _initPanelHandleBridge, getPanelHandle } = await import("./handle.js");
    _initPanelHandleBridge({ call: rpcCall, on: vi.fn() } as never);

    await expect(getPanelHandle("panel-1").cdp.playwrightPage()).resolves.toBe(page);

    expect((globalThis as any).__natstackLoadImport__).toHaveBeenCalledWith(
      "@workspace/playwright-core",
      "latest"
    );
    expect(connect).toHaveBeenCalledWith("ws://server/cdp/panel-1", {
      isElectronWebview: true,
      transportOptions: { authToken: "token-1" },
    });
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
      if (id === "@workspace/playwright-core") throw new Error("full client unavailable");
      if (id === "@workspace/playwright-client") return { BrowserImpl: { connect } };
      throw new Error(`unexpected module: ${id}`);
    });
    const rpcCall = vi.fn(async () => ({
      wsEndpoint: "ws://server/cdp/panel-1",
      token: "token-1",
    }));
    const { _initPanelHandleBridge, getPanelHandle } = await import("./handle.js");
    _initPanelHandleBridge({ call: rpcCall, on: vi.fn() } as never);

    await expect(getPanelHandle("panel-1").cdp.lightweightPage()).resolves.toBe(page);

    expect((globalThis as any).__natstackRequireAsync__).toHaveBeenNthCalledWith(
      1,
      "@workspace/playwright-client"
    );
  });

  it("does not silently fall back when the explicit Playwright client is unavailable", async () => {
    (globalThis as any).__natstackRequire__ = vi.fn(() => {
      throw new Error("not in map");
    });
    (globalThis as any).__natstackRequireAsync__ = vi.fn(async (id: string) => {
      if (id === "@workspace/playwright-core") throw new Error("full client unavailable");
      if (id === "@workspace/playwright-client") return { BrowserImpl: { connect: vi.fn() } };
      throw new Error(`unexpected module: ${id}`);
    });
    const rpcCall = vi.fn(async () => ({
      wsEndpoint: "ws://server/cdp/panel-1",
      token: "token-1",
    }));
    const { _initPanelHandleBridge, getPanelHandle } = await import("./handle.js");
    _initPanelHandleBridge({ call: rpcCall, on: vi.fn() } as never);

    await expect(getPanelHandle("panel-1").cdp.playwrightPage()).rejects.toThrow(
      "Unable to load @workspace/playwright-core"
    );
    expect((globalThis as any).__natstackRequireAsync__).not.toHaveBeenCalledWith(
      "@workspace/playwright-client"
    );
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
