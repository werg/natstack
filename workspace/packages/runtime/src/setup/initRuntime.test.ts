import { afterEach, describe, expect, it, vi } from "vitest";
import type { EnvelopeRpcTransport, RpcEnvelope } from "@natstack/rpc";
import { initRuntime } from "./initRuntime.js";
import { setStateArgs } from "../panel/stateArgs.js";
import { DEFAULT_THEME_CONFIG } from "../types.js";

const g = globalThis as typeof globalThis & {
  __natstackEntityId?: string;
  __natstackId?: string;
  __natstackSlotId?: string;
  __natstackContextId?: string;
  __natstackKind?: "panel" | "shell";
  __natstackParentId?: string | null;
  __natstackParentEntityId?: string | null;
  __natstackInitialTheme?: "light" | "dark";
  __natstackGatewayConfig?: { serverUrl: string; token: string };
  __natstackEnv?: Record<string, string>;
  __natstackShell?: Record<string, unknown>;
  __natstackStateArgs?: Record<string, unknown>;
};

function createTransport(options?: {
  onSend?: (
    envelope: RpcEnvelope,
    deliver: (envelope: RpcEnvelope) => void
  ) => void | Promise<void>;
}): EnvelopeRpcTransport {
  let messageHandler: ((envelope: RpcEnvelope) => void) | null = null;
  return {
    send: vi.fn(async (envelope) => {
      if (
        envelope.target === "main" &&
        envelope.message.type === "request" &&
        envelope.message.method === "panel.getThemeConfig"
      ) {
        messageHandler?.(responseFor(envelope, DEFAULT_THEME_CONFIG));
        return;
      }
      await options?.onSend?.(envelope, (inboundEnvelope) => {
        messageHandler?.(inboundEnvelope);
      });
    }),
    onMessage: vi.fn((handler) => {
      messageHandler = handler;
      return vi.fn();
    }),
  };
}

function responseFor(envelope: RpcEnvelope, result: unknown): RpcEnvelope {
  if (envelope.message.type !== "request") {
    throw new Error("responseFor expects a request envelope");
  }
  return {
    from: envelope.target,
    target: envelope.from,
    delivery: { caller: { callerId: envelope.target, callerKind: "server" } },
    provenance: envelope.provenance,
    message: {
      type: "response",
      requestId: envelope.message.requestId,
      result,
    },
  };
}

function stubPanelWindow(): EventTarget & { __natstackStateArgs?: Record<string, unknown> } {
  const panelWindow = new EventTarget() as EventTarget & {
    __natstackStateArgs?: Record<string, unknown>;
  };
  vi.stubGlobal("window", panelWindow);
  if (typeof CustomEvent === "undefined") {
    vi.stubGlobal(
      "CustomEvent",
      class<T> extends Event {
        detail: T;
        constructor(type: string, init?: CustomEventInit<T>) {
          super(type);
          this.detail = init?.detail as T;
        }
      }
    );
  }
  return panelWindow;
}

