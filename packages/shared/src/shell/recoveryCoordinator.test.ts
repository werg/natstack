import { describe, expect, it, vi } from "vitest";
import { createRecoveryCoordinator } from "./recoveryCoordinator.js";

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
}

describe("RecoveryCoordinator", () => {
  it("runs newly registered resubscribe handlers after resubscribe completed for the current generation", async () => {
    const coordinator = createRecoveryCoordinator();
    await coordinator.run("resubscribe");

    const handler = vi.fn();
    coordinator.registerResubscribeHandler("late-resubscribe", handler);
    await flushMicrotasks();

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("does not run newly registered cold-recover handlers after cold recovery completed", async () => {
    const coordinator = createRecoveryCoordinator();
    await coordinator.run("resubscribe");
    await coordinator.run("cold-recover");

    const handler = vi.fn();
    coordinator.registerColdRecoverHandler("late-cold-recover", handler);
    await flushMicrotasks();

    expect(handler).not.toHaveBeenCalled();
  });

  it("does not include cold-recover handlers registered during an active cold recovery", async () => {
    const coordinator = createRecoveryCoordinator();
    const lateHandler = vi.fn();

    coordinator.registerColdRecoverHandler("registers-late", () => {
      coordinator.registerColdRecoverHandler("late-cold-recover", lateHandler);
    });

    await coordinator.run("cold-recover");

    expect(lateHandler).not.toHaveBeenCalled();
  });
});
