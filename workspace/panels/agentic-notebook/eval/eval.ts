/**
 * Stateless Code Execution
 *
 * Each execution is independent - no persistent scope between calls.
 * Built on @natstack/build-eval.
 */

import {
  evaluate,
  initializeEval,
  AbortError,
  EvalError,
  type ConsoleEntry,
} from "@natstack/build-eval";
import { FsLoader } from "@natstack/build";
import * as React from "react";
import * as ReactDOM from "react-dom";
import * as ReactDOMClient from "react-dom/client";
import * as ReactJSXRuntime from "react/jsx-runtime";
import * as ReactJSXDevRuntime from "react/jsx-dev-runtime";

export type { ConsoleEntry };

// Re-export for convenience
export { AbortError, EvalError };

// -----------------------------------------------------------------------------
// Unified Module Import
// -----------------------------------------------------------------------------

const DEFAULT_CDN = "https://esm.sh";

/**
 * Host modules that should be shared with dynamically executed code.
 * This ensures that React hooks work correctly by using the same React instance.
 * JSX runtime modules are needed for the automatic JSX transform.
 */
const HOST_MODULES: Record<string, unknown> = {
  "react": React,
  "react-dom": ReactDOM,
  "react-dom/client": ReactDOMClient,
  "react/jsx-runtime": ReactJSXRuntime,
  "react/jsx-dev-runtime": ReactJSXDevRuntime,
};

/**
 * Check if a specifier is a bare module specifier (npm package name).
 * Bare specifiers don't start with '/', './', '../', or a protocol.
 */
function isBareSpecifier(specifier: string): boolean {
  if (specifier.startsWith("/")) return false;
  if (specifier.startsWith("./")) return false;
  if (specifier.startsWith("../")) return false;
  if (specifier.includes("://")) return false;
  if (specifier.startsWith("data:")) return false;
  if (specifier.startsWith("blob:")) return false;
  return true;
}

/**
 * Create a unified import function that handles both CDN and OPFS imports.
 *
 * - Host modules (react, react-dom) → shared from host app (ensures hooks work)
 * - Bare specifiers (e.g., "lodash-es") → CDN (esm.sh)
 * - Relative/absolute paths (e.g., "./utils", "/scripts/helper.ts") → OPFS
 * - URLs → direct import
 */
function createUnifiedImport(fsLoader: FsLoader): (specifier: string) => Promise<unknown> {
  const resolver = async (specifier: string): Promise<unknown> => {
    // Check for host modules first (React must be shared for hooks to work)
    if (specifier in HOST_MODULES) {
      return HOST_MODULES[specifier];
    }

    // Bare specifiers go to CDN
    if (isBareSpecifier(specifier)) {
      const url = `${DEFAULT_CDN}/${specifier}`;
      return import(/* webpackIgnore: true */ url);
    }

    // URLs are imported directly
    if (specifier.includes("://")) {
      return import(/* webpackIgnore: true */ specifier);
    }

    // Relative and absolute paths go to OPFS
    return fsLoader.importModule(specifier, { importModule: resolver });
  };
  return resolver;
}

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface ExecuteOptions {
  /** Variables/functions available in scope */
  bindings?: Record<string, unknown>;
  /** AbortSignal for cancellation */
  signal?: AbortSignal;
}

export interface ExecuteResult {
  success: boolean;
  value?: unknown;
  error?: Error;
  console: ConsoleEntry[];
}

// -----------------------------------------------------------------------------
// Initialization
// -----------------------------------------------------------------------------

let initialized = false;
let fsLoader: FsLoader | null = null;

/**
 * Initialize the code execution runtime.
 * Must be called before execute() or createBindings().
 */
export async function initialize(): Promise<void> {
  if (initialized) return;

  await initializeEval();
  fsLoader = new FsLoader();
  initialized = true;
}

/**
 * Check if the runtime is initialized.
 */
export function isInitialized(): boolean {
  return initialized;
}

// -----------------------------------------------------------------------------
// Core
// -----------------------------------------------------------------------------

/**
 * Execute TypeScript/JavaScript code.
 *
 * Each call is stateless - bindings don't persist between executions.
 *
 * @example
 * ```ts
 * await initialize();
 *
 * const result = await execute(`1 + 2`);
 * console.log(result.value); // 3
 *
 * const result2 = await execute(`x * 2`, {
 *   bindings: { x: 21 }
 * });
 * console.log(result2.value); // 42
 * ```
 */
export async function execute(
  code: string,
  options: ExecuteOptions = {}
): Promise<ExecuteResult> {
  if (!initialized || !fsLoader) {
    throw new Error("Runtime not initialized. Call initialize() first.");
  }

  const { bindings = {}, signal } = options;

  // Create unified import function for this execution
  const importModule = createUnifiedImport(fsLoader);

  try {
    const result = await evaluate(code, {
      language: "typescript",
      bindings,
      signal,
      importModule,
    });

    return {
      success: true,
      value: result.returnValue,
      console: result.console,
    };
  } catch (error) {
    if (error instanceof AbortError) {
      return {
        success: false,
        error: new Error("Execution aborted"),
        console: [],
      };
    }

    if (error instanceof EvalError) {
      const consoleOutput = (error as EvalError & { console?: ConsoleEntry[] }).console ?? [];
      return {
        success: false,
        error,
        console: consoleOutput,
      };
    }

    return {
      success: false,
      error: error instanceof Error ? error : new Error(String(error)),
      console: [],
    };
  }
}

// -----------------------------------------------------------------------------
// Bindings
// -----------------------------------------------------------------------------

/**
 * Get the unified import function.
 * Must be called after initialize().
 *
 * Returns a function that resolves imports:
 * - Bare specifiers (react, lodash-es) → CDN (esm.sh)
 * - Paths (./utils.ts, /config.json) → OPFS
 */
export function getImportModule(): (specifier: string) => Promise<unknown> {
  if (!fsLoader) {
    throw new Error("Runtime not initialized. Call initialize() first.");
  }
  return createUnifiedImport(fsLoader);
}

/**
 * Create standard bindings for code execution.
 * Must be called after initialize().
 *
 * Note: The `importModule` binding is provided for backward compatibility,
 * but users can now use standard `import` syntax which is automatically
 * resolved (bare specifiers → CDN, paths → OPFS).
 */
export function createBindings(extras?: Record<string, unknown>): Record<string, unknown> {
  return {
    importModule: getImportModule(),
    ...extras,
  };
}
