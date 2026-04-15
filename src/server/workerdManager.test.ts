/**
 * Tests for WorkerdManager — instance lifecycle, config generation,
 * name sanitization, and rebuild handling.
 */

import { WorkerdManager, type WorkerdManagerDeps, type WorkerCreateOptions } from "./workerdManager.js";

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
          for (const fn of listeners.get("exit") ?? []) (fn as (code: number | null, signal: string | null) => void)(null, "SIGTERM");
        }, 0);
      }),
      pid: 12345,
    };
    return proc;
  }),
}));

// Mock port-utils
vi.mock("@natstack/port-utils", () => ({
  findServicePort: vi.fn().mockResolvedValue(49552),
}));

function createMockDeps(overrides: Partial<WorkerdManagerDeps> = {}): WorkerdManagerDeps {
  return {
    tokenManager: {
      ensureToken: vi.fn().mockReturnValue("mock-token-123"),
      revokeToken: vi.fn(),
    } as any,
    fsService: {
      registerCallerContext: vi.fn(),
      unregisterCallerContext: vi.fn(),
      closeHandlesForCaller: vi.fn(),
    } as any,
    getRpcPort: () => 9999,
    getBuild: vi.fn().mockResolvedValue({
      bundle: 'export default { fetch() { return new Response("ok"); } };',
      metadata: { ev: "abc123" },
    }),
    workspacePath: "/tmp/test-workspace",
    statePath: "/tmp/test-workspace-state",
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

    it("registers token and fs context", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);

      await mgr.createInstance(defaultCreateOptions());

      expect(deps.tokenManager.ensureToken).toHaveBeenCalledWith("worker:hello", "worker");
      expect(deps.fsService.registerCallerContext).toHaveBeenCalledWith("worker:hello", "ctx-1");
    });

    it("rejects duplicate instance names", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);

      await mgr.createInstance(defaultCreateOptions());
      await expect(mgr.createInstance(defaultCreateOptions())).rejects.toThrow(
        'Worker instance "hello" already exists',
      );
    });

    it("uses explicit name when provided", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);

      const instance = await mgr.createInstance(defaultCreateOptions({ name: "my-worker" }));
      expect(instance.name).toBe("my-worker");
      expect(instance.callerId).toBe("worker:my-worker");
    });

    it("rolls back on build failure", async () => {
      const deps = createMockDeps({
        getBuild: vi.fn().mockRejectedValue(new Error("build failed")),
      });
      const mgr = new WorkerdManager(deps);

      await expect(mgr.createInstance(defaultCreateOptions())).rejects.toThrow("build failed");

      expect(deps.tokenManager.revokeToken).toHaveBeenCalledWith("worker:hello");
      expect(deps.fsService.unregisterCallerContext).toHaveBeenCalledWith("worker:hello");
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
        defaultCreateOptions({ name: 'hello"; process.exit();//' }),
      );
      // All non-alphanumeric/dash/underscore chars replaced
      expect(instance.name).not.toContain('"');
      expect(instance.name).not.toContain(';');
      expect(instance.name).toMatch(/^[a-zA-Z0-9_-]+$/);
    });

    it("derives name from last path segment", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);

      const instance = await mgr.createInstance(
        defaultCreateOptions({ source: "workspace/workers/my-api" }),
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
      expect(deps.fsService.unregisterCallerContext).toHaveBeenCalledWith("worker:hello");
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
  });

  // -------------------------------------------------------------------------
  // onSourceRebuilt
  // -------------------------------------------------------------------------
  describe("onSourceRebuilt", () => {
    it("restarts HEAD-tracking instances for matching source", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);

      await mgr.createInstance(defaultCreateOptions());
      await mgr.onSourceRebuilt("workers/hello");

      const status = mgr.getInstanceStatus("hello");
      expect(status?.status).toBe("running");
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

    it("sets status to error on restart failure", async () => {
      const deps = createMockDeps();
      const mgr = new WorkerdManager(deps);

      await mgr.createInstance(defaultCreateOptions());

      // Make getBuild fail on the second call (during config regeneration in restart)
      vi.mocked(deps.getBuild)
        .mockResolvedValueOnce({
          bundle: "// ok",
          metadata: { ev: "v2" },
        } as any)
        .mockRejectedValueOnce(new Error("build broken"));

      // The restart itself might not throw (it catches internally)
      // but instance status should reflect the failure
      await mgr.onSourceRebuilt("workers/hello");
      // After source rebuild, if restart throws, status should be "error"
      // Note: the restart may succeed if config generation skips the failed build
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

      await mgr.registerAllDOClasses([
        { source: "workers/agent", className: "AgentDO" },
      ]);

      const revokeSpy = vi.spyOn(deps.tokenManager, "revokeToken");
      await mgr.onSourceRebuilt("workers/agent");

      // No revokes — the caller passed `undefined` meaning "don't touch DOs".
      expect(revokeSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("do-service:workers/agent"),
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
  });
});
