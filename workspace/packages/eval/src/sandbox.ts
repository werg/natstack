/**
 * Unified sandbox execution engine.
 *
 * Consolidates logic from @workspace/agentic-tools/eval/evalTool.ts and
 * @workspace/tool-ui/src/eval/feedbackComponent.tsx into one module.
 *
 * Two entry points:
 * - executeSandbox(): imperative code execution (eval tool)
 * - compileComponent(): React component compilation (inline_ui, feedback_custom)
 *
 * Both use the same transform → preload → execute pipeline from @workspace/eval.
 */

import type { ComponentType } from "react";
import { transformCode } from "./transform.js";
import {
  execute,
  executeDefault,
  getDefaultRequire,
  validateRequires,
  preloadRequires,
} from "./execute.js";
import {
  createConsoleCapture,
  formatConsoleEntry,
  formatConsoleOutput,
} from "./consoleCapture.js";
import { getAsyncTracking } from "./asyncTracking.js";

// =============================================================================
// Timeout Constants
// =============================================================================

/** Default timeout for async operations: 0 = no timeout */
export const SANDBOX_DEFAULT_TIMEOUT_MS = 0;

/** @deprecated No longer enforced — kept for backward compatibility */
export const SANDBOX_MAX_TIMEOUT_MS = 0;

/** Buffer added to tracking context cleanup */
const TRACKING_CLEANUP_BUFFER_MS = 5_000;

/** @deprecated No longer enforced — kept for backward compatibility */
export const SANDBOX_FRAMEWORK_TIMEOUT_MS = 0;

// =============================================================================
// Types
// =============================================================================

export interface SandboxOptions {
  /** Source syntax (default: "tsx") */
  syntax?: "typescript" | "jsx" | "tsx";
  /** Timeout in ms for async operations (default: 10s, max: 90s, 0 = skip async) */
  timeout?: number;
  /** Packages to build and load before execution.
   *  - Workspace packages: value is "latest" or a git ref (branch/tag/SHA)
   *  - npm packages: value is "npm:<version>" (e.g. "npm:^4.17.21", "npm:latest")
   */
  imports?: Record<string, string>;
  /** Console streaming callback */
  onConsole?: (formatted: string) => void;
  /** Dynamic import loader — keeps this module free of runtime/RPC deps */
  loadImport?: (specifier: string, ref: string | undefined, externals: string[]) => Promise<string>;
  /** Extra scope variables injected into the sandbox */
  bindings?: Record<string, unknown>;
}

export interface SandboxResult {
  success: boolean;
  /** Formatted console output (final) */
  consoleOutput: string;
  /** Return value (if any) */
  returnValue?: unknown;
  /** Exported values */
  exports?: Record<string, unknown>;
  /** Error message (if failed) */
  error?: string;
}

export interface CompileResult<T> {
  success: boolean;
  /** The compiled component/value */
  Component?: T;
  /** Cache key for cleanup */
  cacheKey?: string;
  /** Error message (if failed) */
  error?: string;
}

// =============================================================================
// Module Map Helpers
// =============================================================================

function getModuleMap(): Record<string, unknown> {
  return ((globalThis as Record<string, unknown>)["__natstackModuleMap__"] ??= {}) as Record<string, unknown>;
}

/** Tracks bundle content last loaded per specifier to skip re-execution */
const loadedBundleContent = new Map<string, string>();

/**
 * Load a CJS library bundle into the panel's module map.
 * Skips re-execution if the bundle content is identical to what's already loaded.
 */
function loadLibraryBundle(specifier: string, bundleCode: string): void {
  if (loadedBundleContent.get(specifier) === bundleCode) return;

  const moduleMap = getModuleMap();
  const requireFn = (globalThis as Record<string, unknown>)["__natstackRequire__"] as ((id: string) => unknown) | undefined;
  if (!requireFn) throw new Error("__natstackRequire__ not available");

  const exports: Record<string, unknown> = {};
  const module = { exports };
  // eslint-disable-next-line no-new-func
  const fn = new Function("require", "exports", "module", bundleCode);
  fn(requireFn, exports, module);
  moduleMap[specifier] = module.exports;
  loadedBundleContent.set(specifier, bundleCode);
}

