import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcTransport } from "@natstack/rpc";
import { initRuntime } from "./initRuntime.js";

const g = globalThis as typeof globalThis & {
  __natstackId?: string;
  __natstackContextId?: string;
  __natstackKind?: "panel" | "shell";
  __natstackParentId?: string | null;
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
    delete g.__natstackId;
    delete g.__natstackContextId;
    delete g.__natstackKind;
    delete g.__natstackParentId;
    delete g.__natstackInitialTheme;
    delete g.__natstackGatewayConfig;
    delete g.__natstackEnv;
    delete g.__natstackShell;
  });

  it("uses the injected canonical panel id as the RPC self id", () => {
    g.__natstackId = "panel:panel-1";
    g.__natstackContextId = "ctx-1";
    g.__natstackKind = "panel";
    g.__natstackGatewayConfig = { serverUrl: "http://127.0.0.1:3000", token: "token" };
    g.__natstackShell = {
      setStateArgs: vi.fn(),
      getInfo: vi.fn(),
      closeSelf: vi.fn(),
      focusPanel: vi.fn(),
    };

    const { runtime, config } = initRuntime({
      createTransport,
      fs: {} as never,
    });

    expect(config.id).toBe("panel:panel-1");
    expect(runtime.rpc.selfId).toBe("panel:panel-1");
  });
});
