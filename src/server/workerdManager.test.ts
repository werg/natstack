/**
 * Tests for WorkerdManager — instance lifecycle, config generation,
 * name sanitization, and rebuild handling.
 */

import {
  WorkerdManager,
  type WorkerdManagerDeps,
  type WorkerCreateOptions,
} from "./workerdManager.js";
import { spawn } from "child_process";
import { findServicePort } from "@natstack/port-utils";
import type { BuildResult } from "./buildV2/buildStore.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Mock child_process to prevent actual workerd spawning
vi.mock("child_process", () => ({
  spawn: vi.fn(() => {
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    const proc = {
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(fn);
        return proc;
      }),
      once: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(fn);
        return proc;
      }),
      removeListener: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
        listeners.get(event)?.delete(fn);
        return proc;
      }),
      kill: vi.fn(() => {
        // Simulate process exit after kill
        setTimeout(() => {
          for (const fn of listeners.get("exit") ?? [])
            (fn as (code: number | null, signal: string | null) => void)(null, "SIGTERM");
        }, 0);
      }),
      pid: 12345,
      exitCode: null,
    };
    return proc;
  }),
}));

// Mock port-utils
vi.mock("@natstack/port-utils", () => ({
  findServicePort: vi.fn(async (service: string) =>
    service === "workerdInspector" ? 49652 : 49552
  ),
  releaseServicePort: vi.fn(),
}));

function mockWorkerBuild(
  bundle = 'export default { fetch() { return new Response("ok"); } };'
): BuildResult {
  return {
    dir: "/tmp/test-build",
    metadata: {
      kind: "worker",
      name: "workers/hello",
      ev: "abc123",
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

function createMockDeps(overrides: Partial<WorkerdManagerDeps> = {}): WorkerdManagerDeps {
  return {
    tokenManager: {
      ensureToken: vi.fn().mockReturnValue("mock-token-123"),
      revokeToken: vi.fn(),
    } as unknown as WorkerdManagerDeps["tokenManager"],
    fsService: {
      closeHandlesForCaller: vi.fn(),
    } as unknown as WorkerdManagerDeps["fsService"],
    getServerUrl: () => "http://127.0.0.1:9999",
    getBuild: vi.fn().mockResolvedValue(mockWorkerBuild()),
    workspacePath: "/tmp/test-workspace",
    statePath: "/tmp/test-workspace-state",
    getProxyPort: () => 49444,
    getSharedEgressPort: () => Promise.resolve(49555),
    registerEgressCaller: () => {},
    unregisterEgressCaller: () => {},
    getWorkerdGatewayToken: () => "mock-workerd-gateway-token",
    workerdStartupReadyTimeoutMs: 50,
    ...overrides,
  };
}

function defaultCreateOptions(overrides: Partial<WorkerCreateOptions> = {}): WorkerCreateOptions {
  return {
    source: "workers/hello",
    contextId: "ctx-1",
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 204 }))
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(findServicePort).mockImplementation(
    async (service: Parameters<typeof findServicePort>[0]) =>
      service === "workerdInspector" ? 49652 : 49552
  );
});

