import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkerdInspectorBridge } from "./workerdInspectorBridge.js";

describe("WorkerdInspectorBridge", () => {
  let bridge: WorkerdInspectorBridge | null = null;

  afterEach(() => {
    bridge?.stop();
    bridge = null;
    vi.restoreAllMocks();
  });

  it("returns no targets and no endpoint when the inspector is disabled", async () => {
    bridge = new WorkerdInspectorBridge({ getInspectorUrl: () => null, port: 4100 });
    expect(await bridge.listTargets()).toEqual([]);
    expect(bridge.getEndpoint("core:user:worker-host", "panel:x")).toBeNull();
  });

  it("lists targets from /json/list, deriving target paths from debugger URLs", async () => {
    bridge = new WorkerdInspectorBridge({
      getInspectorUrl: () => "http://127.0.0.1:9229",
      port: 4100,
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            id: "core:user:worker-host",
            title: "worker-host",
            type: "node",
            webSocketDebuggerUrl: "ws://127.0.0.1:9229/core:user:worker-host",
          },
          { title: "no-path" },
        ])
      )
    );
    const targets = await bridge.listTargets();
    expect(targets).toEqual([
      {
        id: "core:user:worker-host",
        title: "worker-host",
        type: "node",
        targetPath: "core:user:worker-host",
      },
    ]);
    expect(globalThis.fetch).toHaveBeenCalledWith("http://127.0.0.1:9229/json/list");
  });

  it("mints endpoints on the external host with encoded target paths", () => {
    bridge = new WorkerdInspectorBridge({
      getInspectorUrl: () => "http://127.0.0.1:9229",
      protocol: "https",
      externalHost: "natstack.local",
      port: 4100,
    });
    const endpoint = bridge.getEndpoint("core:user/worker host", "panel:x");
    expect(endpoint?.wsEndpoint).toBe(
      "wss://natstack.local:4100/workerd-inspector/core%3Auser%2Fworker%20host"
    );
    expect(endpoint?.token).toMatch(/^[0-9a-f]{64}$/);
  });
});
