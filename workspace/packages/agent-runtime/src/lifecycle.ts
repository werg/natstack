/**
 * Lifecycle Management
 *
 * Handles ELU (Event Loop Utilization) tracking for idle detection
 * and graceful shutdown coordination.
 */

import { performance } from "node:perf_hooks";

/**
 * Lifecycle manager interface.
 */
export interface LifecycleManager {
  /** Start monitoring for idle state */
  startIdleMonitoring(): void;
  /** Stop monitoring for idle state */
  stopIdleMonitoring(): void;
  /** Mark the agent as active (resets idle timer) */
  markActive(): void;
  /** Check if the agent is currently idle */
  isIdle(): boolean;
  /** Register a handler to run before process exit */
  onBeforeExit(handler: () => Promise<void>): void;
}

/**
 * Options for creating a lifecycle manager.
 */
export interface LifecycleManagerOptions {
  /** Callback invoked when agent becomes idle */
  onIdle: () => void;
  /** ELU threshold below which agent is considered idle (default: 0.01 = 1%) */
  eluThreshold?: number;
  /** Debounce time for idle detection in milliseconds (default: 1000ms) */
  idleDebounceMs?: number;
  /** Polling interval for ELU checks in milliseconds (default: 500ms) */
  pollIntervalMs?: number;
}

/**
 * Create a lifecycle manager for an agent.
 *
 * The lifecycle manager:
 * 1. Monitors Event Loop Utilization (ELU) to detect idle state
 * 2. Calls onIdle when ELU stays below threshold for debounce period
 * 3. Coordinates beforeExit handlers for graceful shutdown
 *
 * @example
 * ```typescript
 * const lifecycle = createLifecycleManager({
 *   onIdle: () => {
 *     // Agent is idle, allow process to exit
 *     parentPort.unref?.();
 *   },
 *   eluThreshold: 0.01, // 1% CPU
 *   idleDebounceMs: 1000, // 1 second debounce
 * });
 *
 * lifecycle.startIdleMonitoring();
 *
 * // On each message:
 * lifecycle.markActive();
 * ```
 */
export function createLifecycleManager(options: LifecycleManagerOptions): LifecycleManager {
  const {
    onIdle,
    eluThreshold = 0.01,
    idleDebounceMs = 1000,
    pollIntervalMs = 500,
  } = options;

  let pollInterval: ReturnType<typeof setInterval> | null = null;
  let idleStartTime: number | null = null;
  let currentlyIdle = false;
  let lastElu = performance.eventLoopUtilization();
  const beforeExitHandlers: Array<() => Promise<void>> = [];

  /**
   * Check ELU and determine if agent should be considered idle.
   */
  const checkElu = () => {
    const currentElu = performance.eventLoopUtilization(lastElu);
    lastElu = performance.eventLoopUtilization();

    const isLowActivity = currentElu.utilization < eluThreshold;

    if (isLowActivity) {
      if (idleStartTime === null) {
        idleStartTime = Date.now();
      } else if (Date.now() - idleStartTime >= idleDebounceMs) {
        if (!currentlyIdle) {
          currentlyIdle = true;
          onIdle();
        }
      }
    } else {
      idleStartTime = null;
      currentlyIdle = false;
    }
  };

  /**
   * Handle beforeExit event - run all registered handlers.
   */
  const handleBeforeExit = async () => {
    for (const handler of beforeExitHandlers) {
      try {
        await handler();
      } catch (err) {
        console.error("[LifecycleManager] beforeExit handler error:", err);
      }
    }
  };

  // Register beforeExit handler once
  let beforeExitRegistered = false;
  const ensureBeforeExitHandler = () => {
    if (beforeExitRegistered) return;
    beforeExitRegistered = true;
    process.on("beforeExit", () => {
      void handleBeforeExit();
    });
  };

  return {
    startIdleMonitoring() {
      if (pollInterval) return;

      // Reset ELU baseline
      lastElu = performance.eventLoopUtilization();
      idleStartTime = null;
      currentlyIdle = false;

      pollInterval = setInterval(checkElu, pollIntervalMs);
      // Don't let the interval keep the process alive
      pollInterval.unref();
    },

    stopIdleMonitoring() {
      if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
      }
      idleStartTime = null;
      currentlyIdle = false;
    },

    markActive() {
      idleStartTime = null;
      currentlyIdle = false;
      // Reset ELU baseline so next check starts fresh
      lastElu = performance.eventLoopUtilization();
    },

    isIdle() {
      return currentlyIdle;
    },

    onBeforeExit(handler: () => Promise<void>) {
      ensureBeforeExitHandler();
      beforeExitHandlers.push(handler);
    },
  };
}