/**
 * Build and load workspace packages into the module map.
 */
async function loadImports(
  imports: Record<string, string>,
  loadImport: (specifier: string, ref: string | undefined, externals: string[]) => Promise<string>,
): Promise<void> {
  const moduleMap = getModuleMap();
  for (const [specifier, refValue] of Object.entries(imports)) {
    const ref = refValue === "latest" ? undefined : refValue;
    // Recompute externals each iteration so earlier imports are externalized
    const externals = Object.keys(moduleMap);
    const bundleCode = await loadImport(specifier, ref, externals);
    loadLibraryBundle(specifier, bundleCode);
  }
}

// =============================================================================
// Serialization
// =============================================================================

/**
 * Safely serialize a value for JSON transmission.
 * Handles circular references, functions, symbols, and other non-serializable types.
 */
function safeSerialize(value: unknown, maxDepth = 10): unknown {
  const seen = new WeakSet<object>();

  function serialize(val: unknown, depth: number): unknown {
    if (val === null || val === undefined) return val;
    if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") return val;
    if (typeof val === "function") return `[Function: ${val.name || "anonymous"}]`;
    if (typeof val === "symbol") return val.toString();
    if (typeof val === "bigint") return val.toString();
    if (typeof val !== "object") return String(val);
    if (depth > maxDepth) return "[Max depth exceeded]";
    if (seen.has(val)) return "[Circular]";
    seen.add(val);
    if (val instanceof Date) return val.toISOString();
    if (val instanceof RegExp) return val.toString();
    if (val instanceof Error) return { name: val.name, message: val.message, stack: val.stack };
    if (val instanceof Map) return { __type: "Map", entries: serialize(Array.from(val.entries()), depth + 1) };
    if (val instanceof Set) return { __type: "Set", values: serialize(Array.from(val.values()), depth + 1) };
    if (ArrayBuffer.isView(val) || val instanceof ArrayBuffer) return `[${val.constructor.name}]`;
    if (Array.isArray(val)) return val.map((item) => serialize(item, depth + 1));
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(val)) {
      try { result[key] = serialize((val as Record<string, unknown>)[key], depth + 1); }
      catch { result[key] = "[Unserializable]"; }
    }
    return result;
  }

  return serialize(value, 0);
}

// =============================================================================
// Timeout Helper
// =============================================================================

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void,
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

function wrapForTopLevelAwait(code: string): string {
  return `return (async () => {\n${code}\n})()`;
}

function isPromise(value: unknown): value is Promise<unknown> {
  return !!value && typeof (value as { then?: unknown }).then === "function";
}

// =============================================================================
// executeSandbox
// =============================================================================

/**
 * Unified imperative execution pipeline.
 *
 * 1. Transform code (Sucrase)
 * 2. Load dynamic imports via loadImport callback
 * 3. Preload requires
 * 4. Wrap for top-level await
 * 5. Set up console capture with streaming
 * 6. Set up async tracking
 * 7. Execute with scope bindings
 * 8. Wait for async operations
 * 9. Safe-serialize return value
 */
