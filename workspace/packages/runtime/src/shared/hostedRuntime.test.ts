import { describe, expect, it } from "vitest";
import type { RpcClient } from "@natstack/rpc";
import {
  createHostedRuntime,
  createServicesProxy,
  type RuntimeHost,
  type WorkspaceRuntime,
} from "./hostedRuntime.js";
import { createWorkerdClient } from "./workerd.js";
import { portableExports, PORTABLE_KEYS } from "@natstack/shared/runtimeSurface.portable";

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
  "blobstore",
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
    // A REAL workers client so its bound namespace members are the actual ones
    // (the parity test below diffs them against the declared WORKERS_MEMBERS).
    workers: createWorkerdClient(rpc),
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

  it("exposes a blobstore client that forwards to the main blobstore service", async () => {
    const { host, calls } = recordingHost();
    const core = createHostedRuntime(host);

    // The agent's instinct in eval: persist a screenshot via services.blobstore.
    // This must reach the `blobstore` RPC service (which admits `do` callers),
    // not be undefined.
    expect(typeof core.blobstore.putBase64).toBe("function");
    await core.blobstore.putBase64("aGVsbG8=");

    expect(calls).toContainEqual({
      target: "main",
      method: "blobstore.putBase64",
      args: ["aGVsbG8="],
    });
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

/**
 * (a) Cross-target binding parity + declared-vs-bound surface drift.
 *
 * The runtime binding key-set is identical across panel/worker/eval BECAUSE all
 * three call this ONE `createHostedRuntime` — so asserting its `Object.keys`
 * equals the declared portable surface (`runtimeSurface.portable.ts`) proves
 * parity for every target at once, AND fails if the manifest and the real bound
 * surface drift in EITHER direction (a key declared-but-not-bound, or
 * bound-but-not-declared).
 */
describe("createHostedRuntime ⟷ portable surface parity", () => {
  it("top-level bound keys are EXACTLY the declared portable surface (drift fails either way)", () => {
    const { host } = recordingHost();
    const bound = new Set(Object.keys(createHostedRuntime(host)));
    const declared = new Set(PORTABLE_KEYS);
    // Symmetric: a key added to the runtime but not the manifest (or vice versa) fails.
    expect(bound).toEqual(declared);
  });

  it("every declared namespace member is actually bound on its live client (no advertised-but-absent member)", () => {
    const { host } = recordingHost();
    const rt = createHostedRuntime(host) as unknown as Record<string, unknown>;
    // The few namespaces whose live client is host-supplied as a stub here
    // (panelTree comes from host.panelRuntime) can't be reflected from this
    // assembly — skip those; `workers` is a REAL client (see recordingHost).
    const hostPortNamespaces = new Set(["panelTree"]);
    for (const [name, entry] of Object.entries(portableExports)) {
      if (entry.kind !== "namespace" || hostPortNamespaces.has(name)) continue;
      const live = rt[name];
      expect(live, `${name} should be a bound object`).toBeTypeOf("object");
      const liveKeys = new Set(Object.keys(live as object));
      for (const member of entry.members ?? []) {
        // A declared member MUST exist on the real client — otherwise `help()`
        // and the manifest advertise a method that isn't there (the member-level
        // analogue of the old `services.blobstore === undefined` gap).
        expect(
          liveKeys.has(member),
          `${name}.${member} is declared in runtimeSurface.portable.ts but not bound on the live client`
        ).toBe(true);
      }
    }
  });

  it("the fully-curated namespaces match their declared members EXACTLY (no silent client drift)", () => {
    const { host } = recordingHost();
    const rt = createHostedRuntime(host) as unknown as Record<string, unknown>;
    // These clients are 1:1 with their manifest (unlike vcs/gad/workspace, which
    // curate a documentation subset of a larger live surface). Exact equality here
    // catches a member added to/removed from the client without a manifest update.
    const exactNamespaces = [
      "workers",
      "credentials",
      "git",
      "blobstore",
      "webhooks",
      "extensions",
      "approvals",
      "notifications",
    ];
    for (const name of exactNamespaces) {
      const declared = new Set(portableExports[name]?.members ?? []);
      const live = new Set(Object.keys(rt[name] as object));
      expect(live, `${name} live members ⟷ declared`).toEqual(declared);
    }
  });
});

/**
 * createServicesProxy — the COMPLETE `services.<name>` namespace (Fix 1): every
 * registered service reachable by name, rich clients overriding by identity, all
 * others a dynamic callMain proxy. No hand-curated list ⇒ no advertised-but-
 * unreachable gap.
 */
describe("createServicesProxy", () => {
  it("returns the SAME rich client object for a name present on the runtime (ergonomic override)", () => {
    const { host } = recordingHost();
    const rt = createHostedRuntime(host);
    const services = createServicesProxy(rt);
    // services.vcs === the bare vcs (and `import { vcs }`): one shared client, no copy.
    expect(services["vcs"]).toBe(rt.vcs);
    expect(services["blobstore"]).toBe(rt.blobstore);
    expect(services["fs"]).toBe(rt.fs);
    expect(services["workers"]).toBe(rt.workers);
  });

  it("dynamically reaches ANY other service via callMain (no curated list, no gap)", async () => {
    const { host, calls } = recordingHost();
    const rt = createHostedRuntime(host);
    const services = createServicesProxy(rt) as Record<
      string,
      Record<string, (...a: unknown[]) => Promise<unknown>>
    >;
    // `audit` is a real server service with NO rich runtime client — it must STILL
    // be reachable by name, dispatching through callMain → rpc.call("main", …).
    await services["audit"]!["query"]!({ limit: 5 });
    expect(calls).toContainEqual({
      target: "main",
      method: "audit.query",
      args: [{ limit: 5 }],
    });
  });

  it("caches fallback clients so repeated access is stable (===)", () => {
    const { host } = recordingHost();
    const services = createServicesProxy(createHostedRuntime(host)) as Record<string, unknown>;
    expect(services["someUnknownService"]).toBe(services["someUnknownService"]);
  });
});
