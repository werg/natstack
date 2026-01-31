/**
 * Lifecycle management unit tests.
 *
 * These tests verify LifecycleManager behavior.
 */

import { createLifecycleManager, type LifecycleManager } from "../lifecycle.js";

// Test: markActive resets idle state
export function testMarkActiveResetsIdle(): void {
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

  if (lifecycle.isIdle()) {
    throw new Error("Expected isIdle=false after markActive");
  }

  lifecycle.stopIdleMonitoring();
}

// Test: stopIdleMonitoring clears state
export function testStopIdleMonitoringClearsState(): void {
  const lifecycle = createLifecycleManager({
    onIdle: () => {},
    eluThreshold: 0.01,
    idleDebounceMs: 100,
  });

  lifecycle.startIdleMonitoring();
  lifecycle.stopIdleMonitoring();

  if (lifecycle.isIdle()) {
    throw new Error("Expected isIdle=false after stop");
  }
}

// Test: onBeforeExit registers handler
export function testOnBeforeExitRegistersHandler(): void {
  const handlers: Array<() => Promise<void>> = [];

  const lifecycle = createLifecycleManager({
    onIdle: () => {},
  });

  const handler = async () => {
    handlers.push(handler);
  };

  // Just verify it doesn't throw
  lifecycle.onBeforeExit(handler);
}

// Test: isIdle returns false initially
export function testIsIdleReturnsFalseInitially(): void {
  const lifecycle = createLifecycleManager({
    onIdle: () => {},
  });

  if (lifecycle.isIdle()) {
    throw new Error("Expected isIdle=false initially");
  }
}

// Run all tests
export function runTests(): void {
  const tests = [
    { name: "markActive resets idle", fn: testMarkActiveResetsIdle },
    { name: "stopIdleMonitoring clears state", fn: testStopIdleMonitoringClearsState },
    { name: "onBeforeExit registers handler", fn: testOnBeforeExitRegistersHandler },
    { name: "isIdle returns false initially", fn: testIsIdleReturnsFalseInitially },
  ];

  for (const test of tests) {
    try {
      test.fn();
      console.log(`✓ ${test.name}`);
    } catch (err) {
      console.error(`✗ ${test.name}:`, err);
    }
  }
}
