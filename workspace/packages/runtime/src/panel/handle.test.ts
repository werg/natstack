import { beforeEach, describe, expect, it, vi } from "vitest";

describe("PanelHandle", () => {
  beforeEach(() => {
    vi.resetModules();
    (globalThis as any).__natstackShell = {
      panel: {
        create: vi.fn(async (source: string) => ({
          id: source.startsWith("http") ? "browser-1" : "panel-1",
          title: "Created",
          kind: source.startsWith("http") ? "browser" : "workspace",
        })),
        list: vi.fn(async (parentId?: string | null) =>
          parentId
            ? [
                {
                  panelId: "child-1",
                  title: "Child",
                  source: "panels/child",
                  kind: "workspace",
                  parentId,
                  contextId: "ctx",
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
                },
              ]
        ),
        close: vi.fn(async () => undefined),
        reload: vi.fn(async () => undefined),
        getStateArgs: vi.fn(async () => ({ mode: "fixture" })),
        setStateArgs: vi.fn(async () => ({ mode: "live" })),
        snapshot: vi.fn(async () => ({ kind: "ax", text: "ok" })),
        callAgent: vi.fn(async () => ({})),
      },
      getCdpEndpoint: vi.fn(async () => ({ wsEndpoint: "ws://localhost", token: "t" })),
    };
  });

  it("returns a workspace handle from openPanel", async () => {
    const { _initPanelHandleBridge, openPanel } = await import("./handle.js");
    _initPanelHandleBridge({ call: vi.fn(), onEvent: vi.fn() } as never);

    const handle = await openPanel("panels/example");

    expect(handle).toMatchObject({
      id: "panel-1",
      title: "Created",
      source: "panels/example",
      kind: "workspace",
    });
    await expect(handle.browser.getCdpEndpoint()).rejects.toThrow("workspace panel");
  });

  it("hydrates rediscovered browser handles with browser automation", async () => {
    const { _initPanelHandleBridge, listPanels } = await import("./handle.js");
    _initPanelHandleBridge({ call: vi.fn(), onEvent: vi.fn() } as never);

    const [handle] = await listPanels();

    expect(handle?.kind).toBe("browser");
    expect(handle?.source).toBe("https://example.com");
    await expect(handle?.browser.getCdpEndpoint()).resolves.toEqual({
      wsEndpoint: "ws://localhost",
      token: "t",
    });
  });

  it("hydrates direct children from the host each call", async () => {
    const { _initPanelHandleBridge, openPanel } = await import("./handle.js");
    _initPanelHandleBridge({ call: vi.fn(), onEvent: vi.fn() } as never);
    const handle = await openPanel("panels/example");

    const children = await handle.children();

    expect(children).toHaveLength(1);
    expect(children[0]?.id).toBe("child-1");
    expect((globalThis as any).__natstackShell.panel.list).toHaveBeenCalledWith("panel-1");
  });
});
