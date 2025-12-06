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
import { importModule, FsLoader } from "@natstack/build";

export type { ConsoleEntry };

// Re-export for convenience
export { AbortError, EvalError };

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
  if (!initialized) {
    throw new Error("Runtime not initialized. Call initialize() first.");
  }

  const { bindings = {}, signal } = options;

  try {
    const result = await evaluate(code, {
      language: "typescript",
      bindings,
      signal,
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
 * Create standard bindings for code execution.
 * Must be called after initialize().
 */
export function createBindings(extras?: Record<string, unknown>): Record<string, unknown> {
  if (!fsLoader) {
    throw new Error("Runtime not initialized. Call initialize() first.");
  }

  return {
    // Import npm packages from CDN (esm.sh)
    importModule,
    // Import modules from OPFS filesystem
    importOPFS: (path: string) => fsLoader!.importModule(path),
    ...extras,
  };
}
