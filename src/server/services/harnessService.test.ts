import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHarnessService } from "./harnessService.js";
import type { ServiceDefinition } from "../../shared/serviceDefinition.js";
import type { DODispatch, DORef } from "../doDispatch.js";
import type { HarnessManager } from "../harnessManager.js";
import type { ContextFolderManager } from "../../shared/contextFolderManager.js";
import type { ServiceContext } from "../../shared/serviceDispatcher.js";

// ── Mocks ─────────────────────────────────────────────────────────────────────

function createMockDeps() {
  const dispatched: Array<{ ref: DORef; method: string; args: unknown[] }> = [];
  const doDispatch = {
    dispatch: vi.fn(async (ref: DORef, method: string, ...args: unknown[]) => {
      dispatched.push({ ref, method, args });
    }),
  } as unknown as DODispatch;

  const mockBridge = {
    call: vi.fn(async () => ({})),
  };

  const harnesses = new Map<string, { status: string; type: string }>();

  const harnessManager = {
    getDOForHarness: vi.fn((id: string): DORef | undefined => {
      if (id === "known-harness") {
        return { source: "workers/agent", className: "Agent", objectKey: "a1" };
      }
      return undefined;
    }),
    spawn: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    waitForBridge: vi.fn(async () => mockBridge),
    getHarnessBridge: vi.fn(() => mockBridge),
    getHarness: vi.fn((id: string) => harnesses.get(id)),
  } as unknown as HarnessManager;

  const contextFolderManager = {
    ensureContextFolder: vi.fn(async (id: string) => `/tmp/ctx/${id}`),
  } as unknown as ContextFolderManager;

  return { doDispatch, harnessManager, contextFolderManager, dispatched, mockBridge, harnesses };
}

