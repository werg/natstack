/**
 * Tests for WorkerdManager — instance lifecycle, config generation,
 * name sanitization, and rebuild handling.
 */

import {
  isExpectedEvalIdleEvictionWorkerdStderr,
  WorkerdManager,
  type WorkerdManagerDeps,
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
    sourceStateHash: "state:test",
    metadata: {
      kind: "worker",
      name: "workers/hello",
      ev: "abc123",
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

function createMockDeps(overrides: Partial<WorkerdManagerDeps> = {}): WorkerdManagerDeps {
  const build = mockWorkerBuild();
  return {
    tokenManager: {
      ensureToken: vi.fn().mockReturnValue("mock-token-123"),
      revokeToken: vi.fn(),
    } as unknown as WorkerdManagerDeps["tokenManager"],
    fsService: {
      closeHandlesForCaller: vi.fn(),
    } as unknown as WorkerdManagerDeps["fsService"],
    getServerUrl: () => "http://127.0.0.1:9999",
    bindRuntimeImage: vi.fn(async (unitPath: string, ref?: string) => ({
      source: unitPath,
      unitName: unitPath,
      stateHash: ref?.startsWith("state:") ? ref : "state:test",
      effectiveVersion: build.metadata.ev,
      buildKey: `build:${unitPath}:${ref ?? "main"}`,
    })),
    getBuildByKey: vi.fn(() => build),
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

type StartWorkerArgs = Parameters<WorkerdManager["startWorker"]>[0];

/** Default args for the runtime-managed worker-launch path (startWorker). */
function startArgs(overrides: Partial<StartWorkerArgs> = {}): StartWorkerArgs {
  return {
    source: "workers/hello",
    key: "hello",
    contextId: "ctx-1",
    ...overrides,
  };
}

/** Status of a live worker instance by sanitized name (replaces getInstanceStatus). */
function statusOf(mgr: WorkerdManager, name: string) {
  return mgr.listInstances().find((instance) => instance.name === name) ?? null;
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

describe("workerd stderr filtering", () => {
  it("identifies only expected EvalDO idle-eviction aborts", () => {
    expect(
      isExpectedEvalIdleEvictionWorkerdStderr(
        "workerd/server/server.c++:5350: error: Uncaught exception: failed: remote.jsg.Error: EvalDO: idle eviction (reclaim memory; SQLite preserved)"
      )
    ).toBe(true);
    expect(
      isExpectedEvalIdleEvictionWorkerdStderr(
        "workerd/server/server.c++:5350: error: Uncaught exception: failed: remote.jsg.Error: different failure"
      )
    ).toBe(false);
  });
});

describe("WorkerdManager", () => {
  // -------------------------------------------------------------------------
  // Instance lifecycle
  // -------------------------------------------------------------------------
  describe("startWorker", () => {
    it("mints a bearer token for the worker entity callerId", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);

      await mgr.startWorker(startArgs());

      expect(deps.tokenManager.ensureToken).toHaveBeenCalledWith(
        "worker:workers/hello:hello",
        "worker"
      );
    });

    it("injects parent handle metadata into the worker runtime env", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);

      await mgr.startWorker(
        startArgs({
          parent: {
            parentId: "panel-parent",
            parentEntityId: "panel:parent-entity",
            parentKind: "panel",
          },
        })
      );

      // Workers load dynamically — parent metadata travels in the per-instance env
      // served by `/_workercode`, not the workerd config.
      const code = await mgr.getWorkerCode("hello");
      expect(code?.env["PARENT_ID"]).toBe("panel-parent");
      expect(code?.env["PARENT_ENTITY_ID"]).toBe("panel:parent-entity");
      expect(code?.env["PARENT_KIND"]).toBe("panel");
    });

    it("is idempotent for a live duplicate of the same identity (no-op re-attach)", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);

      const first = await mgr.startWorker(startArgs());
      // Same (source, key, contextId) → returns the existing instance as a no-op.
      const again = await mgr.startWorker(startArgs());

      expect(again).toEqual(first);
      expect(mgr.listInstances()).toHaveLength(1);
    });

    it("rejects a sanitized-name collision from a different identity (full targetId match required)", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);

      await mgr.startWorker(startArgs());
      // Same key (→ same sanitized name) but a different source ⇒ different
      // targetId ⇒ genuine collision, not a re-attach.
      await expect(mgr.startWorker(startArgs({ source: "workers/other" }))).rejects.toThrow(
        /different identity/
      );
      // Distinct raw keys that sanitize to the SAME name (`a:b` and `a_b`) ⇒
      // different targetId ⇒ must throw, not silently reuse the first worker.
      await mgr.startWorker(startArgs({ source: "workers/x", key: "a:b" }));
      await expect(mgr.startWorker(startArgs({ source: "workers/x", key: "a_b" }))).rejects.toThrow(
        /different identity/
      );
    });

    it("rejects the same (source, key) in another context (no silent cross-context reuse)", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);

      await mgr.startWorker(startArgs());
      // Same source+key maps to the same (context-free) targetId, but a launch in
      // a DIFFERENT context must NOT silently reuse the ctx-1 worker — reattach
      // requires a contextId match too. Callers must use context-unique keys
      // until worker canonical ids include contextId (tracked follow-up).
      await expect(mgr.startWorker(startArgs({ contextId: "ctx-2" }))).rejects.toThrow(
        /different identity/
      );
      expect(mgr.listInstances()).toHaveLength(1);
    });

    it("records a lifecycle event and lastError on failed start, cleared by a later success", async () => {
      const recordLifecycleEvent = vi.fn();
      const bindRuntimeImage = vi.fn().mockRejectedValueOnce(new Error("boom"));
      const deps = createMockDeps({ bindRuntimeImage, recordLifecycleEvent });
      const mgr = new WorkerdManager(deps);

      await expect(mgr.startWorker(startArgs())).rejects.toThrow("boom");

      expect(recordLifecycleEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "workers/hello",
          callerId: "worker:workers/hello:hello",
          level: "error",
          message: "Worker failed to start: boom",
          fields: expect.objectContaining({ event: "worker-start-failed" }),
        })
      );
      expect(mgr.getLastWorkerError("workers/hello")).toEqual(
        expect.objectContaining({ message: "boom", timestamp: expect.any(Number) })
      );

      // Subsequent successful start clears the recorded failure.
      bindRuntimeImage.mockResolvedValue({
        source: "workers/hello",
        unitName: "workers/hello",
        stateHash: "main",
        effectiveVersion: "workers/hello@main",
        buildKey: "build:workers/hello:main",
      });
      await mgr.startWorker(startArgs());

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
        bindRuntimeImage: vi.fn().mockRejectedValue(new Error("build failed")),
      });
      const mgr = new WorkerdManager(deps);

      await expect(mgr.startWorker(startArgs())).rejects.toThrow("build failed");

      expect(deps.tokenManager.revokeToken).toHaveBeenCalledWith("worker:workers/hello:hello");
      expect(mgr.listInstances()).toHaveLength(0);
    });

    it("sanitizes special characters in the entity key", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);

      await mgr.startWorker(startArgs({ key: 'hello"; process.exit();//' }));
      const [instance] = mgr.listInstances();
      // All non-alphanumeric/dash/underscore chars replaced
      expect(instance?.name).not.toContain('"');
      expect(instance?.name).not.toContain(";");
      expect(instance?.name).toMatch(/^[a-zA-Z0-9_-]+$/);
    });
  });

  // -------------------------------------------------------------------------
  // Ref-specific builds
  // -------------------------------------------------------------------------
  describe("ref builds", () => {
    it("stores explicit state ref when provided", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);

      await mgr.startWorker(startArgs({ ref: "state:abc123" }));

      expect(statusOf(mgr, "hello")?.scopeRef).toBe("state:abc123");
      expect(deps.bindRuntimeImage).toHaveBeenCalledWith("workers/hello", "state:abc123");
    });

    it("binds main when no ref is provided", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);

      await mgr.startWorker(startArgs());

      expect(statusOf(mgr, "hello")?.scopeRef).toBeUndefined();
      expect(deps.bindRuntimeImage).toHaveBeenCalledWith("workers/hello", undefined);
    });

    it("binds runtime-managed workers to main by default", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);

      const prepared = await mgr.startWorker({
        source: "workers/new",
        key: "new-worker",
        contextId: "ctx-agent",
      });

      expect(prepared.effectiveVersion).toBe("abc123");
      expect(deps.bindRuntimeImage).toHaveBeenCalledWith("workers/new", undefined);
    });

    it("honors explicit context refs for runtime-managed workers", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);

      await mgr.startWorker({
        source: "workers/new",
        key: "new-worker",
        contextId: "ctx-agent",
        ref: "ctx:ctx-agent",
      });

      expect(deps.bindRuntimeImage).toHaveBeenCalledWith("workers/new", "ctx:ctx-agent");
      expect(statusOf(mgr, "new-worker")?.scopeRef).toBe("ctx:ctx-agent");
    });

    it("binds runtime-managed DOs to main by default", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);

      await mgr.ensureDurableObjectEntity({
        source: "workers/new-do",
        className: "NewDO",
        key: "k1",
        contextId: "ctx-agent",
      });

      expect(deps.bindRuntimeImage).toHaveBeenCalledWith("workers/new-do", undefined);
    });

    it("honors explicit context refs for runtime-managed DO object images", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);

      await mgr.ensureDurableObjectEntity({
        source: "workers/new-do",
        className: "NewDO",
        key: "main-object",
        contextId: "ctx-agent",
      });
      vi.mocked(deps.bindRuntimeImage).mockClear();

      await mgr.ensureDurableObjectEntity({
        source: "workers/new-do",
        className: "NewDO",
        key: "branch-object",
        contextId: "ctx-agent",
        ref: "ctx:ctx-agent",
      });

      expect(deps.bindRuntimeImage).toHaveBeenCalledTimes(1);
      expect(deps.bindRuntimeImage).toHaveBeenCalledWith("workers/new-do", "ctx:ctx-agent");
      expect(mgr.getDoVersion("workers/new-do", "NewDO", "branch-object")).not.toBeNull();
    });

    it("binds bootstrap-style singleton DOs to explicit main instead of synthetic ctx heads", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);
      const syntheticContextId = "5b0784b0a6d5b81c3ba856394cb1eb6e456e4716ab43030e62d2e8de77a6d2de";

      const prepared = await mgr.ensureDurableObjectEntity({
        source: "workers/model-settings",
        className: "ModelSettingsDO",
        key: "workspace-model-settings",
        contextId: syntheticContextId,
        ref: "main",
      });

      expect(prepared.targetId).toBe(
        "do:workers/model-settings:ModelSettingsDO:workspace-model-settings"
      );
      expect(deps.bindRuntimeImage).toHaveBeenCalledWith("workers/model-settings", "main");
    });
  });

  // -------------------------------------------------------------------------
  // updateInstance (internal: codeVersion bump / ref retarget, no userland RPC)
  // -------------------------------------------------------------------------
  describe("updateInstance", () => {
    it("updates env", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);

      await mgr.startWorker(startArgs());
      const updated = await mgr.updateInstance("hello", {
        env: { FOO: "bar" },
      });

      expect(updated.env).toEqual({ FOO: "bar" });
    });

    it("sets ref on update", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);

      await mgr.startWorker(startArgs());
      const updated = await mgr.updateInstance("hello", { ref: "state:feature-x" });

      expect(updated.scopeRef).toBe("state:feature-x");
    });

    it("restores main tracking on update with empty string", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);

      await mgr.startWorker(startArgs({ ref: "state:abc123" }));
      const updated = await mgr.updateInstance("hello", { ref: "" });

      expect(updated.scopeRef).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // listInstances
  // -------------------------------------------------------------------------
  describe("listing", () => {
    it("listInstances strips tokens", async () => {
      const mgr = new WorkerdManager(createMockDeps());
      await mgr.startWorker(startArgs());

      const list = mgr.listInstances();
      expect(list).toHaveLength(1);
      expect(list[0]).not.toHaveProperty("token");
      expect(list[0]!.name).toBe("hello");
    });

    it("listInstances has no entry for an unknown name", () => {
      const mgr = new WorkerdManager(createMockDeps());
      expect(statusOf(mgr, "nope")).toBeNull();
    });

    it("starts workerd with a dev inspector and exposes it for running workers", async () => {
      const mgr = new WorkerdManager(createMockDeps());

      await mgr.startWorker(startArgs());

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
      await mgr.startWorker(startArgs());

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
    it("reloads main-tracking instances via a codeVersion bump (no restart)", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);

      await mgr.startWorker(startArgs());
      const before = mgr.getWorkerVersion("hello");
      await mgr.onSourceRebuilt(
        "workers/hello",
        undefined,
        {
          head: "main",
          stateHash: "state:next",
          repoStateHash: "state:next",
          sinceStateHash: "state:prev",
          eventId: "event:next",
          headHash: "head:next",
          actor: { id: "user", kind: "user" },
          transitionKind: "snapshot",
          changedPaths: ["workers/hello/index.ts"],
          fileChanges: [],
          editOps: [],
        },
        "build:workers/hello:main"
      );

      // No restart — the worker host reloads on its next request because the
      // loader-cache version bumped. The instance stays "running" throughout.
      expect(statusOf(mgr, "hello")?.status).toBe("running");
      expect(mgr.getWorkerVersion("hello")).toBe((before ?? 0) + 1);
    });

    it("keeps rebuild codeVersion strictly above prior env-only updates", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);

      await mgr.startWorker(startArgs());
      await mgr.updateInstance("hello", { env: { FEATURE: "enabled" } });
      const beforeRebuild = mgr.getWorkerVersion("hello");

      await mgr.onSourceRebuilt(
        "workers/hello",
        undefined,
        {
          head: "main",
          stateHash: "state:next",
          repoStateHash: "state:next",
          sinceStateHash: "state:prev",
          eventId: "event:next",
          headHash: "head:next",
          actor: { id: "user", kind: "user" },
          transitionKind: "snapshot",
          changedPaths: ["workers/hello/index.ts"],
          fileChanges: [],
          editOps: [],
        },
        "build:workers/hello:main"
      );

      expect(mgr.getWorkerVersion("hello")).toBe((beforeRebuild ?? 0) + 1);
    });

    it("marks failed runtime image rebinds terminal after the warm attempt fails", async () => {
      const buildKey = "build:workers/hello:main";
      const bindRuntimeImage = vi
        .fn()
        .mockResolvedValueOnce({
          source: "workers/hello",
          unitName: "workers/hello",
          stateHash: "state:test",
          effectiveVersion: "workers/hello@main",
          buildKey,
        })
        .mockRejectedValueOnce(new Error("Unknown vcs ref: ctx:deleted"));
      const deps = createMockDeps({
        bindRuntimeImage,
        getBuildByKey: vi.fn(() => null),
        statePath: fs.mkdtempSync(path.join(os.tmpdir(), "natstack-runtime-image-error-")),
      });
      const mgr = new WorkerdManager(deps);

      await mgr.startWorker(startArgs());

      await expect(mgr.getWorkerCode("hello")).rejects.toMatchObject({
        code: "RUNTIME_IMAGE_WARMING",
      });
      await vi.waitFor(() => expect(bindRuntimeImage).toHaveBeenCalledTimes(2));
      await expect(mgr.getWorkerCode("hello")).rejects.toMatchObject({
        code: "RUNTIME_IMAGE_UNAVAILABLE",
        message: expect.stringContaining("Unknown vcs ref: ctx:deleted"),
      });
    });

    it("skips ref-targeted instances", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);

      await mgr.startWorker(startArgs({ ref: "state:abc123" }));
      const callsBefore = vi.mocked(deps.bindRuntimeImage).mock.calls.length;

      // Ref-targeted instance should not restart on HEAD push
      await mgr.onSourceRebuilt(
        "workers/hello",
        undefined,
        {
          head: "main",
          stateHash: "state:next",
          repoStateHash: "state:next",
          sinceStateHash: "state:prev",
          eventId: "event:next",
          headHash: "head:next",
          actor: { id: "user", kind: "user" },
          transitionKind: "snapshot",
          changedPaths: ["workers/hello/index.ts"],
          fileChanges: [],
          editOps: [],
        },
        "build:workers/hello:main"
      );

      const status = statusOf(mgr, "hello");
      expect(status?.status).toBe("running");
      // No additional bind calls — rebuild was skipped
      expect(deps.bindRuntimeImage).toHaveBeenCalledTimes(callsBefore);
    });

    it("does not restart workerd on a source rebuild", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);

      await mgr.startWorker(startArgs());
      const spawnsBefore = vi.mocked(spawn).mock.calls.length;

      await mgr.onSourceRebuilt("workers/hello");

      // Dynamic loading: a rebuild is a loader-cache eviction, never a restart.
      expect(vi.mocked(spawn).mock.calls.length).toBe(spawnsBefore);
      expect(statusOf(mgr, "hello")?.status).toBe("running");
    });

    it("ignores unrelated sources", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);

      await mgr.startWorker(startArgs());
      const callsBefore = vi.mocked(deps.bindRuntimeImage).mock.calls.length;

      await mgr.onSourceRebuilt("workers/other");

      // No additional bind calls (no restart triggered)
      expect(vi.mocked(deps.bindRuntimeImage).mock.calls.length).toBe(callsBefore);
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
      await mgr.startWorker(startArgs());
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

  describe("universal DO host", () => {
    it("shares dynamically loaded DO module graphs across object keys for the same version", () => {
      const mgr = new WorkerdManager(createMockDeps());
      const code = (
        mgr as unknown as {
          generateUniversalDOCode(): string;
        }
      ).generateUniversalDOCode();

      expect(code).toContain('env.LOADER.get(identity + "@" + version');
      expect(code).not.toContain("loaderIdentity");
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

      await mgr.startWorker(startArgs());
      expect(begin).not.toHaveBeenCalled();
      expect(ready).not.toHaveBeenCalled();
      expect(mgr.getBootGeneration()).toBe(1);

      // Worker update no longer restarts (the host is static); a real restart
      // (e.g. an internal-config change) still emits the begin/ready hooks and
      // bumps the boot generation. restartWorkerd is the internal restart entry.
      await (mgr as unknown as { restartWorkerd(): Promise<void> }).restartWorkerd();

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
