import type { MethodExecutionContext } from "@natstack/agentic-messaging";

// Lazy-loaded @natstack/eval (~460KB sucrase deferred until first eval tool invocation)
let evalModule: typeof import("@natstack/eval") | null = null;
async function getEvalModule() {
  if (!evalModule) {
    try { evalModule = await import("@natstack/eval"); }
    catch (e) { throw new Error(`Failed to load eval module: ${e instanceof Error ? e.message : e}`); }
  }
  return evalModule;
}

function wrapForTopLevelAwait(code: string): string {
  return `return (async () => {\n${code}\n})()`;
}

function isPromise(value: unknown): value is Promise<unknown> {
  return !!value && typeof (value as { then?: unknown }).then === "function";
}

/**
 * Safely serialize a value for JSON transmission.
 * Handles circular references, functions, symbols, and other non-serializable types.
 */
function safeSerialize(value: unknown, maxDepth = 10): unknown {
  const seen = new WeakSet<object>();

  function serialize(val: unknown, depth: number): unknown {
    // Primitives pass through
    if (val === null || val === undefined) return val;
    if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") {
      return val;
    }

    // Functions and symbols become string representations
    if (typeof val === "function") {
      return `[Function: ${val.name || "anonymous"}]`;
    }
    if (typeof val === "symbol") {
      return val.toString();
    }
    if (typeof val === "bigint") {
      return val.toString();
    }

    // Non-objects handled
    if (typeof val !== "object") {
      return String(val);
    }

    // Depth limit
    if (depth > maxDepth) {
      return "[Max depth exceeded]";
    }

    // Circular reference check
    if (seen.has(val)) {
      return "[Circular]";
    }
    seen.add(val);

    // Special object types
    if (val instanceof Date) {
      return val.toISOString();
    }
    if (val instanceof RegExp) {
      return val.toString();
    }
    if (val instanceof Error) {
      return { name: val.name, message: val.message, stack: val.stack };
    }
    if (val instanceof Map) {
      return { __type: "Map", entries: serialize(Array.from(val.entries()), depth + 1) };
    }
    if (val instanceof Set) {
      return { __type: "Set", values: serialize(Array.from(val.values()), depth + 1) };
    }
    if (ArrayBuffer.isView(val) || val instanceof ArrayBuffer) {
      return `[${val.constructor.name}]`;
    }

    // Arrays
    if (Array.isArray(val)) {
      return val.map((item) => serialize(item, depth + 1));
    }

    // Plain objects
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(val)) {
      try {
        result[key] = serialize((val as Record<string, unknown>)[key], depth + 1);
      } catch {
        result[key] = "[Unserializable]";
      }
    }
    return result;
  }

  return serialize(value, 0);
}

// =============================================================================
// Timeout Configuration
// =============================================================================
// All timeout values derive from these base constants.
// The framework timeout acts as a safety net ceiling.

/** Default timeout for async operations if not specified by caller */
export const EVAL_DEFAULT_TIMEOUT_MS = 10_000; // 10 seconds

/** Maximum timeout a caller can request - requests above this are clamped */
export const EVAL_MAX_TIMEOUT_MS = 90_000; // 90 seconds

/** Buffer added to tracking context cleanup (allows graceful cleanup after timeout) */
const TRACKING_CLEANUP_BUFFER_MS = 5_000; // 5 seconds

/**
 * Framework-level timeout for the tool definition.
 * This is a safety net that should never fire in normal operation.
 * Set slightly higher than EVAL_MAX_TIMEOUT_MS to allow the per-call timeout to handle things.
 */
export const EVAL_FRAMEWORK_TIMEOUT_MS = EVAL_MAX_TIMEOUT_MS + TRACKING_CLEANUP_BUFFER_MS; // 165 seconds

/**
 * Race a promise against a timeout.
 * Returns a cleanup function that should be called when done.
 */
function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void
): { promise: Promise<T>; cleanup: () => void } {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let settled = false;

  const cleanup = () => {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  };

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      if (!settled) {
        settled = true;
        onTimeout();
        reject(new Error(`Timeout: ${timeoutMs}ms exceeded`));
      }
    }, timeoutMs);
  });

  const racedPromise = Promise.race([promise, timeoutPromise]).finally(() => {
    settled = true;
    cleanup();
  });

  return { promise: racedPromise, cleanup };
}

export interface EvalToolArgs {
  /** The TypeScript/JavaScript code to execute */
  code: string;
  /** Target syntax (default: "tsx") */
  syntax?: "typescript" | "jsx" | "tsx";
  /**
   * Timeout in ms for async operations.
   * - Default: EVAL_DEFAULT_TIMEOUT_MS
   * - Maximum: EVAL_MAX_TIMEOUT_MS - values above this are clamped
   * - Set to 0 to skip waiting for async operations (returns immediately after sync execution)
   */
  timeout?: number;
}

