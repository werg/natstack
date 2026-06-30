import { beforeEach, describe, expect, it, vi } from "vitest";
import { createConnectDeepLink } from "@natstack/shared/connect";

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const app = {
    isPackaged: false,
    setAsDefaultProtocolClient: vi.fn(),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler);
      return app;
    }),
  };
  return { app, handlers };
});

vi.mock("electron", () => ({ app: mocks.app }));

const FP = "AA".repeat(32);
function pair(room: string, code: string) {
  return { room, fp: FP, code, sig: "wss://signal.example/", v: 1, ice: "all" as const };
}
function expectedPairing(room: string, code: string) {
  return { room, fp: FP, code, sig: "wss://signal.example/", v: 1, ice: "all", srv: undefined };
}

describe("protocolHandler", () => {
  const link = createConnectDeepLink(pair("room-1111-2222", "A".repeat(24)));

  beforeEach(() => {
    vi.resetModules();
    mocks.handlers.clear();
    mocks.app.isPackaged = false;
    mocks.app.setAsDefaultProtocolClient.mockReset();
    mocks.app.on.mockClear();
  });

  it("buffers a valid link until the renderer drains it", async () => {
    const mod = await import("./protocolHandler.js");
    mod.enqueueConnectLink(link);

    expect(mod.getPendingConnectLink()).toEqual(expectedPairing("room-1111-2222", "A".repeat(24)));
    expect(mod.getPendingConnectLink()).toBeNull();
  });

  it("dispatches fresh links to live listeners", async () => {
    const mod = await import("./protocolHandler.js");
    const listener = vi.fn();
    const off = mod.onConnectLink(listener);

    mod.enqueueConnectLink(link);
    off();
    mod.enqueueConnectLink(createConnectDeepLink(pair("room-3333-4444", "B".repeat(24))));

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(expectedPairing("room-1111-2222", "A".repeat(24)));
  });

  it("captures macOS open-url and argv-borne second-instance links", async () => {
    const mod = await import("./protocolHandler.js");
    mod.installEarlyOpenUrlBuffer();

    const preventDefault = vi.fn();
    mocks.handlers.get("open-url")?.({ preventDefault }, link);
    expect(preventDefault).toHaveBeenCalled();
    expect(mod.getPendingConnectLink()?.room).toBe("room-1111-2222");

    const secondLink = createConnectDeepLink(pair("room-5555-6666", "C".repeat(24)));
    mocks.handlers.get("second-instance")?.({}, ["--flag", secondLink]);
    expect(mod.getPendingConnectLink()).toEqual(expectedPairing("room-5555-6666", "C".repeat(24)));
  });

  it("registers packaged and development protocol handlers", async () => {
    const mod = await import("./protocolHandler.js");
    mocks.app.isPackaged = true;
    mod.registerProtocol();
    expect(mocks.app.setAsDefaultProtocolClient).toHaveBeenLastCalledWith("natstack");

    mocks.app.isPackaged = false;
    mod.registerProtocol();
    expect(mocks.app.setAsDefaultProtocolClient).toHaveBeenLastCalledWith(
      "natstack",
      process.execPath,
      expect.any(Array)
    );
  });
});