const workerCtx: ServiceContext = { callerId: "do:test:Worker:obj1", callerKind: "worker" };

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("harnessService", () => {
  let svc: ServiceDefinition;
  let deps: ReturnType<typeof createMockDeps>;

  beforeEach(() => {
    deps = createMockDeps();
    svc = createHarnessService(deps);
  });

  function call(method: string, ...args: unknown[]) {
    return svc.handler!(workerCtx, method, args);
  }

  // ── pushEvent ───────────────────────────────────────────────────────────────

  describe("pushEvent", () => {
    it("dispatches event to owning DO", async () => {
      const event = { type: "message", data: "hello" };
      const result = await call("pushEvent", "known-harness", event);

      expect(result).toEqual({ ok: true });
      expect(deps.doDispatch.dispatch).toHaveBeenCalledWith(
        { source: "workers/agent", className: "Agent", objectKey: "a1" },
        "onHarnessEvent",
        "known-harness",
        event,
      );
    });

    it("returns error for unknown harness", async () => {
      const result = await call("pushEvent", "unknown-harness", { type: "x" });
      expect(result).toEqual({
        ok: false,
        error: expect.stringContaining("No DO registration"),
      });
    });

    it("serializes concurrent pushes for same harness", async () => {
      const order: number[] = [];
      let callCount = 0;
      (deps.doDispatch.dispatch as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        const n = ++callCount;
        await new Promise(r => setTimeout(r, n === 1 ? 20 : 5));
        order.push(n);
      });

      await Promise.all([
        call("pushEvent", "known-harness", { type: "a" }),
        call("pushEvent", "known-harness", { type: "b" }),
      ]);

      expect(order).toEqual([1, 2]); // First call finishes before second starts
    });
  });

  // ── spawn ───────────────────────────────────────────────────────────────────

  describe("spawn", () => {
    const spawnOpts = {
      doRef: { source: "workers/agent", className: "Agent", objectKey: "a1" },
      harnessId: "h-123",
      type: "claude",
      contextId: "ctx-1",
    };

    it("spawns harness and dispatches ready event", async () => {
      const result = await call("spawn", spawnOpts);

      expect(result).toEqual({ ok: true, harnessId: "h-123" });
      expect(deps.contextFolderManager.ensureContextFolder).toHaveBeenCalledWith("ctx-1");
      expect(deps.harnessManager.spawn).toHaveBeenCalledWith(
        expect.objectContaining({ id: "h-123", type: "claude", contextId: "ctx-1" }),
      );
      expect(deps.doDispatch.dispatch).toHaveBeenCalledWith(
        spawnOpts.doRef, "onHarnessEvent", "h-123", { type: "ready" },
      );
    });

    it("generates harness ID when not provided", async () => {
      const result = await call("spawn", { ...spawnOpts, harnessId: undefined }) as { ok: boolean; harnessId: string };

      expect(result.ok).toBe(true);
      expect(result.harnessId).toMatch(/^harness-/);
    });

    it("fires initial start-turn when provided", async () => {
      const input = { content: "hello", senderId: "user-1" };
      await call("spawn", { ...spawnOpts, initialInput: input });

      // start-turn is fire-and-forget, but bridge.call should have been invoked
      expect(deps.mockBridge.call).toHaveBeenCalledWith("h-123", "startTurn", input);
    });

    it("throws on missing required fields", async () => {
      await expect(call("spawn", { doRef: null, type: "", contextId: "" })).rejects.toThrow("Missing required");
    });

    it("stops harness on spawn failure", async () => {
      (deps.harnessManager.spawn as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("spawn failed"));

      await expect(call("spawn", spawnOpts)).rejects.toThrow("spawn failed");
      expect(deps.harnessManager.stop).toHaveBeenCalledWith("h-123");
    });
  });

  // ── sendCommand ─────────────────────────────────────────────────────────────

  describe("sendCommand", () => {
    it("maps command to RPC call", async () => {
      const result = await call("sendCommand", "h-1", { type: "interrupt" });

      expect(result).toEqual({ ok: true });
      expect(deps.mockBridge.call).toHaveBeenCalledWith("h-1", "interrupt");
    });

    it("maps start-turn command (fire-and-forget)", async () => {
      const result = await call("sendCommand", "h-1", {
        type: "start-turn",
        input: { content: "hi", senderId: "u1" },
      });

      expect(result).toEqual({ ok: true });
      expect(deps.mockBridge.call).toHaveBeenCalledWith(
        "h-1", "startTurn", { content: "hi", senderId: "u1" },
      );
    });

    it("maps approve-tool command", async () => {
      await call("sendCommand", "h-1", {
        type: "approve-tool",
        toolUseId: "t1",
        allow: true,
        alwaysAllow: false,
        updatedInput: null,
      });

      expect(deps.mockBridge.call).toHaveBeenCalledWith("h-1", "approveTool", "t1", true, false, null);
    });

    it("throws on missing command", async () => {
      await expect(call("sendCommand", "h-1", null)).rejects.toThrow("Missing command");
    });

    it("throws when bridge not found", async () => {
      (deps.harnessManager.getHarnessBridge as ReturnType<typeof vi.fn>).mockReturnValue(null);
      await expect(call("sendCommand", "h-1", { type: "interrupt" })).rejects.toThrow("No bridge");
    });
  });

  // ── stop ────────────────────────────────────────────────────────────────────

  describe("stop", () => {
    it("stops harness", async () => {
      const result = await call("stop", "h-1");
      expect(result).toEqual({ ok: true });
      expect(deps.harnessManager.stop).toHaveBeenCalledWith("h-1");
    });
  });

  // ── getStatus ───────────────────────────────────────────────────────────────

  describe("getStatus", () => {
    it("returns harness status", async () => {
      deps.harnesses.set("h-1", { status: "running", type: "claude" });
      const result = await call("getStatus", "h-1");
      expect(result).toEqual({ status: "running", type: "claude" });
    });

    it("throws for unknown harness", async () => {
      await expect(call("getStatus", "h-missing")).rejects.toThrow("Harness not found");
    });
  });

  // ── unknown method ──────────────────────────────────────────────────────────

  it("throws on unknown method", async () => {
    await expect(call("nonexistent")).rejects.toThrow("Unknown harness method");
  });
});