export interface EvalToolResult {
  success: boolean;
  /** Formatted console output (final) */
  consoleOutput: string;
  /** Return value (if any) */
  returnValue?: unknown;
  /** Error message (if failed) */
  error?: string;
}

/**
 * Execute TypeScript/JavaScript code for side-effects.
 *
 * Timeout behavior:
 * - The `timeout` arg controls how long to wait for async operations (default: 10s, max: 60s)
 * - Set timeout=0 to skip async waiting entirely
 * - The framework's ToolDefinition.timeout provides a hard ceiling as a safety net
 */
export async function executeEvalTool(
  args: EvalToolArgs,
  ctx: MethodExecutionContext,
  options?: { onConsoleEntry?: (formatted: string) => void }
): Promise<EvalToolResult> {
  const { code, syntax = "tsx" } = args;

  // Clamp timeout to [0, EVAL_MAX_TIMEOUT_MS]
  const requestedTimeout = args.timeout ?? EVAL_DEFAULT_TIMEOUT_MS;
  const timeout = Math.max(0, Math.min(requestedTimeout, EVAL_MAX_TIMEOUT_MS));

  // Lazy-load the eval module
  const {
    transformCode,
    execute,
    createConsoleCapture,
    formatConsoleEntry,
    formatConsoleOutput,
    getAsyncTracking,
    getDefaultRequire,
    validateRequires,
  } = await getEvalModule();

  // Use unified async tracking API from @natstack/eval
  const tracking = getAsyncTracking();

  // Create a tracking context with auto-cleanup timeout (allows graceful cleanup after timeout)
  const trackingContext = tracking?.start({
    maxTimeout: timeout > 0 ? timeout + TRACKING_CLEANUP_BUFFER_MS : TRACKING_CLEANUP_BUFFER_MS,
  });

  const capture = createConsoleCapture();

  const unsubscribe = capture.onEntry((entry) => {
    const formatted = formatConsoleEntry(entry);
    options?.onConsoleEntry?.(formatted);
    if (tracking && trackingContext) {
      tracking.pause(trackingContext);
      try {
        const promise = ctx.stream({ type: "console", content: formatted });
        tracking.ignore(promise);
        void promise.catch(() => {});
      } finally {
        tracking.resume(trackingContext);
      }
    } else {
      void ctx.stream({ type: "console", content: formatted }).catch(() => {});
    }
  });

  try {
    const transformed = await transformCode(code, { syntax });

    // Use unified require validation from @natstack/eval
    const require = getDefaultRequire();
    if (!require) {
      return {
        success: false,
        consoleOutput: "",
        error: "__natstackRequire__ not available. Build may be outdated.",
      };
    }

    const validation = validateRequires(transformed.requires, require);
    if (!validation.valid) {
      return {
        success: false,
        consoleOutput: "",
        error: validation.error ?? `Module "${validation.missingModule}" not available.`,
      };
    }

    // Enter the tracking context for code execution
    if (tracking && trackingContext) {
      tracking.enter(trackingContext);
    }

    const wrapped = wrapForTopLevelAwait(transformed.code);
    let result: ReturnType<typeof execute>;
    try {
      result = execute(wrapped, {
        console: capture.proxy,
      });
    } finally {
      tracking?.exit();
    }

    // Wait for async operations if timeout > 0
    if (timeout > 0) {
      // Wait for tracked side-effect promises (fetch calls, etc.)
      if (tracking && trackingContext) {
        await tracking.waitAll(timeout, trackingContext);
      }

      // Await the return value if it's a promise
      let returnValue = result.returnValue;
      if (isPromise(returnValue)) {
        const { promise: timedPromise } = withTimeout(
          returnValue,
          timeout,
          () => {} // Timeout already enforced by tracking.waitAll
        );
        returnValue = await timedPromise;
      }

      const safeReturnValue = safeSerialize(returnValue ?? result.exports.default);
      return {
        success: true,
        consoleOutput: formatConsoleOutput(capture.getEntries()),
        returnValue: safeReturnValue,
      };
    } else {
      // timeout=0: Return immediately without waiting for async
      const safeReturnValue = safeSerialize(result.exports.default);
      return {
        success: true,
        consoleOutput: formatConsoleOutput(capture.getEntries()),
        returnValue: safeReturnValue,
      };
    }
  } catch (err) {
    return {
      success: false,
      consoleOutput: formatConsoleOutput(capture.getEntries()),
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    unsubscribe();
    // Stop and clean up the tracking context (clears promise references)
    if (tracking && trackingContext) {
      tracking.stop(trackingContext);
    }
  }
}
