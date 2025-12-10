/**
 * ESM Execution
 *
 * Unified primitive for executing ESM code via AsyncFunction.
 * Used by evaluate(), compileMDX(), and FsLoader.
 */

import { AsyncFunction } from "./async-function.js";
import { transformEsmForAsyncExecution } from "./esm-transform.js";

/** Reserved binding names that could cause prototype pollution */
const RESERVED_BINDINGS = new Set([
  "__proto__",
  "constructor",
  "prototype",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
]);

/**
 * Validate that binding names don't include dangerous prototypes.
 */
function validateBindingNames(names: string[]): void {
  for (const name of names) {
    if (RESERVED_BINDINGS.has(name)) {
      throw new Error(
        `Binding name "${name}" is reserved and cannot be used to prevent prototype pollution.`
      );
    }
  }
}

/**
 * Check if a string is a valid JavaScript identifier.
 */
function isValidIdentifier(name: string): boolean {
  return /^[$A-Z_a-z][$\w]*$/.test(name);
}

export interface ExecuteEsmOptions {
  /**
   * Function to resolve external module imports.
   * Called for bare specifiers like 'react' or 'lodash-es'.
   * If not provided, external imports will throw an error.
   */
  importModule?: (specifier: string) => Promise<unknown>;

  /**
   * Scope bindings to inject into the execution context.
   * Keys become variable names, values become their values.
   */
  scope?: Record<string, unknown>;

  /**
   * Additional parameters to pass to the AsyncFunction.
   * Keys are parameter names, values are passed as arguments.
   * Use this for internal runtime values like console proxies.
   */
  params?: Record<string, unknown>;

  /**
   * Code to prepend before the transformed ESM code.
   * Useful for setting up aliases or helper functions.
   */
  preamble?: string;

  /**
   * Code to append after the transformed ESM code.
   * Useful for returning specific values.
   */
  epilogue?: string;
}

export interface ExecuteEsmResult {
  /** The exports object containing all exported values */
  exports: Record<string, unknown>;

  /** The return value from the epilogue, if any */
  returnValue: unknown;
}

/**
 * Execute ESM code with custom import resolution and scope injection.
 *
 * This is the core execution primitive that:
 * 1. Transforms ESM imports/exports for AsyncFunction execution
 * 2. Injects scope bindings safely
 * 3. Routes external imports through the provided resolver
 * 4. Captures all exports
 *
 * @param code - ESM code to execute (should be JS, not TS)
 * @param options - Execution options
 * @returns The exports object and any return value
 *
 * @example
 * ```typescript
 * const result = await executeEsm(`
 *   import { useState } from 'react';
 *   export const count = 42;
 *   export default function App() { return <div>{count}</div>; }
 * `, {
 *   importModule: async (spec) => {
 *     if (spec === 'react') return React;
 *     throw new Error(`Unknown module: ${spec}`);
 *   },
 * });
 * console.log(result.exports.count); // 42
 * console.log(result.exports.default); // App function
 * ```
 */
export async function executeEsm(
  code: string,
  options: ExecuteEsmOptions = {}
): Promise<ExecuteEsmResult> {
  const {
    importModule,
    scope = {},
    params = {},
    preamble = "",
    epilogue = "",
  } = options;

  // Validate scope binding names
  const scopeKeys = Object.keys(scope).filter(isValidIdentifier);
  validateBindingNames(scopeKeys);

  // Validate param names
  const paramKeys = Object.keys(params).filter(isValidIdentifier);
  validateBindingNames(paramKeys);

  // Transform ESM to AsyncFunction-compatible code
  const transformedCode = transformEsmForAsyncExecution(code, {
    importIdentifier: "__importModule__",
    exportIdentifier: "__exports__",
  });

  // Build scope destructuring
  const scopeDestructure =
    scopeKeys.length > 0
      ? `const { ${scopeKeys.join(", ")} } = __scope__;`
      : "";

  // Build the full code to execute
  const fullCode = `
${preamble}
${scopeDestructure}

${transformedCode}

${epilogue}
`;

  // Create the import resolver (throws helpful error if not provided)
  const importResolver =
    importModule ??
    ((specifier: string) => {
      throw new Error(
        `Cannot import "${specifier}": no importModule function provided. ` +
          `Pass an importModule option to enable external imports.`
      );
    });

  // Build function parameters
  const fnParamNames = ["__scope__", "__exports__", "__importModule__", ...paramKeys];
  const fnParamValues = [scope, {}, importResolver, ...paramKeys.map((k) => params[k])];

  // Create and execute the async function
  const fn = new AsyncFunction(...fnParamNames, fullCode);
  const exports = fnParamValues[1] as Record<string, unknown>;
  const returnValue = await fn(...fnParamValues);

  return { exports, returnValue };
}

/**
 * Get the primary return value from ESM exports.
 *
 * Returns the default export if present, otherwise returns the full exports object.
 * Uses `"default" in exports` to distinguish between `export default undefined`
 * and no default export.
 */
export function getExportReturnValue(exports: Record<string, unknown>): unknown {
  if ("default" in exports) {
    return exports["default"];
  }
  if (Object.keys(exports).length > 0) {
    return exports;
  }
  return undefined;
}
