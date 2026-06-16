/**
 * Integration test for the Phase 1 dynamic worker host — exercises the REAL
 * workerd binary end-to-end:
 *   - `worker-host` loads a regular worker dynamically via `env.LOADER`
 *     (no per-worker config, no restart),
 *   - RPC dispatch reaches the loaded worker through the router → host → loader,
 *   - outbound `fetch()` is attributed non-forgeably through the shared egress
 *     listener (identity from `ctx.exports.EgressGateway` props),
 *   - worker create/destroy/update never restart workerd (boot generation
 *     stays put across the lifecycle).
 *
 * Unlike workerdManager.test.ts, this does NOT mock spawn or ports — it runs
 * the actual binary, so it validates the generated host code itself.
 */
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { TokenManager } from "../../packages/shared/src/tokenManager.js";
import { WorkerdManager, type WorkerdManagerDeps } from "./workerdManager.js";
import type { BuildResult } from "./buildV2/buildStore.js";

const WORKER_BUNDLE = `export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/__rpc")) {
      const body = await request.json();
      return new Response(JSON.stringify({ result: { echo: body.method, workerId: env.WORKER_ID } }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.pathname.endsWith("/egress")) {
      // Try to forge identity — the egress gateway must override it.
      const res = await fetch("https://example.com/probe", { headers: { "X-NatStack-Egress-Caller": "FORGED" } });
      const seen = await res.json();
      return new Response(JSON.stringify({ result: seen }), { headers: { "content-type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  }
};`;

function workerBuild(bundle = WORKER_BUNDLE, ev = "ev-1"): BuildResult {
  return {
    dir: "/tmp/test-build",
    sourceStateHash: "state:test",
    metadata: {
      kind: "worker",
      name: "workers/echo",
      ev,
      sourceStateHash: "state:test",
      sourcemap: false,
      details: { kind: "generic" },
      builtAt: "2026-01-01T00:00:00.000Z",
    },
    artifacts: [
      {
        path: "worker.js",
        role: "primary",
        contentType: "text/javascript; charset=utf-8",
        encoding: "utf8",
        content: bundle,
      },
    ],
  };
}

interface Harness {
  manager: WorkerdManager;
  gateway: Server;
  egress: Server;
  egressHits: Array<{ caller: string | undefined; secret: string | undefined; path: string }>;
  workerdCall: (path: string, init?: RequestInit) => Promise<Response>;
}

async function listen(server: Server): Promise<number> {
  return new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });
}

async function createHarness(buildRef?: { value: BuildResult }): Promise<Harness> {
  const tokenManager = new TokenManager();
  const currentBuild = buildRef ?? { value: workerBuild() };
  const egressHits: Harness["egressHits"] = [];

  // Shared egress listener: records the attributed caller header.
  const egress = createServer((req, res) => {
    egressHits.push({
      caller: req.headers["x-natstack-egress-caller"] as string | undefined,
      secret: req.headers["x-natstack-egress-secret"] as string | undefined,
      path: req.url ?? "",
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ seenCaller: req.headers["x-natstack-egress-caller"] ?? null }));
  });
  const egressPort = await listen(egress);

  // Construct the manager first (getServerUrl reads the port lazily via the
  // holder) so the gateway closure can reference a `const` manager.
  const portHolder = { value: 0 };
  const deps: WorkerdManagerDeps = {
    tokenManager,
    fsService: { closeHandlesForCaller: () => {} } as unknown as WorkerdManagerDeps["fsService"],
    getServerUrl: () => `http://127.0.0.1:${portHolder.value}`,
    bindRuntimeImage: async (unitPath: string, ref?: string) => ({
      source: unitPath,
      unitName: unitPath,
      stateHash: ref?.startsWith("state:") ? ref : "state:test",
      effectiveVersion: currentBuild.value.metadata.ev,
      buildKey: `build:${unitPath}:${currentBuild.value.metadata.ev}`,
    }),
    getBuildByKey: () => currentBuild.value,
    workspacePath: mkdtempSync(join(tmpdir(), "natstack-dwh-ws-")),
    statePath: mkdtempSync(join(tmpdir(), "natstack-dwh-state-")),
    getProxyPort: () => 1,
    getSharedEgressPort: () => Promise.resolve(egressPort),
    registerEgressCaller: () => {},
    unregisterEgressCaller: () => {},
    getWorkerdGatewayToken: () => "test-gateway-token",
    workerdStartupReadyTimeoutMs: 15_000,
  };
  const manager = new WorkerdManager(deps);

  // Minimal gateway serving the loader endpoints (mirrors gateway.ts).
  const gateway = createServer((req, res) => {
    const url = req.url ?? "";
    const secret = req.headers["x-natstack-loader-secret"];
    if (url.startsWith("/_workerversion/") || url.startsWith("/_workercode/")) {
      if (secret !== manager.getLoaderSecret()) {
        res.writeHead(403);
        res.end("forbidden");
        return;
      }
      const isVersion = url.startsWith("/_workerversion/");
      const name = decodeURIComponent(
        url.slice((isVersion ? "/_workerversion/" : "/_workercode/").length).split("?")[0] ?? ""
      );
      if (isVersion) {
        const version = manager.getWorkerVersion(name);
        if (version === null) {
          res.writeHead(404);
          res.end("not found");
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ version }));
        return;
      }
      void manager.getWorkerCode(name).then((code) => {
        if (!code) {
          res.writeHead(404);
          res.end("not found");
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(code));
      });
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  portHolder.value = await listen(gateway);

  const workerdCall = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const port = manager.getPort();
    if (!port) throw new Error("workerd not running");
    return fetch(`http://127.0.0.1:${port}${path}`, {
      ...init,
      headers: {
        Authorization: "Bearer test-gateway-token",
        ...(init.headers ?? {}),
      },
    });
  };

  return { manager, gateway, egress, egressHits, workerdCall };
}

