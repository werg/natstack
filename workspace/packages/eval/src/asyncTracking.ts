/**
 * Unified async tracking API for both panels and workers.
 *
 * When running in a NatStack panel or worker, this uses the built-in
 * __natstackAsyncTracking__ global which wraps Promise and other async APIs.
 *
 * When running in other environments (tests, Node.js CLI), it provides
 * a fallback implementation that doesn't actually track async operations
 * but maintains the same API contract.
 */

/**
 * Async tracking context returned by start().
 */
export interface TrackingContext {
  id: number;
  promises: Set<Promise<unknown>>;
  pauseCount: number;
}

/**
 * Options for creating a tracking context.
 */
export interface TrackingContextOptions {
  /** Auto-cleanup after this many milliseconds (0 = disabled) */
  maxTimeout?: number;
}

/**
 * The async tracking API interface.
 * This is implemented by the runtime banner and accessed via globalThis.__natstackAsyncTracking__.
 */
export interface AsyncTrackingAPI {
  /** Create a new tracking context and set it as current */
  start: (options?: TrackingContextOptions) => TrackingContext;
  /** Enter an existing tracking context (set as current) */
  enter: (ctx: TrackingContext) => void;
  /** Exit the current tracking context */
  exit: () => void;
  /** Stop and destroy a context, cleaning up all references */
  stop: (ctx?: TrackingContext) => void;
  /** Pause tracking in a context (nested pause supported) */
  pause: (ctx?: TrackingContext) => void;
  /** Resume tracking in a context */
  resume: (ctx?: TrackingContext) => void;
  /** Mark a promise as ignored (never tracked in any context) */
  ignore: <T>(promise: T) => T;
  /** Wait for all promises in a context to settle */
  waitAll: (timeoutMs: number, ctx?: TrackingContext) => Promise<void>;
  /** Get pending promise count for a context */
  pending: (ctx?: TrackingContext) => number;
  /** Get all active context IDs (for debugging) */
  activeContexts: () => number[];
}

/**
 * Get the async tracking API from the global scope.
 * Returns undefined if not available (not running in NatStack panel/worker).
 */
export function getAsyncTracking(): AsyncTrackingAPI | undefined {
  return (globalThis as Record<string, unknown>)["__natstackAsyncTracking__"] as
    | AsyncTrackingAPI
    | undefined;
}

/**
 * Check if async tracking is available in the current environment.
 */
export function hasAsyncTracking(): boolean {
  return getAsyncTracking() !== undefined;
}

// Fallback context ID counter for environments without native tracking
let fallbackContextId = 0;

/**
 * Create a fallback tracking context for environments without native async tracking.
 * This doesn't actually track promises but provides API compatibility.
 */
function createFallbackContext(options?: TrackingContextOptions): TrackingContext {
  const ctx: TrackingContext = {
    id: ++fallbackContextId,
    promises: new Set(),
    pauseCount: 0,
  };

  // Set up auto-cleanup timeout if configured
  if (options?.maxTimeout && options.maxTimeout > 0) {
    setTimeout(() => {
      ctx.promises.clear();
    }, options.maxTimeout);
  }

  return ctx;
}

/**
 * Create a fallback async tracking API for testing or non-NatStack environments.
 * This implementation maintains the same API but doesn't actually track async operations.
 * Promises must be awaited manually.
 */
export function createFallbackAsyncTracking(): AsyncTrackingAPI {
  let currentContext: TrackingContext | null = null;

  return {
    start(options?: TrackingContextOptions): TrackingContext {
      currentContext = createFallbackContext(options);
      return currentContext;
    },
    enter(ctx: TrackingContext): void {
      currentContext = ctx;
    },
    exit(): void {
      currentContext = null;
    },
    stop(ctx?: TrackingContext): void {
      const target = ctx ?? currentContext;
      if (target) {
        target.promises.clear();
      }
      if (ctx === currentContext || (!ctx && currentContext)) {
        currentContext = null;
      }
    },
    pause(ctx?: TrackingContext): void {
      const target = ctx ?? currentContext;
      if (target) {
        target.pauseCount++;
      }
    },
    resume(ctx?: TrackingContext): void {
      const target = ctx ?? currentContext;
      if (target) {
        target.pauseCount = Math.max(0, target.pauseCount - 1);
      }
    },
    ignore<T>(promise: T): T {
      // No-op in fallback - just return the promise
      return promise;
    },
    waitAll(_timeoutMs: number, ctx?: TrackingContext): Promise<void> {
      const target = ctx ?? currentContext;
      if (!target || target.promises.size === 0) {
        return Promise.resolve();
      }
      // In fallback mode, we can't track promises automatically,
      // so we just resolve immediately
      return Promise.resolve();
    },
    pending(ctx?: TrackingContext): number {
      const target = ctx ?? currentContext;
      return target?.promises.size ?? 0;
    },
    activeContexts(): number[] {
      return currentContext ? [currentContext.id] : [];
    },
  };
}

/**
 * Get the async tracking API, using the native implementation if available,
 * otherwise falling back to a no-op implementation.
 *
 * This allows code to use async tracking unconditionally without checking
 * for availability, but the caller should be aware that in fallback mode
 * async operations won't actually be tracked.
 */
export function getAsyncTrackingOrFallback(): AsyncTrackingAPI {
  return getAsyncTracking() ?? createFallbackAsyncTracking();
}