describe("initRuntime", () => {
  afterEach(() => {
    delete g.__natstackEntityId;
    delete g.__natstackId;
    delete g.__natstackSlotId;
    delete g.__natstackContextId;
    delete g.__natstackKind;
    delete g.__natstackParentId;
    delete g.__natstackParentEntityId;
    delete g.__natstackInitialTheme;
    delete g.__natstackGatewayConfig;
    delete g.__natstackEnv;
    delete g.__natstackShell;
    delete g.__natstackStateArgs;
    vi.unstubAllGlobals();
  });

  it("uses the injected canonical panel id as the RPC self id", () => {
    g.__natstackEntityId = "panel:panel-1";
    g.__natstackSlotId = "slot-1";
    g.__natstackContextId = "ctx-1";
    g.__natstackKind = "panel";
    g.__natstackGatewayConfig = { serverUrl: "http://127.0.0.1:3000", token: "token" };
    g.__natstackShell = {
      setStateArgs: vi.fn(),
      getInfo: vi.fn(),
      focusPanel: vi.fn(),
    };

    const { runtime, config } = initRuntime({
      createTransport,
      fs: {} as never,
    });

    expect(config.entityId).toBe("panel:panel-1");
    expect(config.id).toBe("panel:panel-1");
    expect(config.slotId).toBe("slot-1");
    expect(runtime.rpc.selfId).toBe("panel:panel-1");
  });

  it("preserves call delivery metadata through the runtime transport envelope", async () => {
    const sent: RpcEnvelope[] = [];
    g.__natstackEntityId = "panel:panel-1";
    g.__natstackSlotId = "slot-1";
    g.__natstackContextId = "ctx-1";
    g.__natstackKind = "panel";
    g.__natstackGatewayConfig = { serverUrl: "http://127.0.0.1:3000", token: "token" };
    g.__natstackShell = {
      setStateArgs: vi.fn(),
      getInfo: vi.fn(),
      focusPanel: vi.fn(),
    };

    const { runtime } = initRuntime({
      createTransport: () =>
        createTransport({
          onSend: (envelope, deliver) => {
            const message = envelope.message;
            if (message.type !== "request") return;
            sent.push(envelope);
            deliver(responseFor(envelope, "ok"));
          },
        }),
      fs: {} as never,
    });

    await expect(
      runtime.rpc.call("main", "fs.writeFile", ["/tmp/x", "y"], {
        idempotencyKey: "idem-1",
        readOnly: true,
      })
    ).resolves.toBe("ok");

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      target: "main",
      delivery: { idempotencyKey: "idem-1", readOnly: true },
      message: {
        type: "request",
        method: "fs.writeFile",
      },
    });
    expect(sent[0]!.message).not.toHaveProperty("idempotencyKey");
    expect(sent[0]!.message).not.toHaveProperty("readOnly");
  });

  it("uses the stable slot id and applies returned current-panel state args locally", async () => {
    const panelTreeSetStateArgsMock = vi.fn();
    const stateArgsChanged = vi.fn();
    const panelWindow = stubPanelWindow();
    g.__natstackEntityId = "panel:entity-1";
    g.__natstackSlotId = "slot-1";
    g.__natstackContextId = "ctx-1";
    g.__natstackKind = "panel";
    g.__natstackGatewayConfig = { serverUrl: "http://127.0.0.1:3000", token: "token" };
    g.__natstackShell = {
      getInfo: vi.fn(),
      focusPanel: vi.fn(),
    };
    panelWindow.addEventListener("natstack:stateArgsChanged", stateArgsChanged);

    initRuntime({
      createTransport: () =>
        createTransport({
          onSend: (envelope, deliver) => {
            const message = envelope.message;
            if (message.type !== "request") return;
            panelTreeSetStateArgsMock(message.method, message.args);
            deliver(responseFor(envelope, { mode: "live", fromHost: true }));
          },
        }),
      fs: {} as never,
    });

    await setStateArgs({ mode: "live" });

    expect(panelTreeSetStateArgsMock).toHaveBeenCalledWith("panelTree.setStateArgs", [
      "slot-1",
      { mode: "live" },
    ]);
    expect(panelWindow.__natstackStateArgs).toEqual({ mode: "live", fromHost: true });
    expect(stateArgsChanged).toHaveBeenCalledTimes(1);
    expect((stateArgsChanged.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({
      mode: "live",
      fromHost: true,
    });
  });

  it("applies host-published state args for non-caller updates", () => {
    const panelWindow = stubPanelWindow();
    const stateArgsChanged = vi.fn();
    const shellListeners: Array<(event: string, payload: unknown) => void> = [];
    g.__natstackEntityId = "panel:panel-1";
    g.__natstackSlotId = "slot-1";
    g.__natstackContextId = "ctx-1";
    g.__natstackKind = "panel";
    g.__natstackGatewayConfig = { serverUrl: "http://127.0.0.1:3000", token: "token" };
    g.__natstackShell = {
      addEventListener: vi.fn((listener: (event: string, payload: unknown) => void) => {
        shellListeners.push(listener);
        return 1;
      }),
      removeEventListener: vi.fn(),
      setStateArgs: vi.fn(),
      getInfo: vi.fn(),
      focusPanel: vi.fn(),
    };
    panelWindow.addEventListener("natstack:stateArgsChanged", stateArgsChanged);

    initRuntime({
      createTransport,
      fs: {} as never,
    });
    expect(shellListeners).toHaveLength(2);
    for (const listener of shellListeners) {
      listener("runtime:stateArgsChanged", { mode: "external" });
    }

    expect(panelWindow.__natstackStateArgs).toEqual({ mode: "external" });
    expect(stateArgsChanged).toHaveBeenCalledTimes(1);
    expect((stateArgsChanged.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({
      mode: "external",
    });
  });

  it("normalizes loopback gateway URLs to the panel page origin", () => {
    vi.stubGlobal("location", { origin: "http://localhost:3000" });
    g.__natstackEntityId = "panel:panel-1";
    g.__natstackSlotId = "slot-1";
    g.__natstackContextId = "ctx-1";
    g.__natstackKind = "panel";
    g.__natstackGatewayConfig = { serverUrl: "http://127.0.0.1:3000", token: "token" };
    g.__natstackShell = {
      setStateArgs: vi.fn(),
      getInfo: vi.fn(),
      focusPanel: vi.fn(),
    };

    const { config } = initRuntime({
      createTransport,
      fs: {} as never,
    });

    expect(config.gatewayConfig.serverUrl).toBe("http://localhost:3000");
    expect(config.gatewayConfig.aliases).toContain("http://127.0.0.1:3000");
  });

  it("does not normalize non-equivalent gateway origins", () => {
    vi.stubGlobal("location", { origin: "http://localhost:3000" });
    g.__natstackEntityId = "panel:panel-1";
    g.__natstackSlotId = "slot-1";
    g.__natstackContextId = "ctx-1";
    g.__natstackKind = "panel";
    g.__natstackGatewayConfig = { serverUrl: "http://127.0.0.1:4000", token: "token" };
    g.__natstackShell = {
      setStateArgs: vi.fn(),
      getInfo: vi.fn(),
      focusPanel: vi.fn(),
    };

    const { config } = initRuntime({
      createTransport,
      fs: {} as never,
    });

    expect(config.gatewayConfig.serverUrl).toBe("http://127.0.0.1:4000");
    expect(config.gatewayConfig.aliases).toBeUndefined();
  });

  it("uses the parent slot id for handle identity/control and the parent entity id for RPC", async () => {
    const sends: Array<{ targetId: string; method: string; args: unknown[] }> = [];
    g.__natstackEntityId = "panel:child-entity";
    g.__natstackSlotId = "child-slot";
    g.__natstackContextId = "ctx-1";
    g.__natstackKind = "panel";
    g.__natstackParentId = "parent-slot";
    g.__natstackParentEntityId = "panel:parent-entity";
    g.__natstackGatewayConfig = { serverUrl: "http://127.0.0.1:3000", token: "token" };
    g.__natstackShell = {
      setStateArgs: vi.fn(),
      getInfo: vi.fn(),
      focusPanel: vi.fn(),
    };

    const { runtime, config } = initRuntime({
      createTransport: () =>
        createTransport({
          onSend: (envelope, deliver) => {
            const message = envelope.message;
            if (message.type !== "request") return;
            sends.push({ targetId: envelope.target, method: message.method, args: message.args });
            deliver(
              responseFor(envelope, { wsEndpoint: "ws://server/cdp/parent-slot", token: "t" })
            );
          },
        }),
      fs: {} as never,
    });

    expect(config.parentId).toBe("parent-slot");
    expect(config.parentEntityId).toBe("panel:parent-entity");
    expect(runtime.parentId).toBe("parent-slot");
    expect(runtime.parentEntityId).toBe("panel:parent-entity");
    expect(runtime.getParent()?.id).toBe("parent-slot");
    await expect(runtime.getParent()?.getInfo()).resolves.toMatchObject({
      id: "parent-slot",
      parentId: null,
    });

    await runtime.getParent()?.call["ping"]?.();
    await expect(runtime.getParent()?.cdp.getCdpEndpoint()).resolves.toEqual({
      wsEndpoint: "ws://server/cdp/parent-slot",
      token: "t",
    });

    expect(sends).toEqual([
      { targetId: "panel:parent-entity", method: "ping", args: [] },
      { targetId: "main", method: "panelCdp.getCdpEndpoint", args: ["parent-slot"] },
    ]);
  });

  it("exposes full panelTree lifecycle and state operations on the unified parent handle", async () => {
    const sends: Array<{ targetId: string; method: string; args: unknown[] }> = [];
    g.__natstackEntityId = "panel:child-entity";
    g.__natstackSlotId = "child-slot";
    g.__natstackContextId = "ctx-1";
    g.__natstackKind = "panel";
    g.__natstackParentId = "parent-slot";
    g.__natstackParentEntityId = "panel:parent-entity";
    g.__natstackGatewayConfig = { serverUrl: "http://127.0.0.1:3000", token: "token" };
    g.__natstackShell = {
      setStateArgs: vi.fn(),
      getInfo: vi.fn(),
      focusPanel: vi.fn(),
    };

    const { runtime } = initRuntime({
      createTransport: () =>
        createTransport({
          onSend: (envelope, deliver) => {
            const message = envelope.message;
            if (message.type !== "request") return;
            sends.push({ targetId: envelope.target, method: message.method, args: message.args });
            deliver(
              responseFor(
                envelope,
                message.method === "panelTree.list"
                  ? [
                      {
                        panelId: "sibling-slot",
                        title: "Sibling",
                        source: "panels/sibling",
                        kind: "workspace",
                        parentId: "parent-slot",
                        runtimeEntityId: "panel:sibling-entity",
                      },
                    ]
                  : undefined
              )
            );
          },
        }),
      fs: {} as never,
    });

    const parent = runtime.parent;
    await parent.close();
    await parent.navigate("panels/next", { contextId: "ctx-next" });
    await parent.stateArgs.set({ mode: "fixture" });
    const children = await parent.children();

    expect(children.map((child) => child.id)).toEqual(["sibling-slot"]);
    expect(sends).toEqual([
      { targetId: "main", method: "panelTree.close", args: ["parent-slot"] },
      {
        targetId: "main",
        method: "panelTree.navigate",
        args: ["parent-slot", "panels/next", { contextId: "ctx-next" }],
      },
      { targetId: "main", method: "panelTree.metadata", args: ["parent-slot"] },
      {
        targetId: "main",
        method: "panelTree.setStateArgs",
        args: ["parent-slot", { mode: "fixture" }],
      },
      { targetId: "main", method: "panelTree.list", args: ["parent-slot"] },
    ]);
  });

  it("defaults panel-created workers to the current panel slot parent id", async () => {
    const sends: Array<{ targetId: string; method: string; args: unknown[] }> = [];
    g.__natstackEntityId = "panel:child-entity";
    g.__natstackSlotId = "child-slot";
    g.__natstackContextId = "ctx-1";
    g.__natstackKind = "panel";
    g.__natstackGatewayConfig = { serverUrl: "http://127.0.0.1:3000", token: "token" };
    g.__natstackShell = {
      setStateArgs: vi.fn(),
      getInfo: vi.fn(),
      focusPanel: vi.fn(),
    };

    const { runtime } = initRuntime({
      createTransport: () =>
        createTransport({
          onSend: (envelope, deliver) => {
            const message = envelope.message;
            if (message.type !== "request") return;
            sends.push({ targetId: envelope.target, method: message.method, args: message.args });
            deliver(
              responseFor(envelope, {
                name: "agent",
                source: "workers/agent",
                contextId: "ctx-1",
                callerId: "worker:agent",
                env: {},
                bindings: {},
                status: "running",
              })
            );
          },
        }),
      fs: {} as never,
    });

    await runtime.workers.create({ source: "workers/agent", contextId: "ctx-1" });

    expect(sends).toEqual([
      {
        targetId: "main",
        method: "workerd.createInstance",
        args: [
          {
            parentId: "child-slot",
            parentEntityId: "panel:child-entity",
            parentKind: "panel",
            source: "workers/agent",
            contextId: "ctx-1",
          },
        ],
      },
    ]);
  });
});
