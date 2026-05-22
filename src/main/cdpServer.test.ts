import { describe, expect, it, vi } from "vitest";
import { CdpServer } from "./cdpServer.js";

function createServerHarness(activeConnectionCount = 0) {
  const debuggerApi = {
    attach: vi.fn(),
    detach: vi.fn(),
    sendCommand: vi.fn(async () => ({ nodes: [{ nodeId: 1 }] })),
  };
  const contents = {
    isDestroyed: vi.fn(() => false),
    debugger: debuggerApi,
  };
  const server = new CdpServer();
  server.setViewManager({
    getWebContents: vi.fn(() => contents),
  } as never);
  if (activeConnectionCount > 0) {
    (server as unknown as { activeConnections: Map<string, Set<unknown>> }).activeConnections.set(
      "panel-1",
      new Set(Array.from({ length: activeConnectionCount }, (_, index) => ({ index })))
    );
  }
  return { server, contents, debuggerApi };
}

describe("CdpServer snapshot debugger lifecycle", () => {
  it("detaches after snapshot-only accessibility capture", async () => {
    const { server, debuggerApi } = createServerHarness();

    await expect(server.getAccessibilityTree("panel-1")).resolves.toEqual([{ nodeId: 1 }]);

    expect(debuggerApi.attach).toHaveBeenCalledWith("1.3");
    expect(debuggerApi.sendCommand).toHaveBeenCalledWith(
      "Accessibility.getFullAXTree",
      undefined,
      undefined
    );
    expect(debuggerApi.detach).toHaveBeenCalledTimes(1);
  });

  it("keeps debugger attached when a CDP websocket client is active", async () => {
    const { server, debuggerApi } = createServerHarness(1);

    await expect(server.getAccessibilityTree("panel-1")).resolves.toEqual([{ nodeId: 1 }]);

    expect(debuggerApi.attach).toHaveBeenCalledWith("1.3");
    expect(debuggerApi.detach).not.toHaveBeenCalled();
  });
});
