/**
 * Lifecycle management unit tests.
 *
 * These tests verify LifecycleManager behavior.
 */

import { describe, it, expect } from "vitest";
import { createLifecycleManager } from "../lifecycle.js";

describe("createLifecycleManager", () => {
  it("should reset idle state on markActive", () => {
    let idleCalled = false;

    const lifecycle = createLifecycleManager({
      onIdle: () => {
        idleCalled = true;
      },
      eluThreshold: 0.01,
      idleDebounceMs: 100,
    });

    lifecycle.startIdleMonitoring();

    // Mark active should reset idle state
    lifecycle.markActive();

    expect(lifecycle.isIdle()).toBe(false);

    lifecycle.stopIdleMonitoring();
  });

  it("should clear state on stopIdleMonitoring", () => {
    const lifecycle = createLifecycleManager({
      onIdle: () => {},
      eluThreshold: 0.01,
      idleDebounceMs: 100,
    });

    lifecycle.startIdleMonitoring();
    lifecycle.stopIdleMonitoring();

    expect(lifecycle.isIdle()).toBe(false);
  });

  it("should register beforeExit handler without throwing", () => {
    const lifecycle = createLifecycleManager({
      onIdle: () => {},
    });

    const handler = async () => {
      // No-op handler
    };

    // Should not throw
    expect(() => lifecycle.onBeforeExit(handler)).not.toThrow();
  });

  it("should return false for isIdle initially", () => {
    const lifecycle = createLifecycleManager({
      onIdle: () => {},
    });

    expect(lifecycle.isIdle()).toBe(false);
  });

  it("should start and stop monitoring without errors", () => {
    const lifecycle = createLifecycleManager({
      onIdle: () => {},
    });

    expect(() => lifecycle.startIdleMonitoring()).not.toThrow();
    expect(() => lifecycle.stopIdleMonitoring()).not.toThrow();
  });
});
