import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createInterruptController } from "../interrupt/interrupt-controller.js";

describe("createInterruptController", () => {
  it("should start unpaused", () => {
    const controller = createInterruptController();
    expect(controller.isPaused()).toBe(false);
  });

  it("should toggle pause state", () => {
    const controller = createInterruptController();

    controller.pause();
    expect(controller.isPaused()).toBe(true);

    controller.resume();
    expect(controller.isPaused()).toBe(false);
  });

  it("should not double-pause", () => {
    const onPause = vi.fn();
    const controller = createInterruptController();
    controller.onPause(onPause);

    controller.pause();
    controller.pause();

    expect(onPause).toHaveBeenCalledTimes(1);
  });

  it("should not double-resume", () => {
    const onResume = vi.fn();
    const controller = createInterruptController();
    controller.onResume(onResume);

    controller.pause();
    controller.resume();
    controller.resume();

    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it("should call pause/resume handlers", () => {
    const onPause = vi.fn();
    const onResume = vi.fn();
    const controller = createInterruptController();

    controller.onPause(onPause);
    controller.onResume(onResume);

    controller.pause();
    expect(onPause).toHaveBeenCalled();
    expect(onResume).not.toHaveBeenCalled();

    controller.resume();
    expect(onResume).toHaveBeenCalled();
  });

  it("should unsubscribe handlers", () => {
    const onPause = vi.fn();
    const controller = createInterruptController();

    const unsubscribe = controller.onPause(onPause);
    unsubscribe();

    controller.pause();
    expect(onPause).not.toHaveBeenCalled();
  });

  it("should create abort signals", () => {
    const controller = createInterruptController();

    const signal1 = controller.createAbortSignal();
    expect(signal1).toBeInstanceOf(AbortSignal);
    expect(signal1.aborted).toBe(false);
  });

  it("should abort current signal", () => {
    const controller = createInterruptController();

    const signal = controller.createAbortSignal();
    expect(signal.aborted).toBe(false);
    expect(controller.isAborted()).toBe(false);

    controller.abortCurrent();
    expect(signal.aborted).toBe(true);
    expect(controller.isAborted()).toBe(true);
  });

  it("should create fresh signal after abort", () => {
    const controller = createInterruptController();

    const signal1 = controller.createAbortSignal();
    controller.abortCurrent();
    expect(signal1.aborted).toBe(true);

    const signal2 = controller.createAbortSignal();
    expect(signal2.aborted).toBe(false);
    expect(signal1).not.toBe(signal2);
  });

  it("should cleanup properly", () => {
    const onPause = vi.fn();
    const controller = createInterruptController();
    controller.onPause(onPause);

    // Pause and create signal
    controller.pause();
    const signal = controller.createAbortSignal();

    // Cleanup
    controller.cleanup();

    // Signal should be aborted
    expect(signal.aborted).toBe(true);

    // Pause state should be reset
    expect(controller.isPaused()).toBe(false);

    // Handlers should be cleared (pause shouldn't call handler)
    controller.pause();
    expect(onPause).toHaveBeenCalledTimes(1); // Only the first pause
  });

  it("should handle errors in handlers gracefully", () => {
    const controller = createInterruptController();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    controller.onPause(() => {
      throw new Error("Handler error");
    });

    // Should not throw
    expect(() => controller.pause()).not.toThrow();
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });
});
