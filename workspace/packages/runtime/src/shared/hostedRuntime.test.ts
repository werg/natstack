import { describe, expect, it } from "vitest";
import type { RpcClient } from "@natstack/rpc";
import { createHostedRuntime, type RuntimeHost, type WorkspaceRuntime } from "./hostedRuntime.js";

/**
 * Identity/wiring assertions for the ONE shared runtime assembly: prove the
 * derived features are real (not stubs) and wired to `host.rpc`.
 */

const WORKSPACE_RUNTIME_KEYS: Array<keyof WorkspaceRuntime> = [
  "id",
  "contextId",
  "rpc",
  "fs",
  "gad",
  "workspace",
  "credentials",
  "git",
  "vcs",
  "webhooks",
  "extensions",
  "approvals",
  "notifications",
  "workers",
  "doTargetId",
  "createDurableObjectServiceClient",
  "gatewayConfig",
  "gatewayFetch",
  "openExternal",
  "openPanel",
  "listPanels",
  "getPanelHandle",
  "panelTree",
];

function recordingHost() {
  const onEvents: string[] = [];
  const calls: Array<{ target: string; method: string; args: unknown[] }> = [];
  const rpc = {
    selfId: "test",
    call: async (target: string, method: string, args: unknown[]) => {
      calls.push({ target, method, args });
      return null;
    },
    stream: async () => new Response(),
    emit: async () => {},
    on: (event: string) => {
      onEvents.push(event);
      return () => {};
    },
    expose: () => {},
    exposeAll: () => {},
    exposeStreaming: () => {},
    peer: () => ({}) as never,
    status: () => "connected" as const,
    ready: async () => {},
    onStatusChange: () => () => {},
  } as unknown as RpcClient;
  const openPanel = async () => ({}) as never;
  const host: RuntimeHost = {
    id: "host-id",
    contextId: "ctx-1",
    rpc,
    fs: {} as never,
    gatewayConfig: { serverUrl: "http://gw.test", token: "T" },
    gatewayFetch: async () => new Response(),
    panelRuntime: {
      openPanel,
      listPanels: async () => [],
      getPanelHandle: () => ({}) as never,
      panelTree: {} as never,
    },
    workers: {} as never,
    openExternal: async () => ({}) as never,
    resolveParent: () => null,
  };
  return { host, onEvents, calls };
}

describe("createHostedRuntime", () => {
  it("exposes every WorkspaceRuntime field, all defined", () => {
    const { host } = recordingHost();
    const core = createHostedRuntime(host);
    for (const key of WORKSPACE_RUNTIME_KEYS) {
      expect(core[key], String(key)).toBeDefined();
    }
  });

  it("passes the host's panel ports through by identity", () => {
    const { host } = recordingHost();
    const core = createHostedRuntime(host);
    expect(core.openPanel).toBe(host.panelRuntime.openPanel);
    expect(core.listPanels).toBe(host.panelRuntime.listPanels);
    expect(core.getPanelHandle).toBe(host.panelRuntime.getPanelHandle);
    expect(core.panelTree).toBe(host.panelRuntime.panelTree);
    expect(core.workers).toBe(host.workers);
    expect(core.openExternal).toBe(host.openExternal);
    expect(core.gatewayFetch).toBe(host.gatewayFetch);
  });

  it("wires git.http to the credential client's gitHttp", () => {
    const { host } = recordingHost();
    const core = createHostedRuntime(host);
    expect(core.git.http).toBe(core.credentials.gitHttp);
  });

  it("derives a real credential client with forAudience", () => {
    const { host } = recordingHost();
    const core = createHostedRuntime(host);
    expect(typeof core.credentials.forAudience).toBe("function");
    expect(typeof core.credentials.connect).toBe("function");
  });

  it("vcs.subscribeHead wires through host.rpc (rpc.on + events.subscribe)", () => {
    const { host, onEvents, calls } = recordingHost();
    const core = createHostedRuntime(host);

    const off = core.vcs.subscribeHead("main", () => {});

    expect(onEvents).toContain("event:vcs:head:main");
    expect(calls).toContainEqual({
      target: "main",
      method: "events.subscribe",
      args: ["vcs:head:main"],
    });

    // Teardown pairs the unsubscribe (no leaked server-side subscription).
    off();
    expect(calls).toContainEqual({
      target: "main",
      method: "events.unsubscribe",
      args: ["vcs:head:main"],
    });
  });
});
