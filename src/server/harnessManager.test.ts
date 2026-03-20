import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HarnessManager, type HarnessManagerDeps, type SpawnOptions } from "./harnessManager.js";
import type { RpcBridge } from "@natstack/rpc";

// Mock node:child_process
vi.mock("node:child_process", () => {
  return {
    fork: vi.fn(),
  };
});

import { fork } from "node:child_process";
import type { ChildProcess } from "node:child_process";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createMockBridge(id = "mock-bridge"): RpcBridge {
  return {
    selfId: id,
    exposeMethod: vi.fn(),
    call: vi.fn(),
    emit: vi.fn(),
    onEvent: vi.fn(() => () => {}),
  };
}

interface MockChildProcess {
  pid: number;
  kill: ReturnType<typeof vi.fn>;
  stdout: { on: ReturnType<typeof vi.fn> };
  stderr: { on: ReturnType<typeof vi.fn> };
  on: ReturnType<typeof vi.fn>;
  /** Simulate child process emitting an event */
  _emit(event: string, ...args: unknown[]): void;
}

function createMockChildProcess(pid = 12345): MockChildProcess {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>();

  const child: MockChildProcess = {
    pid,
    kill: vi.fn(),
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      const existing = listeners.get(event) ?? [];
      existing.push(handler);
      listeners.set(event, existing);
    }),
    _emit(event: string, ...args: unknown[]) {
      const handlers = listeners.get(event) ?? [];
      for (const h of handlers) h(...args);
    },
  };

  return child;
}

function createDeps(overrides: Partial<HarnessManagerDeps> = {}): HarnessManagerDeps {
  return {
    getRpcWsUrl: () => "ws://127.0.0.1:9999",
    createToken: vi.fn(() => "test-token-abc"),
    revokeToken: vi.fn(),
    getClientBridge: vi.fn(() => undefined),
    onCrash: vi.fn(),
    log: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    },
    ...overrides,
  };
}

