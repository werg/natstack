import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcEnvelope, RpcMessage } from "@natstack/rpc";
import { createPanelTransport } from "./transport.js";

const g = globalThis as typeof globalThis & {
  __natstackShell?: {
    postEnvelope: ReturnType<typeof vi.fn>;
    onEnvelope: ReturnType<typeof vi.fn>;
    onRecovery?: ReturnType<typeof vi.fn>;
    serviceCall?: ReturnType<typeof vi.fn>;
  };
};

function makeShell(overrides: Partial<NonNullable<typeof g.__natstackShell>> = {}) {
  return {
    postEnvelope: vi.fn(async () => {}),
    onEnvelope: vi.fn(() => vi.fn()),
    onRecovery: vi.fn(() => vi.fn()),
    ...overrides,
  };
}

function envelope(target: string, message: RpcMessage): RpcEnvelope {
  return {
    from: "panel:panel-1",
    target,
    delivery: { caller: { callerId: "panel:panel-1", callerKind: "panel" } },
    provenance: [{ callerId: "panel:panel-1", callerKind: "panel" }],
    message,
  };
}

describe("createPanelTransport", () => {
  afterEach(() => {
    delete g.__natstackShell;
  });

  it("posts canonical envelopes over the shell bridge unchanged", async () => {
    const shell = makeShell();
    g.__natstackShell = shell;
    const transport = createPanelTransport();
    const message: RpcMessage = {
      type: "event",
      fromId: "panel:panel-1",
      event: "test",
      payload: {},
    };

    const sentEnvelope = envelope("panel:panel-2", message);
    await transport.send(sentEnvelope);

    expect(shell.postEnvelope).toHaveBeenCalledWith(sentEnvelope);
  });

  it("delivers incoming envelopes unchanged", () => {
    let incoming!: (envelope: RpcEnvelope) => void;
    g.__natstackShell = makeShell({
      onEnvelope: vi.fn((handler) => {
        incoming = handler;
        return vi.fn();
      }),
    });
    const transport = createPanelTransport();
    const handler = vi.fn();
    const message: RpcMessage = {
      type: "event",
      fromId: "panel:panel-1",
      event: "test",
      payload: {},
    };
    const inboundEnvelope = envelope("panel:panel-2", message);
    transport.onMessage(handler);

    incoming(inboundEnvelope);

    expect(handler).toHaveBeenCalledWith(inboundEnvelope);
  });

  it("sends panel event subscriptions over the shell bridge", async () => {
    const serviceCall = vi.fn(async () => {});
    const shell = makeShell({ serviceCall });
    g.__natstackShell = shell;
    const transport = createPanelTransport();
    const message: RpcMessage = {
      type: "request",
      fromId: "panel:panel-1",
      requestId: "req-1",
      method: "events.subscribe",
      args: ["notification:action"],
    };

    const sentEnvelope = envelope("main", message);
    await transport.send(sentEnvelope);

    expect(shell.postEnvelope).toHaveBeenCalledWith(sentEnvelope);
    expect(serviceCall).not.toHaveBeenCalled();
  });

  it("sends panel CDP requests over the shell bridge", async () => {
    const serviceCall = vi.fn(async () => {});
    const shell = makeShell({ serviceCall });
    g.__natstackShell = shell;
    const transport = createPanelTransport();
    const message: RpcMessage = {
      type: "request",
      fromId: "panel:chat-entity",
      requestId: "req-cdp",
      method: "panelCdp.getCdpEndpoint",
      args: ["panel:target-slot"],
    };

    const sentEnvelope = envelope("main", message);
    await transport.send(sentEnvelope);

    expect(shell.postEnvelope).toHaveBeenCalledWith(sentEnvelope);
    expect(serviceCall).not.toHaveBeenCalled();
  });

  it("routes Electron-local panel host helpers through serviceCall", async () => {
    const serviceCall = vi.fn(async () => "ok");
    const shell = makeShell({ serviceCall });
    g.__natstackShell = shell;
    const transport = createPanelTransport();
    const handler = vi.fn();
    transport.onMessage(handler);
    const message: RpcMessage = {
      type: "request",
      fromId: "panel:panel-1",
      requestId: "req-2",
      method: "panel.reloadView",
      args: ["panel-1"],
    };

    await transport.send(envelope("main", message));
    await Promise.resolve();
    await Promise.resolve();

    expect(serviceCall).toHaveBeenCalledWith("panel.reloadView", "panel-1");
    expect(shell.postEnvelope).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "main",
        target: "panel:panel-1",
        message: {
          type: "response",
          requestId: "req-2",
          result: "ok",
        },
      })
    );
  });
});
