/**
 * Execute CJS code with scope injection.
 */
export interface ExecuteOptions {
  /** Additional bindings to inject into scope */
  bindings?: Record<string, unknown>;
  /** Console proxy for capturing output */
  console?: Console;
  /** Custom require function. If not provided, uses globalThis.__natstackRequire__ */
  require?: (id: string) => unknown;
}

export interface ExecuteResult {
  /** The exports object (module.exports) */
  exports: Record<string, unknown>;
  /** The return value of the last expression (if any) */
  returnValue: unknown;
}

/**
 * Get the default require function from the global scope.
 * Returns undefined if not available.
 */
export function getDefaultRequire(): ((id: string) => unknown) | undefined {
  return (globalThis as Record<string, unknown>)["__natstackRequire__"] as
    | ((id: string) => unknown)
    | undefined;
}

/**
 * Get the async require function from the global scope.
 * Returns undefined if not available.
 */
export function getAsyncRequire(): ((id: string) => Promise<unknown>) | undefined {
  return (globalThis as Record<string, unknown>)["__natstackRequireAsync__"] as
    | ((id: string) => Promise<unknown>)
    | undefined;
}

/**
 * Get the preload modules function from the global scope.
 * Returns undefined if not available.
 */
export function getPreloadModules(): ((ids: string[]) => Promise<unknown[]>) | undefined {
  return (globalThis as Record<string, unknown>)["__natstackPreloadModules__"] as
    | ((ids: string[]) => Promise<unknown[]>)
    | undefined;
}

/**
 * Result of validating module requires.
 */
export interface ValidateRequiresResult {
  valid: boolean;
  /** Missing module specifier (if invalid) */
  missingModule?: string;
  /** Error message (if invalid) */
  error?: string;
}

/**
 * Validate that all required modules are available before execution.
 * This allows early failure with a descriptive error instead of runtime crashes.
 *
 * @param requires - Array of module specifiers to validate
 * @param requireFn - Optional custom require function (defaults to __natstackRequire__)
 * @returns Validation result with error details if invalid
 */
export function validateRequires(
  requires: string[],
  requireFn?: (id: string) => unknown
): ValidateRequiresResult {
  const require = requireFn ?? getDefaultRequire();

  if (!require) {
    return {
      valid: false,
      error:
        "__natstackRequire__ not available. Provide a custom require function or ensure the runtime is initialized.",
    };
  }

  for (const spec of requires) {
    try {
      require(spec);
    } catch {
      return {
        valid: false,
        missingModule: spec,
        error: `Module "${spec}" not available. Import it in the panel or add it to the expose list.`,
      };
    }
  }

  return { valid: true };
}

/**
 * Result of preloading module requires.
 */
export interface PreloadRequiresResult {
  success: boolean;
  /** Module that failed to load (if unsuccessful) */
  failedModule?: string;
  /** Error message (if unsuccessful) */
  error?: string;
}

/**
 * Preload all required modules asynchronously before execution.
 * Uses __natstackRequireAsync__ to load modules from CDN if not pre-bundled.
 *
 * @param requires - Array of module specifiers to preload
 * @returns Promise that resolves when all modules are loaded
 */
export async function preloadRequires(requires: string[]): Promise<PreloadRequiresResult> {
  const preloadFn = getPreloadModules();
  const asyncRequire = getAsyncRequire();

  // If preload function is available, use it for parallel loading
  if (preloadFn) {
    try {
      await preloadFn(requires);
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Try to extract the module name from the error
      const match = message.match(/Module "([^"]+)"/);
      return {
        success: false,
        failedModule: match?.[1],
        error: message,
      };
    }
  }

  // Fall back to sequential async require
  if (asyncRequire) {
    for (const spec of requires) {
      try {
        await asyncRequire(spec);
      } catch (err) {
        return {
          success: false,
          failedModule: spec,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
    return { success: true };
  }

  // No async loading available - fall back to sync validation
  const syncResult = validateRequires(requires);
  if (!syncResult.valid) {
    return {
      success: false,
      failedModule: syncResult.missingModule,
      error: syncResult.error,
    };
  }

  return { success: true };
}

export function execute(code: string, options: ExecuteOptions = {}): ExecuteResult {
  const { bindings = {}, console: consoleProxy = console } = options;

  const require =
    options.require ??
    ((globalThis as Record<string, unknown>)["__natstackRequire__"] as
      | ((id: string) => unknown)
      | undefined);

  if (!require) {
    throw new Error(
      "__natstackRequire__ not available. Provide a custom require function or ensure the runtime is initialized."
    );
  }

  const exports: Record<string, unknown> = {};
  const module = { exports };

  const scopeNames = Object.keys(bindings);
  const scopeValues = Object.values(bindings);

  // eslint-disable-next-line no-new-func
  const fn = new Function(
    "require",
    "exports",
    "module",
    "console",
    ...scopeNames,
    `"use strict";\n${code}`
  );

  const returnValue = fn(require, exports, module, consoleProxy, ...scopeValues);

  return {
    exports: module.exports as Record<string, unknown>,
    returnValue,
  };
}

/**
 * Execute and extract the default export.
 * Useful for extracting components or other default-exported values.
 *
 * @returns The default export, or throws if none found
 */
export function executeDefault<T = unknown>(code: string, options: ExecuteOptions = {}): T {
  const result = execute(code, options);

  const defaultExport = (result.exports as { default?: unknown }).default;
  if (defaultExport !== undefined) {
    return defaultExport as T;
  }

  // Check if exports itself is the value (module.exports = something)
  if (
    typeof result.exports === "function" ||
    (typeof result.exports === "object" &&
      result.exports !== null &&
      Object.keys(result.exports).length === 0)
  ) {
    // module.exports was set directly to a non-object or empty object
    // In CJS, if you do `module.exports = fn`, the exports object IS the function
  }

  // If exports is a function directly (module.exports = function)
  if (typeof result.exports === "function") {
    return result.exports as T;
  }

  throw new Error(
    "No default export found. Use `export default function MyComponent(...)` or `export default (props) => ...`. " +
    "Named exports like `export function App(...)` are not sufficient — add the `default` keyword."
  );
}
