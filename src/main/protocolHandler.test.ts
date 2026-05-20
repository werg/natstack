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

describe("protocolHandler", () => {
  const link = createConnectDeepLink("https://host.tailnet.ts.net", "A".repeat(24));

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

    expect(mod.getPendingConnectLink()).toEqual({
      url: "https://host.tailnet.ts.net",
      code: "A".repeat(24),
    });
    expect(mod.getPendingConnectLink()).toBeNull();
  });

  it("dispatches fresh links to live listeners", async () => {
    const mod = await import("./protocolHandler.js");
    const listener = vi.fn();
    const off = mod.onConnectLink(listener);

    mod.enqueueConnectLink(link);
    off();
    mod.enqueueConnectLink(createConnectDeepLink("https://other.tailnet.ts.net", "B".repeat(24)));

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({
      url: "https://host.tailnet.ts.net",
      code: "A".repeat(24),
    });
  });

  it("captures macOS open-url and argv-borne second-instance links", async () => {
    const mod = await import("./protocolHandler.js");
    mod.installEarlyOpenUrlBuffer();

    const preventDefault = vi.fn();
    mocks.handlers.get("open-url")?.({ preventDefault }, link);
    expect(preventDefault).toHaveBeenCalled();
    expect(mod.getPendingConnectLink()?.url).toBe("https://host.tailnet.ts.net");

    const secondLink = createConnectDeepLink("https://second.tailnet.ts.net", "C".repeat(24));
    mocks.handlers.get("second-instance")?.({}, ["--flag", secondLink]);
    expect(mod.getPendingConnectLink()).toEqual({
      url: "https://second.tailnet.ts.net",
      code: "C".repeat(24),
    });
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