describe("WorkerdManager", () => {
  // -------------------------------------------------------------------------
  // Instance lifecycle
  // -------------------------------------------------------------------------
  describe("createInstance", () => {
    it("creates an instance with correct fields", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);

      const instance = await mgr.createInstance(defaultCreateOptions());

      expect(instance.name).toBe("hello");
      expect(instance.source).toBe("workers/hello");
      expect(instance.contextId).toBe("ctx-1");
      expect(instance.callerId).toBe("worker:hello");
      expect(instance.token).toBe("mock-token-123");
      expect(instance.status).toBe("running");
    });

    it("stores parent handle metadata and injects it into the worker runtime bindings", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);

      const instance = await mgr.createInstance(
        defaultCreateOptions({
          parentId: "panel-parent",
          parentEntityId: "panel:parent-entity",
          parentKind: "panel",
        })
      );

      expect(instance.parentId).toBe("panel-parent");
      expect(instance.parentEntityId).toBe("panel:parent-entity");
      expect(instance.parentKind).toBe("panel");
      // Regular workers load dynamically — parent metadata travels in the
      // per-instance env served by `/_workercode`, not the workerd config.
      const code = await mgr.getWorkerCode("hello");
      expect(code?.env["PARENT_ID"]).toBe("panel-parent");
      expect(code?.env["PARENT_ENTITY_ID"]).toBe("panel:parent-entity");
      expect(code?.env["PARENT_KIND"]).toBe("panel");
    });

    it("mints a bearer token for the worker callerId", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);

      await mgr.createInstance(defaultCreateOptions());

      expect(deps.tokenManager.ensureToken).toHaveBeenCalledWith("worker:hello", "worker");
    });

    it("rejects duplicate instance names", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);

      await mgr.createInstance(defaultCreateOptions());
      await expect(mgr.createInstance(defaultCreateOptions())).rejects.toThrow(
        'Worker instance "hello" already exists'
      );
    });

    it("uses explicit name when provided", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);

      const instance = await mgr.createInstance(defaultCreateOptions({ name: "my-worker" }));
      expect(instance.name).toBe("my-worker");
      expect(instance.callerId).toBe("worker:my-worker");
    });

    it("records a lifecycle event and lastError on failed start, cleared by a later success", async () => {
      const recordLifecycleEvent = vi.fn();
      const getBuild = vi.fn().mockRejectedValueOnce(new Error("boom"));
      const deps = createMockDeps({ getBuild, recordLifecycleEvent });
      const mgr = new WorkerdManager(deps);

      await expect(mgr.createInstance(defaultCreateOptions())).rejects.toThrow("boom");

      expect(recordLifecycleEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "workers/hello",
          callerId: "worker:hello",
          level: "error",
          message: "Worker failed to start: boom",
          fields: expect.objectContaining({ event: "worker-start-failed" }),
        })
      );
      expect(mgr.getLastWorkerError("workers/hello")).toEqual(
        expect.objectContaining({ message: "boom", timestamp: expect.any(Number) })
      );

      // Subsequent successful start clears the recorded failure.
      getBuild.mockResolvedValue(mockWorkerBuild());
      await mgr.createInstance(defaultCreateOptions());

      expect(mgr.getLastWorkerError("workers/hello")).toBeNull();
      expect(recordLifecycleEvent).toHaveBeenLastCalledWith(
        expect.objectContaining({
          source: "workers/hello",
          level: "info",
          fields: expect.objectContaining({ event: "worker-started" }),
        })
      );
    });

    it("rolls back on build failure", async () => {
      const deps = createMockDeps({
        getBuild: vi.fn().mockRejectedValue(new Error("build failed")),
      });
      const mgr = new WorkerdManager(deps);

      await expect(mgr.createInstance(defaultCreateOptions())).rejects.toThrow("build failed");

      expect(deps.tokenManager.revokeToken).toHaveBeenCalledWith("worker:hello");
      expect(mgr.listInstances()).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Name sanitization
  // -------------------------------------------------------------------------
  describe("name sanitization", () => {
    it("sanitizes special characters in names", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);

      const instance = await mgr.createInstance(
        defaultCreateOptions({ name: 'hello"; process.exit();//' })
      );
      // All non-alphanumeric/dash/underscore chars replaced
      expect(instance.name).not.toContain('"');
      expect(instance.name).not.toContain(";");
      expect(instance.name).toMatch(/^[a-zA-Z0-9_-]+$/);
    });

    it("derives name from last path segment", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);

      const instance = await mgr.createInstance(
        defaultCreateOptions({ source: "workspace/workers/my-api" })
      );
      expect(instance.name).toBe("my-api");
    });
  });

  // -------------------------------------------------------------------------
  // Ref-specific builds
  // -------------------------------------------------------------------------
  describe("ref builds", () => {
    it("stores ref when provided", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);

      const instance = await mgr.createInstance(defaultCreateOptions({ ref: "abc123" }));

      expect(instance.ref).toBe("abc123");
      expect(deps.getBuild).toHaveBeenCalledWith("workers/hello", "abc123");
    });

    it("passes undefined ref when not provided", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);

      const instance = await mgr.createInstance(defaultCreateOptions());

      expect(instance.ref).toBeUndefined();
      expect(deps.getBuild).toHaveBeenCalledWith("workers/hello", undefined);
    });
  });

  // -------------------------------------------------------------------------
  // destroyInstance
  // -------------------------------------------------------------------------
  describe("destroyInstance", () => {
    it("cleans up token, context, and handles", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);

      await mgr.createInstance(defaultCreateOptions());
      await mgr.destroyInstance("hello");

      expect(deps.tokenManager.revokeToken).toHaveBeenCalledWith("worker:hello");
      expect(deps.fsService.closeHandlesForCaller).toHaveBeenCalledWith("worker:hello");
      expect(mgr.listInstances()).toHaveLength(0);
    });

    it("throws for unknown instance", async () => {
      const mgr = new WorkerdManager(createMockDeps());
      await expect(mgr.destroyInstance("nope")).rejects.toThrow('Worker instance "nope" not found');
    });
  });

  // -------------------------------------------------------------------------
  // updateInstance
  // -------------------------------------------------------------------------
  describe("updateInstance", () => {
    it("updates env", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);

      await mgr.createInstance(defaultCreateOptions());
      const updated = await mgr.updateInstance("hello", {
        env: { FOO: "bar" },
      });

      expect(updated.env).toEqual({ FOO: "bar" });
    });

    it("sets ref on update", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);

      await mgr.createInstance(defaultCreateOptions());
      const updated = await mgr.updateInstance("hello", { ref: "feature/x" });

      expect(updated.ref).toBe("feature/x");
    });

    it("clears ref on update with empty string", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);

      await mgr.createInstance(defaultCreateOptions({ ref: "abc123" }));
      const updated = await mgr.updateInstance("hello", { ref: "" });

      expect(updated.ref).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // listInstances / getInstanceStatus
  // -------------------------------------------------------------------------
  describe("listing", () => {
    it("listInstances strips tokens", async () => {
      const mgr = new WorkerdManager(createMockDeps());
      await mgr.createInstance(defaultCreateOptions());

      const list = mgr.listInstances();
      expect(list).toHaveLength(1);
      expect(list[0]).not.toHaveProperty("token");
      expect(list[0]!.name).toBe("hello");
    });

    it("getInstanceStatus strips token", async () => {
      const mgr = new WorkerdManager(createMockDeps());
      await mgr.createInstance(defaultCreateOptions());

      const status = mgr.getInstanceStatus("hello");
      expect(status).not.toBeNull();
      expect(status).not.toHaveProperty("token");
    });

    it("getInstanceStatus returns null for unknown", () => {
      const mgr = new WorkerdManager(createMockDeps());
      expect(mgr.getInstanceStatus("nope")).toBeNull();
    });

    it("starts workerd with a dev inspector and exposes it for running workers", async () => {
      const mgr = new WorkerdManager(createMockDeps());

      await mgr.createInstance(defaultCreateOptions());

      expect(spawn).toHaveBeenLastCalledWith(
        expect.any(String),
        expect.arrayContaining(["--inspector-addr=127.0.0.1:49652"]),
        expect.any(Object)
      );
      expect(mgr.getWorkerInspectorUrl("workers/hello")).toBe("http://127.0.0.1:49652");
      expect(mgr.getWorkerInspectorUrl("workers/missing")).toBeNull();
    });

    it("retries startup on a fresh port when the router never becomes ready", async () => {
      let workerdPortCalls = 0;
      vi.mocked(findServicePort).mockImplementation(
        async (service: Parameters<typeof findServicePort>[0]) => {
          if (service === "workerdInspector") return 49652;
          return workerdPortCalls++ === 0 ? 49552 : 49553;
        }
      );
      const fetchMock = vi.fn(async (url: string | URL | Request) => {
        const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
        if (href.includes(":49552/")) throw new TypeError("fetch failed");
        return new Response(null, { status: 204 });
      });
      vi.stubGlobal("fetch", fetchMock);

      const mgr = new WorkerdManager(createMockDeps());
      await mgr.createInstance(defaultCreateOptions());

      expect(mgr.getPort()).toBe(49553);
      expect(fetchMock).toHaveBeenCalledWith(
        "http://127.0.0.1:49552/__natstack_workerd_ready",
        expect.any(Object)
      );
      expect(fetchMock).toHaveBeenCalledWith(
        "http://127.0.0.1:49553/__natstack_workerd_ready",
        expect.any(Object)
      );
    });
  });

  // -------------------------------------------------------------------------
  // onSourceRebuilt
  // -------------------------------------------------------------------------
  describe("onSourceRebuilt", () => {
    it("reloads HEAD-tracking instances via a codeVersion bump (no restart)", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);

      await mgr.createInstance(defaultCreateOptions());
      const before = mgr.getWorkerVersion("hello");
      await mgr.onSourceRebuilt("workers/hello");

      // No restart — the worker host reloads on its next request because the
      // loader-cache version bumped. The instance stays "running" throughout.
      expect(mgr.getInstanceStatus("hello")?.status).toBe("running");
      expect(mgr.getWorkerVersion("hello")).toBe((before ?? 0) + 1);
    });

    it("skips ref-targeted instances", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);

      await mgr.createInstance(defaultCreateOptions({ ref: "abc123" }));
      const callsBefore = vi.mocked(deps.getBuild).mock.calls.length;

      // Ref-targeted instance should not restart on HEAD push
      await mgr.onSourceRebuilt("workers/hello");

      const status = mgr.getInstanceStatus("hello");
      expect(status?.status).toBe("running");
      // No additional getBuild calls — rebuild was skipped
      expect(deps.getBuild).toHaveBeenCalledTimes(callsBefore);
    });

    it("does not restart workerd on a source rebuild", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);

      await mgr.createInstance(defaultCreateOptions());
      const spawnsBefore = vi.mocked(spawn).mock.calls.length;

      await mgr.onSourceRebuilt("workers/hello");

      // Dynamic loading: a rebuild is a loader-cache eviction, never a restart.
      expect(vi.mocked(spawn).mock.calls.length).toBe(spawnsBefore);
      expect(mgr.getInstanceStatus("hello")?.status).toBe("running");
    });

    it("ignores unrelated sources", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);

      await mgr.createInstance(defaultCreateOptions());
      const callsBefore = vi.mocked(deps.getBuild).mock.calls.length;

      await mgr.onSourceRebuilt("workers/other");

      // No additional getBuild calls (no restart triggered)
      expect(vi.mocked(deps.getBuild).mock.calls.length).toBe(callsBefore);
    });

    it("tears down stale DO services when a class is removed from the manifest", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);

      // Pre-register two DO classes from the same source.
      await mgr.registerAllDOClasses([
        { source: "workers/agent", className: "AgentDO" },
        { source: "workers/agent", className: "LegacyDO" },
      ]);

      const revokeSpy = vi.spyOn(deps.tokenManager, "revokeToken");

      // Manifest is re-read after a rebuild and now only declares AgentDO.
      await mgr.onSourceRebuilt("workers/agent", [{ className: "AgentDO" }]);

      // LegacyDO's service-level token was revoked.
      expect(revokeSpy).toHaveBeenCalledWith("do-service:workers/agent:LegacyDO");
      // The entry is gone from the map — config regeneration won't emit it.
      expect(revokeSpy).not.toHaveBeenCalledWith("do-service:workers/agent:AgentDO");
    });

    it("leaves DO services alone when doClasses is undefined", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);

      await mgr.registerAllDOClasses([{ source: "workers/agent", className: "AgentDO" }]);

      const revokeSpy = vi.spyOn(deps.tokenManager, "revokeToken");
      await mgr.onSourceRebuilt("workers/agent");

      // No revokes — the caller passed `undefined` meaning "don't touch DOs".
      expect(revokeSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("do-service:workers/agent")
      );
    });

    it("tears down all DO services when manifest drops the durable block entirely", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);

      await mgr.registerAllDOClasses([
        { source: "workers/agent", className: "A" },
        { source: "workers/agent", className: "B" },
      ]);

      const revokeSpy = vi.spyOn(deps.tokenManager, "revokeToken");
      // Empty array = "manifest declares no DO classes now" → remove all.
      await mgr.onSourceRebuilt("workers/agent", []);

      expect(revokeSpy).toHaveBeenCalledWith("do-service:workers/agent:A");
      expect(revokeSpy).toHaveBeenCalledWith("do-service:workers/agent:B");
    });

    it("does NOT probe-and-restart a live workerd on ensureDO (A1: no false-positive restarts)", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);

      // Bring workerd up first (a worker create starts the static host); then
      // register a userland DO class — which by itself never restarts.
      await mgr.createInstance(defaultCreateOptions());
      await mgr.registerAllDOClasses([{ source: "workers/agent", className: "AgentDO" }]);

      const restartBegin = vi.fn();
      mgr.onRestartBegin(restartBegin);

      // If ensureDO probed HTTP readiness, a rejecting fetch would (old behavior)
      // trigger a restart. The new contract: a live, registered process is left
      // alone — no readiness fetch, no restart. (Userland DO classes load into
      // the static universal-do host, so they never restart regardless.)
      const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
      vi.stubGlobal("fetch", fetchMock);

      try {
        await expect(mgr.ensureDO("workers/agent", "AgentDO", "object-1")).resolves.toBeUndefined();
      } finally {
        vi.unstubAllGlobals();
      }

      expect(fetchMock).not.toHaveBeenCalled();
      expect(restartBegin).not.toHaveBeenCalled();
    });
  });

  describe("restart lifecycle hooks and boot generation", () => {
    it("skips restart hooks on initial start but emits them for real restarts", async () => {
      const statePath = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-workerd-test-"));
      const mgr = new WorkerdManager(createMockDeps({ statePath }));
      const begin = vi.fn();
      const ready = vi.fn();
      mgr.onRestartBegin(begin);
      mgr.onRestartReady(ready);

      await mgr.createInstance(defaultCreateOptions());
      expect(begin).not.toHaveBeenCalled();
      expect(ready).not.toHaveBeenCalled();
      expect(mgr.getBootGeneration()).toBe(1);

      // Worker update no longer restarts (the host is static); a real restart
      // (e.g. an explicit restartAll, or internal-config change) still emits the
      // begin/ready hooks and bumps the boot generation.
      await mgr.restartAll();

      expect(begin).toHaveBeenCalledTimes(1);
      expect(ready).toHaveBeenCalledTimes(1);
      expect(ready.mock.calls[0]?.[0]).toMatchObject({
        generation: 2,
        previousGeneration: 1,
        reason: "planned",
      });
      expect(fs.readFileSync(path.join(statePath, ".boot-generation"), "utf8").trim()).toBe("2");

      const nextMgr = new WorkerdManager(createMockDeps({ statePath }));
      expect(nextMgr.getBootGeneration()).toBe(2);
    });
  });

  describe("router generation", () => {
    it("routes source-scoped DO requests with arbitrary-depth source paths", async () => {
      const mgr = new WorkerdManager(createMockDeps());
      const code = (
        mgr as unknown as {
          generateRouterCode(
            doClassNames: { className: string; source: string; serviceName: string }[]
          ): string;
        }
      ).generateRouterCode([
        {
          source: "workspace/workers/gad-store",
          className: "EventStore",
          serviceName: "do_workspace_workers_gad_store_EventStore",
        },
      ]);
      const router = new Function(`${code.replace("export default", "return")}`)() as {
        fetch(request: Request, env: Record<string, unknown>): Promise<Response>;
      };
      const fetchedUrls: string[] = [];
      const env = {
        WORKERD_GATEWAY_TOKEN: "mock-workerd-gateway-token",
        WORKERD_DISPATCH_SECRET: mgr.getDispatchSecret(),
        do_workspace_workers_gad_store_EventStore: {
          idFromName: vi.fn((name: string) => ({ name })),
          get: vi.fn(() => ({
            fetch: vi.fn(async (request: Request) => {
              fetchedUrls.push(request.url);
              return new Response("ok");
            }),
          })),
        },
      };

      const response = await router.fetch(
        new Request(
          "http://router/_w/workspace/workers/gad-store/EventStore/ctx%2Fchat/appendEvents?x=1",
          {
            headers: {
              Authorization: "Bearer mock-workerd-gateway-token",
              "X-NatStack-Dispatch-Secret": mgr.getDispatchSecret(),
            },
          }
        ),
        env
      );

      expect(response.status).toBe(200);
      expect(env.do_workspace_workers_gad_store_EventStore.idFromName).toHaveBeenCalledWith(
        "ctx/chat"
      );
      expect(fetchedUrls).toEqual(["http://router/ctx%2Fchat/appendEvents?x=1"]);
    });

    it("rejects source-scoped DO requests without the dispatch secret", async () => {
      const mgr = new WorkerdManager(createMockDeps());
      const code = (
        mgr as unknown as {
          generateRouterCode(
            doClassNames: { className: string; source: string; serviceName: string }[]
          ): string;
        }
      ).generateRouterCode([
        {
          source: "workspace/workers/gad-store",
          className: "EventStore",
          serviceName: "do_workspace_workers_gad_store_EventStore",
        },
      ]);
      const router = new Function(`${code.replace("export default", "return")}`)() as {
        fetch(request: Request, env: Record<string, unknown>): Promise<Response>;
      };
      const doFetch = vi.fn(async () => new Response("ok"));
      const env = {
        WORKERD_GATEWAY_TOKEN: "mock-workerd-gateway-token",
        WORKERD_DISPATCH_SECRET: mgr.getDispatchSecret(),
        do_workspace_workers_gad_store_EventStore: {
          idFromName: vi.fn((name: string) => ({ name })),
          get: vi.fn(() => ({ fetch: doFetch })),
        },
      };

      const response = await router.fetch(
        new Request("http://router/_w/workspace/workers/gad-store/EventStore/ctx/appendEvents", {
          headers: { Authorization: "Bearer mock-workerd-gateway-token" },
        }),
        env
      );

      expect(response.status).toBe(403);
      expect(doFetch).not.toHaveBeenCalled();
    });
  });
});
