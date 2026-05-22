import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcTransport } from "@natstack/rpc";
import { initRuntime } from "./initRuntime.js";
import { setStateArgs } from "../panel/stateArgs.js";

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
};

function createTransport(): RpcTransport {
  return {
    send: vi.fn(async () => {}),
    onMessage: vi.fn(() => vi.fn()),
    onAnyMessage: vi.fn(() => vi.fn()),
  };
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

  it("uses the stable slot id for current-panel state args", async () => {
    const setStateArgsMock = vi.fn(async () => undefined);
    const panelSetStateArgsMock = vi.fn(async () => undefined);
    g.__natstackEntityId = "panel:entity-1";
    g.__natstackSlotId = "slot-1";
    g.__natstackContextId = "ctx-1";
    g.__natstackKind = "panel";
    g.__natstackGatewayConfig = { serverUrl: "http://127.0.0.1:3000", token: "token" };
    g.__natstackShell = {
      setStateArgs: setStateArgsMock,
      panel: { setStateArgs: panelSetStateArgsMock },
      getInfo: vi.fn(),
      focusPanel: vi.fn(),
    };

    initRuntime({
      createTransport,
      fs: {} as never,
    });

    await setStateArgs({ mode: "live" });

    expect(setStateArgsMock).toHaveBeenCalledWith({ mode: "live" });
    expect(panelSetStateArgsMock).not.toHaveBeenCalled();
  });

  it("uses the parent entity id for parent RPC while preserving the parent slot id", () => {
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
      createTransport,
      fs: {} as never,
    });

    expect(config.parentId).toBe("parent-slot");
    expect(config.parentEntityId).toBe("panel:parent-entity");
    expect(runtime.parentId).toBe("parent-slot");
    expect(runtime.parentEntityId).toBe("panel:parent-entity");
    expect(runtime.getParent()?.id).toBe("panel:parent-entity");
  });
});
