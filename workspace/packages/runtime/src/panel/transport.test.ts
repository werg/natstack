import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcMessage } from "@natstack/rpc";
import { createPanelTransport } from "./transport.js";

const g = globalThis as typeof globalThis & {
  __natstackTransport?: {
    send: ReturnType<typeof vi.fn>;
    onMessage: ReturnType<typeof vi.fn>;
    onRecovery: ReturnType<typeof vi.fn>;
  };
  __natstackShell?: {
    serviceCall: ReturnType<typeof vi.fn>;
  };
};

describe("createPanelTransport", () => {
  afterEach(() => {
    delete g.__natstackTransport;
    delete g.__natstackShell;
  });

  it("routes canonical endpoint ids unchanged", async () => {
    const send = vi.fn(async () => {});
    g.__natstackTransport = {
      send,
      onMessage: vi.fn(() => vi.fn()),
      onRecovery: vi.fn(() => vi.fn()),
    };
    const transport = createPanelTransport();
    const message: RpcMessage = {
      type: "event",
      fromId: "panel:panel-1",
      event: "test",
      payload: {},
    };

    await transport.send("panel:panel-2", message);

    expect(send).toHaveBeenCalledWith("panel:panel-2", message);
  });

  it("delivers incoming messages under their canonical source id", () => {
    let incoming!: (fromId: string, message: unknown) => void;
    g.__natstackTransport = {
      send: vi.fn(async () => {}),
      onMessage: vi.fn((handler) => {
        incoming = handler;
        return vi.fn();
      }),
      onRecovery: vi.fn(() => vi.fn()),
    };
    const transport = createPanelTransport();
    const handler = vi.fn();
    const message: RpcMessage = {
      type: "event",
      fromId: "panel:panel-1",
      event: "test",
      payload: {},
    };
    transport.onMessage("panel:panel-1", handler);

    incoming("panel:panel-1", message);

    expect(handler).toHaveBeenCalledWith(message);
  });

  it("sends panel event subscriptions over the WS transport", async () => {
    const send = vi.fn(async () => {});
    const serviceCall = vi.fn(async () => {});
    g.__natstackTransport = {
      send,
      onMessage: vi.fn(() => vi.fn()),
      onRecovery: vi.fn(() => vi.fn()),
    };
    g.__natstackShell = { serviceCall };
    const transport = createPanelTransport();
    const message: RpcMessage = {
      type: "request",
      fromId: "panel:panel-1",
      requestId: "req-1",
      method: "events.subscribe",
      args: ["notification:action"],
    };

    await transport.send("main", message);

    expect(send).toHaveBeenCalledWith("main", message);
    expect(serviceCall).not.toHaveBeenCalled();
  });

  it("continues routing other Electron-local panel services through serviceCall", async () => {
    const send = vi.fn(async () => {});
    const serviceCall = vi.fn(async () => "ok");
    g.__natstackTransport = {
      send,
      onMessage: vi.fn(() => vi.fn()),
      onRecovery: vi.fn(() => vi.fn()),
    };
    g.__natstackShell = { serviceCall };
    const transport = createPanelTransport();
    const message: RpcMessage = {
      type: "request",
      fromId: "panel:panel-1",
      requestId: "req-2",
      method: "panel.list",
      args: [null],
    };

    await transport.send("main", message);
    await Promise.resolve();

    expect(serviceCall).toHaveBeenCalledWith("panel.list", null);
    expect(send).not.toHaveBeenCalled();
  });
});