function defaultSpawnOptions(overrides: Partial<SpawnOptions> = {}): SpawnOptions {
  return {
    id: "harness-1",
    type: "claude-sdk",
    workerId: "MyWorker:key1",
    contextId: "ctx-123",
    entryPath: "/fake/harness/entry.js",
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("HarnessManager", () => {
  let mockChild: MockChildProcess;

  beforeEach(() => {
    mockChild = createMockChildProcess();
    vi.mocked(fork).mockReturnValue(mockChild as unknown as ChildProcess);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── spawn ──────────────────────────────────────────────────────────────────

  describe("spawn", () => {
    it("creates a process entry with status 'starting'", async () => {
      const deps = createDeps();
      const mgr = new HarnessManager(deps);

      await mgr.spawn(defaultSpawnOptions());

      const proc = mgr.getHarness("harness-1");
      expect(proc).toBeDefined();
      expect(proc!.id).toBe("harness-1");
      expect(proc!.type).toBe("claude-sdk");
      expect(proc!.workerId).toBe("MyWorker:key1");
      expect(proc!.status).toBe("starting");
      expect(proc!.pid).toBe(12345);
    });

    it("creates an auth token with callerKind 'harness'", async () => {
      const deps = createDeps();
      const mgr = new HarnessManager(deps);

      await mgr.spawn(defaultSpawnOptions());

      expect(deps.createToken).toHaveBeenCalledWith("harness-1", "harness");
    });

    it("forks a child process with correct env vars", async () => {
      const deps = createDeps();
      const mgr = new HarnessManager(deps);

      await mgr.spawn(defaultSpawnOptions({
        contextFolderPath: "/home/user/ctx",
        resumeSessionId: "session-xyz",
        extraEnv: { CUSTOM_VAR: "hello" },
      }));

      expect(fork).toHaveBeenCalledWith(
        "/fake/harness/entry.js",
        [],
        expect.objectContaining({
          stdio: "pipe",
          env: expect.objectContaining({
            RPC_WS_URL: "ws://127.0.0.1:9999",
            RPC_AUTH_TOKEN: "test-token-abc",
            HARNESS_ID: "harness-1",
            HARNESS_TYPE: "claude-sdk",
            CONTEXT_ID: "ctx-123",
            CONTEXT_FOLDER_PATH: "/home/user/ctx",
            RESUME_SESSION_ID: "session-xyz",
            CUSTOM_VAR: "hello",
          }),
        }),
      );
    });

    it("throws on duplicate spawn with same id", async () => {
      const deps = createDeps();
      const mgr = new HarnessManager(deps);

      await mgr.spawn(defaultSpawnOptions());
      await expect(mgr.spawn(defaultSpawnOptions())).rejects.toThrow(
        'Harness "harness-1" is already registered',
      );
    });

    it("sets up stdout and stderr listeners", async () => {
      const deps = createDeps();
      const mgr = new HarnessManager(deps);

      await mgr.spawn(defaultSpawnOptions());

      expect(mockChild.stdout.on).toHaveBeenCalledWith("data", expect.any(Function));
      expect(mockChild.stderr.on).toHaveBeenCalledWith("data", expect.any(Function));
    });
  });

  // ── stop ───────────────────────────────────────────────────────────────────

  describe("stop", () => {
    it("kills the child process and revokes the token", async () => {
      const deps = createDeps();
      const mgr = new HarnessManager(deps);

      await mgr.spawn(defaultSpawnOptions());
      await mgr.stop("harness-1");

      expect(mockChild.kill).toHaveBeenCalledWith("SIGTERM");
      expect(deps.revokeToken).toHaveBeenCalledWith("harness-1");
      expect(mgr.getHarness("harness-1")).toBeUndefined();
    });

    it("is a no-op for unknown harness id", async () => {
      const deps = createDeps();
      const mgr = new HarnessManager(deps);

      // Should not throw
      await mgr.stop("nonexistent");

      expect(deps.revokeToken).toHaveBeenCalledWith("nonexistent");
    });

    it("handles double-stop gracefully", async () => {
      const deps = createDeps();
      const mgr = new HarnessManager(deps);

      await mgr.spawn(defaultSpawnOptions());
      await mgr.stop("harness-1");
      await mgr.stop("harness-1");

      // Kill should only have been called once (second stop finds no child)
      expect(mockChild.kill).toHaveBeenCalledTimes(1);
    });
  });

  // ── stopAll ────────────────────────────────────────────────────────────────

  describe("stopAll", () => {
    it("stops all harnesses", async () => {
      const child2 = createMockChildProcess(22222);
      let callCount = 0;
      vi.mocked(fork).mockImplementation(() => {
        callCount++;
        return (callCount === 1 ? mockChild : child2) as unknown as ChildProcess;
      });

      const deps = createDeps();
      const mgr = new HarnessManager(deps);

      await mgr.spawn(defaultSpawnOptions({ id: "h1" }));
      await mgr.spawn(defaultSpawnOptions({ id: "h2" }));

      expect(mgr.listHarnesses()).toHaveLength(2);

      await mgr.stopAll();

      expect(mgr.listHarnesses()).toHaveLength(0);
      expect(mockChild.kill).toHaveBeenCalledWith("SIGTERM");
      expect(child2.kill).toHaveBeenCalledWith("SIGTERM");
    });
  });

  // ── notifyAuthenticated ────────────────────────────────────────────────────

  describe("notifyAuthenticated", () => {
    it("resolves a pending bridge waiter", async () => {
      const bridge = createMockBridge();
      const deps = createDeps({
        getClientBridge: vi.fn((id: string) => {
          // Return undefined first (before auth), then return bridge
          return id === "harness-1" ? bridge : undefined;
        }),
      });
      const mgr = new HarnessManager(deps);

      await mgr.spawn(defaultSpawnOptions());

      // Start waiting for bridge (will not resolve until notifyAuthenticated)
      const bridgePromise = mgr.waitForBridge("harness-1");

      // Simulate RPC server notifying authentication
      mgr.notifyAuthenticated("harness-1");

      const result = await bridgePromise;
      expect(result).toBe(bridge);

      // Status should be updated to running
      const proc = mgr.getHarness("harness-1");
      expect(proc!.status).toBe("running");
    });

    it("is a no-op if no waiter exists", () => {
      const deps = createDeps({
        getClientBridge: vi.fn(() => createMockBridge()),
      });
      const mgr = new HarnessManager(deps);

      // Should not throw
      mgr.notifyAuthenticated("nonexistent");
    });

    it("is a no-op if bridge not yet available", async () => {
      const deps = createDeps({
        getClientBridge: vi.fn(() => undefined),
      });
      const mgr = new HarnessManager(deps);

      await mgr.spawn(defaultSpawnOptions());
      const bridgePromise = mgr.waitForBridge("harness-1", 100);

      // Notify but bridge is not available yet
      mgr.notifyAuthenticated("harness-1");

      // Should timeout since bridge never became available
      await expect(bridgePromise).rejects.toThrow("did not authenticate");
    });
  });

  // ── waitForBridge ──────────────────────────────────────────────────────────

  describe("waitForBridge", () => {
    it("resolves immediately if bridge already exists", async () => {
      const bridge = createMockBridge();
      const deps = createDeps({
        getClientBridge: vi.fn(() => bridge),
      });
      const mgr = new HarnessManager(deps);

      await mgr.spawn(defaultSpawnOptions());

      const result = await mgr.waitForBridge("harness-1");
      expect(result).toBe(bridge);

      const proc = mgr.getHarness("harness-1");
      expect(proc!.status).toBe("running");
    });

    it("rejects on timeout", async () => {
      const deps = createDeps();
      const mgr = new HarnessManager(deps);

      await mgr.spawn(defaultSpawnOptions());

      await expect(mgr.waitForBridge("harness-1", 50)).rejects.toThrow(
        'Harness "harness-1" did not authenticate within 50ms',
      );
    });
  });

  // ── process exit / crash ───────────────────────────────────────────────────

  describe("process exit", () => {
    it("triggers onCrash for a running harness that exits unexpectedly", async () => {
      const bridge = createMockBridge();
      let bridgeAvailable = false;
      const deps = createDeps({
        getClientBridge: vi.fn(() => (bridgeAvailable ? bridge : undefined)),
      });
      const mgr = new HarnessManager(deps);

      await mgr.spawn(defaultSpawnOptions());

      // Simulate authentication
      bridgeAvailable = true;
      const bridgePromise = mgr.waitForBridge("harness-1");
      mgr.notifyAuthenticated("harness-1");
      await bridgePromise;

      // Simulate crash
      mockChild._emit("exit", 1, null);

      expect(deps.onCrash).toHaveBeenCalledWith("harness-1");
      expect(deps.revokeToken).toHaveBeenCalledWith("harness-1");
      expect(mgr.getHarness("harness-1")).toBeUndefined();
    });

    it("triggers onCrash for a harness that exits while starting", async () => {
      const deps = createDeps();
      const mgr = new HarnessManager(deps);

      await mgr.spawn(defaultSpawnOptions());

      // Crash while still in "starting" status
      mockChild._emit("exit", 1, "SIGSEGV");

      expect(deps.onCrash).toHaveBeenCalledWith("harness-1");
      expect(deps.log!.error).toHaveBeenCalled();
    });

    it("does not trigger onCrash for a gracefully stopped harness", async () => {
      const deps = createDeps();
      const mgr = new HarnessManager(deps);

      await mgr.spawn(defaultSpawnOptions());

      // Stop gracefully first, then the exit event fires
      await mgr.stop("harness-1");
      mockChild._emit("exit", 0, null);

      expect(deps.onCrash).not.toHaveBeenCalled();
    });

    it("rejects pending bridge waiter when process exits", async () => {
      const deps = createDeps();
      const mgr = new HarnessManager(deps);

      await mgr.spawn(defaultSpawnOptions());
      const bridgePromise = mgr.waitForBridge("harness-1", 5000);

      // Process exits before authenticating
      mockChild._emit("exit", 1, null);

      await expect(bridgePromise).rejects.toThrow("stopped before authenticating");
    });
  });

  // ── notifyDisconnected ─────────────────────────────────────────────────────

  describe("notifyDisconnected", () => {
    it("treats disconnect of a running harness as a crash", async () => {
      const bridge = createMockBridge();
      let bridgeAvailable = false;
      const deps = createDeps({
        getClientBridge: vi.fn(() => (bridgeAvailable ? bridge : undefined)),
      });
      const mgr = new HarnessManager(deps);

      await mgr.spawn(defaultSpawnOptions());

      // Authenticate
      bridgeAvailable = true;
      mgr.notifyAuthenticated("harness-1");
      await mgr.waitForBridge("harness-1");

      // Disconnect
      mgr.notifyDisconnected("harness-1");

      expect(deps.onCrash).toHaveBeenCalledWith("harness-1");
      expect(mockChild.kill).toHaveBeenCalledWith("SIGTERM");
      expect(deps.revokeToken).toHaveBeenCalledWith("harness-1");
      expect(mgr.getHarness("harness-1")).toBeUndefined();
    });

    it("does not crash-report a harness in starting status", async () => {
      const deps = createDeps();
      const mgr = new HarnessManager(deps);

      await mgr.spawn(defaultSpawnOptions());

      mgr.notifyDisconnected("harness-1");

      // Not running yet, so no crash report
      expect(deps.onCrash).not.toHaveBeenCalled();
      // But it should still kill the process
      expect(mockChild.kill).toHaveBeenCalledWith("SIGTERM");
    });

    it("is a no-op for unknown harness id", () => {
      const deps = createDeps();
      const mgr = new HarnessManager(deps);

      // Should not throw
      mgr.notifyDisconnected("nonexistent");
      expect(deps.onCrash).not.toHaveBeenCalled();
    });
  });

  // ── listHarnesses / getHarness ─────────────────────────────────────────────

  describe("listing", () => {
    it("lists all registered harnesses", async () => {
      const child2 = createMockChildProcess(22222);
      let callCount = 0;
      vi.mocked(fork).mockImplementation(() => {
        callCount++;
        return (callCount === 1 ? mockChild : child2) as unknown as ChildProcess;
      });

      const deps = createDeps();
      const mgr = new HarnessManager(deps);

      await mgr.spawn(defaultSpawnOptions({ id: "h1" }));
      await mgr.spawn(defaultSpawnOptions({ id: "h2", type: "pi" }));

      const list = mgr.listHarnesses();
      expect(list).toHaveLength(2);
      expect(list.map((h) => h.id).sort()).toEqual(["h1", "h2"]);
    });

    it("returns undefined for unknown harness", () => {
      const mgr = new HarnessManager(createDeps());
      expect(mgr.getHarness("nope")).toBeUndefined();
    });
  });

  // ── getHarnessBridge ───────────────────────────────────────────────────────

  describe("getHarnessBridge", () => {
    it("delegates to getClientBridge", async () => {
      const bridge = createMockBridge();
      const deps = createDeps({
        getClientBridge: vi.fn((id: string) => (id === "harness-1" ? bridge : undefined)),
      });
      const mgr = new HarnessManager(deps);

      await mgr.spawn(defaultSpawnOptions());

      expect(mgr.getHarnessBridge("harness-1")).toBe(bridge);
      expect(mgr.getHarnessBridge("unknown")).toBeUndefined();
    });
  });

  // ── edge cases ─────────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("stopping a harness that is still starting rejects the bridge waiter", async () => {
      const deps = createDeps();
      const mgr = new HarnessManager(deps);

      await mgr.spawn(defaultSpawnOptions());
      const bridgePromise = mgr.waitForBridge("harness-1", 5000);

      await mgr.stop("harness-1");

      await expect(bridgePromise).rejects.toThrow("stopped before authenticating");
    });

    it("handles child process with no pid", async () => {
      const noPidChild = createMockChildProcess(0);
      // Simulate no pid (e.g. process failed to start)
      (noPidChild as any).pid = undefined;
      vi.mocked(fork).mockReturnValue(noPidChild as unknown as ChildProcess);

      const deps = createDeps();
      const mgr = new HarnessManager(deps);

      await mgr.spawn(defaultSpawnOptions());

      const proc = mgr.getHarness("harness-1");
      expect(proc!.pid).toBeUndefined();
    });
  });
});