export async function executeSandbox(
  code: string,
  options: SandboxOptions = {},
): Promise<SandboxResult> {
  const { syntax = "tsx", bindings = {} } = options;

  // 0 or undefined = use default; negative = no timeout
  const requestedTimeout = options.timeout ?? SANDBOX_DEFAULT_TIMEOUT_MS;
  const timeout = requestedTimeout <= 0 ? 0 : Math.max(0, requestedTimeout);

  const tracking = getAsyncTracking();
  const trackingContext = tracking?.start({
    maxTimeout: timeout > 0 ? timeout + TRACKING_CLEANUP_BUFFER_MS : TRACKING_CLEANUP_BUFFER_MS,
  });

  const capture = createConsoleCapture();

  // Pause tracking around onConsole so any promises created by the callback
  // (e.g. ctx.stream()) are not tracked by waitAll — prevents spurious timeouts.
  const unsubscribe = capture.onEntry((entry) => {
    const formatted = formatConsoleEntry(entry);
    if (tracking && trackingContext) {
      tracking.pause(trackingContext);
      try {
        options.onConsole?.(formatted);
      } finally {
        tracking.resume(trackingContext);
      }
    } else {
      options.onConsole?.(formatted);
    }
  });

  try {
    // Load on-demand imports
    if (options.imports && Object.keys(options.imports).length > 0) {
      if (!options.loadImport) {
        throw new Error("loadImport callback required when imports are specified");
      }
      await loadImports(options.imports, options.loadImport);
    }

    const transformed = await transformCode(code, { syntax });

    // Validate requires
    const requireFn = getDefaultRequire();
    if (!requireFn) {
      return {
        success: false,
        consoleOutput: "",
        error: "__natstackRequire__ not available. Build may be outdated.",
      };
    }

    // Debug: log available modules and what the code requires
    if (transformed.requires.length > 0) {
      const moduleMap = getModuleMap();
      const available = Object.keys(moduleMap);
      options.onConsole?.(`[eval] Requires: ${transformed.requires.join(", ")}`);
      options.onConsole?.(`[eval] Available modules: ${available.join(", ")}`);
    }

    const validation = validateRequires(transformed.requires, requireFn);
    if (!validation.valid) {
      const moduleMap = getModuleMap();
      const available = Object.keys(moduleMap);
      return {
        success: false,
        consoleOutput: "",
        error: `Module "${validation.missingModule}" not available. Available: ${available.join(", ")}`,
      };
    }

    // Enter tracking context
    if (tracking && trackingContext) {
      tracking.enter(trackingContext);
    }

    const wrapped = wrapForTopLevelAwait(transformed.code);
    let result: ReturnType<typeof execute>;
    try {
      result = execute(wrapped, {
        console: capture.proxy,
        bindings,
      });
    } finally {
      tracking?.exit();
    }

    // Wait for async operations
    if (timeout > 0) {
      if (tracking && trackingContext) {
        await tracking.waitAll(timeout, trackingContext);
      }

      let returnValue = result.returnValue;
      if (isPromise(returnValue)) {
        const { promise: timedPromise } = withTimeout(returnValue, timeout, () => {});
        returnValue = await timedPromise;
      }

      const safeReturnValue = safeSerialize(returnValue ?? result.exports["default"]);
      return {
        success: true,
        consoleOutput: formatConsoleOutput(capture.getEntries()),
        returnValue: safeReturnValue,
        exports: result.exports,
      };
    } else {
      const safeReturnValue = safeSerialize(result.exports["default"]);
      return {
        success: true,
        consoleOutput: formatConsoleOutput(capture.getEntries()),
        returnValue: safeReturnValue,
        exports: result.exports,
      };
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const errorStack = err instanceof Error ? err.stack : undefined;
    // Include stack in console output for debugging RPC/OAuth errors
    const consoleEntries = capture.getEntries();
    const debugInfo = errorStack ? `\n[eval] Error stack: ${errorStack}` : "";
    return {
      success: false,
      consoleOutput: formatConsoleOutput(consoleEntries) + debugInfo,
      error: errorMessage,
    };
  } finally {
    unsubscribe();
    if (tracking && trackingContext) {
      tracking.stop(trackingContext);
    }
  }
}

// =============================================================================
// compileComponent
// =============================================================================

/**
 * Compile TSX code into a React component.
 *
 * Used for both persistent (inline_ui) and transient (feedback_custom) components.
 * The when-to-compile decision is made by the caller; callers store the result
 * in their own state (React useState / Map) to avoid recompilation on re-render.
 */
export async function compileComponent<T = ComponentType<Record<string, unknown>>>(
  code: string,
): Promise<CompileResult<T>> {
  try {
    const transformed = await transformCode(code, { syntax: "tsx" });

    const preloadResult = await preloadRequires(transformed.requires);
    if (!preloadResult.success) {
      return { success: false, error: preloadResult.error };
    }

    const cacheKey = transformed.code;
    const Component = executeDefault<T>(cacheKey);
    return { success: true, Component, cacheKey };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