let active: Harness | null = null;

afterEach(async () => {
  if (active) {
    await active.manager.shutdown();
    await new Promise<void>((r) => active!.gateway.close(() => r()));
    await new Promise<void>((r) => active!.egress.close(() => r()));
    active = null;
  }
});

describe("dynamic worker host (real workerd)", () => {
  it("loads a worker dynamically and dispatches RPC with no restart", async () => {
    active = await createHarness();
    const { manager, workerdCall } = active;

    const instance = await manager.createInstance({
      source: "workers/echo",
      contextId: "ctx-1",
      name: "echo",
    });
    expect(instance.status).toBe("running");
    const bootAfterCreate = manager.getBootGeneration();

    const res = await workerdCall("/echo/__rpc", {
      method: "POST",
      body: JSON.stringify({ type: "call", method: "ping", args: [] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: { echo: "ping", workerId: "echo" } });

    // A second worker created while the first runs — still no restart.
    await manager.createInstance({ source: "workers/echo", contextId: "ctx-2", name: "echo2" });
    expect(manager.getBootGeneration()).toBe(bootAfterCreate);

    const res2 = await workerdCall("/echo2/__rpc", {
      method: "POST",
      body: JSON.stringify({ type: "call", method: "pong", args: [] }),
    });
    expect(await res2.json()).toEqual({ result: { echo: "pong", workerId: "echo2" } });
  }, 30_000);

  it("attributes egress non-forgeably through the shared listener", async () => {
    active = await createHarness();
    const { manager, workerdCall, egressHits } = active;

    await manager.createInstance({ source: "workers/echo", contextId: "ctx-1", name: "echo" });

    const res = await workerdCall("/echo/egress");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { seenCaller: string | null } };
    // The worker tried to forge "FORGED"; the gateway stamped the real id.
    expect(body.result.seenCaller).toBe("worker:echo");
    const lastHit = egressHits[egressHits.length - 1];
    expect(lastHit?.caller).toBe("worker:echo");
    expect(lastHit?.secret).toBe(manager.getEgressSecret());
  }, 30_000);

  it("destroys a worker with no restart and stops addressing it", async () => {
    active = await createHarness();
    const { manager, workerdCall } = active;

    await manager.createInstance({ source: "workers/echo", contextId: "ctx-1", name: "echo" });
    // Keep a second instance so workerd stays up after the destroy.
    await manager.createInstance({ source: "workers/echo", contextId: "ctx-2", name: "keep" });
    const boot = manager.getBootGeneration();

    await manager.destroyInstance("echo");
    expect(manager.getBootGeneration()).toBe(boot);
    expect(manager.getWorkerVersion("echo")).toBeNull();

    const res = await workerdCall("/echo/__rpc", {
      method: "POST",
      body: JSON.stringify({ type: "call", method: "ping", args: [] }),
    });
    expect(res.status).toBe(404);

    // The surviving worker still serves.
    const keep = await workerdCall("/keep/__rpc", {
      method: "POST",
      body: JSON.stringify({ type: "call", method: "ping", args: [] }),
    });
    expect(await keep.json()).toEqual({ result: { echo: "ping", workerId: "keep" } });
  }, 30_000);

  it("reloads updated code via version bump with no restart", async () => {
    const buildRef = { value: workerBuild(WORKER_BUNDLE, "ev-1") };
    active = await createHarness(buildRef);
    const { manager, workerdCall } = active;

    await manager.createInstance({ source: "workers/echo", contextId: "ctx-1", name: "echo" });
    const boot = manager.getBootGeneration();

    const before = await workerdCall("/echo/__rpc", {
      method: "POST",
      body: JSON.stringify({ type: "call", method: "ping", args: [] }),
    });
    expect((await before.json()).result.echo).toBe("ping");

    // Swap the build for one that tags responses, then bump the version.
    buildRef.value = workerBuild(
      WORKER_BUNDLE.replace("echo: body.method", 'echo: "v2:" + body.method'),
      "ev-2"
    );
    await manager.updateInstance("echo", { env: { ROLLED: "1" } });
    expect(manager.getBootGeneration()).toBe(boot);

    const after = await workerdCall("/echo/__rpc", {
      method: "POST",
      body: JSON.stringify({ type: "call", method: "ping", args: [] }),
    });
    expect((await after.json()).result.echo).toBe("v2:ping");
  }, 30_000);
});
