import { describe, it, expect, vi, beforeEach } from "vitest";
import { WorkerRouter } from "./workerRouter";
import type { DODispatcher } from "./workerRouter";
import type { WorkerActions } from "@natstack/harness";

describe("WorkerRouter", () => {
  let router: WorkerRouter;

  beforeEach(() => {
    router = new WorkerRouter();
  });

  // ── registerParticipant / getDOForParticipant ──────────────────────────

  describe("registerParticipant / getDOForParticipant", () => {
    it("registers and retrieves a participant's DO", () => {
      router.registerParticipant("p1", "ChatDO", "room-42");

      const reg = router.getDOForParticipant("p1");
      expect(reg).toEqual({ className: "ChatDO", objectKey: "room-42" });
    });

    it("returns undefined for an unknown participant", () => {
      expect(router.getDOForParticipant("nonexistent")).toBeUndefined();
    });

    it("overwrites an existing registration for the same participant", () => {
      router.registerParticipant("p1", "ChatDO", "room-1");
      router.registerParticipant("p1", "StateDO", "room-2");

      const reg = router.getDOForParticipant("p1");
      expect(reg).toEqual({ className: "StateDO", objectKey: "room-2" });
    });
  });

  // ── getParticipantsForDO ───────────────────────────────────────────────

  describe("getParticipantsForDO", () => {
    it("returns all participants registered for a given DO", () => {
      router.registerParticipant("p1", "ChatDO", "room-1");
      router.registerParticipant("p2", "ChatDO", "room-1");
      router.registerParticipant("p3", "ChatDO", "room-2");

      const pids = router.getParticipantsForDO("ChatDO", "room-1");
      expect(pids).toEqual(["p1", "p2"]);
    });

    it("returns empty array when no participants match", () => {
      expect(router.getParticipantsForDO("NoDO", "none")).toEqual([]);
    });
  });

  // ── registerHarness / getDOForHarness ──────────────────────────────────

  describe("registerHarness / getDOForHarness", () => {
    it("registers and retrieves a harness's DO", () => {
      router.registerHarness("h1", "WorkerDO", "key-a");

      const reg = router.getDOForHarness("h1");
      expect(reg).toEqual({ className: "WorkerDO", objectKey: "key-a" });
    });

    it("returns undefined for an unknown harness", () => {
      expect(router.getDOForHarness("unknown")).toBeUndefined();
    });
  });

  // ── unregisterHarness ──────────────────────────────────────────────────

  describe("unregisterHarness", () => {
    it("removes a previously registered harness", () => {
      router.registerHarness("h1", "WorkerDO", "key-a");
      expect(router.getDOForHarness("h1")).toBeDefined();

      router.unregisterHarness("h1");
      expect(router.getDOForHarness("h1")).toBeUndefined();
    });

    it("does not throw when unregistering a non-existent harness", () => {
      expect(() => router.unregisterHarness("nope")).not.toThrow();
    });
  });

  // ── getHarnessesForDO ──────────────────────────────────────────────────

  describe("getHarnessesForDO", () => {
    it("returns all harnesses registered for a given DO", () => {
      router.registerHarness("h1", "WorkerDO", "key-a");
      router.registerHarness("h2", "WorkerDO", "key-a");
      router.registerHarness("h3", "WorkerDO", "key-b");

      const hids = router.getHarnessesForDO("WorkerDO", "key-a");
      expect(hids).toEqual(["h1", "h2"]);
    });

    it("returns empty array when no harnesses match", () => {
      expect(router.getHarnessesForDO("NoDO", "none")).toEqual([]);
    });
  });

  // ── dispatch ───────────────────────────────────────────────────────────

  describe("dispatch", () => {
    it("throws when no dispatcher is configured", async () => {
      await expect(
        router.dispatch("ChatDO", "room-1", "onMessage", "hello"),
      ).rejects.toThrow("WorkerRouter: no dispatcher configured");
    });

    it("calls the injected dispatcher with correct arguments", async () => {
      const actions: WorkerActions = { actions: [] };
      const mockDispatcher: DODispatcher = vi.fn().mockResolvedValue(actions);

      router.setDispatcher(mockDispatcher);

      const result = await router.dispatch(
        "ChatDO",
        "room-1",
        "onMessage",
        "arg1",
        "arg2",
      );

      expect(mockDispatcher).toHaveBeenCalledWith(
        "ChatDO",
        "room-1",
        "onMessage",
        "arg1",
        "arg2",
      );
      expect(result).toBe(actions);
    });

    it("propagates errors from the dispatcher", async () => {
      const mockDispatcher: DODispatcher = vi
        .fn()
        .mockRejectedValue(new Error("bridge down"));

      router.setDispatcher(mockDispatcher);

      await expect(
        router.dispatch("ChatDO", "room-1", "onMessage"),
      ).rejects.toThrow("bridge down");
    });
  });
});
