/**
 * Cell Executor
 *
 * Executes cell code in a persistent scope context using AsyncFunction.
 * Supports mutable vs const variable tracking and abort signals.
 */

import { transformCell } from "./transformer.js";
import type { CellResult, ExecutionHelpers, TransformResult } from "./types.js";

// Get the AsyncFunction constructor
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<unknown>;

/** Injected parameter names for cell execution context */
const SCOPE_PARAM = "__scope__";
const CONSOLE_PARAM = "__console__";
const IMPORT_MODULE_PARAM = "__importModule__";
const IMPORT_OPFS_PARAM = "__importOPFS__";
const SIGNAL_PARAM = "__signal__";
const CHECK_ABORT_PARAM = "__checkAbort__";
const EXPORTS_PARAM = "__exports__";

/** Execution options */
export interface ExecuteOptions {
  /** Timeout in milliseconds (0 = no timeout) */
  timeout?: number;
}

/** Error thrown when execution is aborted */
export class AbortError extends Error {
  constructor(message = "Execution aborted") {
    super(message);
    this.name = "AbortError";
  }
}

/** Error thrown when execution times out */
export class TimeoutError extends Error {
  constructor(message = "Execution timed out") {
    super(message);
    this.name = "TimeoutError";
  }
}

/**
 * LRU cache for valid identifier checks with bounded size.
 * Prevents memory leaks in long-running sessions with many dynamic keys.
 */
class IdentifierCache {
  private cache = new Map<string, boolean>();
  private readonly maxSize: number;

  constructor(maxSize = 1000) {
    this.maxSize = maxSize;
  }

  get(name: string): boolean | undefined {
    const value = this.cache.get(name);
    if (value !== undefined) {
      // Move to end (most recently used)
      this.cache.delete(name);
      this.cache.set(name, value);
    }
    return value;
  }

  set(name: string, value: boolean): void {
    if (this.cache.has(name)) {
      this.cache.delete(name);
    } else if (this.cache.size >= this.maxSize) {
      // Remove oldest entry (first item in Map iteration order)
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.cache.delete(oldest);
      }
    }
    this.cache.set(name, value);
  }

  clear(): void {
    this.cache.clear();
  }
}

const identifierCache = new IdentifierCache();

/**
 * Execute a cell of code within a session scope.
 *
 * @param code - The cell code to execute
 * @param scope - The persistent scope object
 * @param mutableKeys - Set of keys in scope that are mutable (let/var)
 * @param helpers - Execution helpers (console, import functions, abort signal)
 * @param options - Execution options (timeout)
 * @returns The execution result including any console output
 */
export async function executeCell(
  code: string,
  scope: Record<string, unknown>,
  mutableKeys: Set<string>,
  helpers: ExecutionHelpers,
  options: ExecuteOptions = {}
): Promise<CellResult> {
  const { console: consoleCapture, importModule, importOPFS, signal, exports = {} } = helpers;
  const { timeout = 0 } = options;

  // Check if already aborted
  if (signal?.aborted) {
    return {
      success: false,
      error: new AbortError(),
      output: consoleCapture.getOutput(),
      constNames: [],
      mutableNames: [],
    };
  }

  // Transform top-level declarations to scope assignments
  let transformResult: TransformResult;
  try {
    transformResult = transformCell(code);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error : new Error(String(error)),
      output: consoleCapture.getOutput(),
      constNames: [],
      mutableNames: [],
    };
  }

  const { code: transformedCode, constNames, mutableNames } = transformResult;

  // Wrap with scope access and helpers
  const wrappedCode = wrapCellCode(transformedCode, scope, mutableKeys);

  try {
    // Create the async function
    const fn = new AsyncFunction(
      SCOPE_PARAM,
      CONSOLE_PARAM,
      IMPORT_MODULE_PARAM,
      IMPORT_OPFS_PARAM,
      SIGNAL_PARAM,
      CHECK_ABORT_PARAM,
      EXPORTS_PARAM,
      wrappedCode
    );

    // Create abort checker function that can be called in user code
    const checkAbort = () => {
      if (signal?.aborted) {
        throw new AbortError();
      }
    };

    // Execute with timeout if specified
    let result: unknown;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let abortHandler: (() => void) | undefined;
    // Store signal reference for cleanup to avoid memory leak if signal reference changes
    const signalRef = signal;

    try {
      if (timeout > 0 || signal) {
        // Create a promise that rejects on timeout or abort
        const cancelPromise = new Promise<never>((_, reject) => {
          if (timeout > 0) {
            timeoutId = setTimeout(() => reject(new TimeoutError()), timeout);
          }
          if (signal) {
            abortHandler = () => {
              if (timeoutId) clearTimeout(timeoutId);
              reject(new AbortError());
            };
            signal.addEventListener("abort", abortHandler, { once: true });
          }
        });

        result = await Promise.race([
          fn(scope, consoleCapture.proxy, importModule, importOPFS, signal, checkAbort, exports),
          cancelPromise,
        ]);
      } else {
        // No timeout, no signal
        result = await fn(scope, consoleCapture.proxy, importModule, importOPFS, signal, checkAbort, exports);
      }
    } finally {
      // Clean up timeout and abort listener to prevent memory leaks
      if (timeoutId) clearTimeout(timeoutId);
      if (abortHandler && signalRef) {
        signalRef.removeEventListener("abort", abortHandler);
      }
    }

    return {
      success: true,
      result,
      output: consoleCapture.getOutput(),
      constNames,
      mutableNames,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error : new Error(String(error)),
      output: consoleCapture.getOutput(),
      constNames,
      mutableNames,
    };
  }
}

/**
 * Wrap cell code with scope destructuring and helper aliases.
 *
 * This function creates a closure that:
 * 1. Provides helper functions (console, importModule, etc.) as local variables
 * 2. Destructures existing scope variables (const for immutable, let for mutable)
 * 3. Executes the transformed cell code
 * 4. Syncs mutable variables back to scope (in a finally block to handle errors)
 *
 * Mutable variables (declared with let/var in previous cells) are destructured
 * using `let` and synced back to the scope after execution. Const variables are
 * destructured using `const` and cannot be reassigned.
 *
 * @param code - The transformed cell code to wrap
 * @param scope - The persistent scope object containing all session variables
 * @param mutableKeys - Set of keys in scope that are mutable (let/var declarations)
 * @returns The wrapped code string ready for execution
 */
function wrapCellCode(
  code: string,
  scope: Record<string, unknown>,
  mutableKeys: Set<string>
): string {
  const existingNames = Object.keys(scope);

  // Filter out names that would cause syntax errors when destructured
  const validNames = existingNames.filter(isValidIdentifier);

  // Separate into mutable (let) and immutable (const) destructures
  const mutableNames = validNames.filter((n) => mutableKeys.has(n));
  const constNames = validNames.filter((n) => !mutableKeys.has(n));

  // Create destructuring statements
  const constDestructure =
    constNames.length > 0 ? `const { ${constNames.join(", ")} } = ${SCOPE_PARAM};` : "";
  const mutableDestructure =
    mutableNames.length > 0 ? `let { ${mutableNames.join(", ")} } = ${SCOPE_PARAM};` : "";

  // Create sync-back statements for mutable variables
  // This ensures reassignments like `x = 2` persist to scope
  const syncBack =
    mutableNames.length > 0
      ? mutableNames.map((n) => `${SCOPE_PARAM}.${n} = ${n};`).join(" ")
      : "";

  // Helper aliases (always provided)
  // Note: exports parameter is passed directly and used by transformed code
  const helperAliases = `
const console = ${CONSOLE_PARAM};
const importModule = ${IMPORT_MODULE_PARAM};
const importOPFS = ${IMPORT_OPFS_PARAM};
const __signal = ${SIGNAL_PARAM};
const checkAbort = ${CHECK_ABORT_PARAM};`.trim();

  // The code is wrapped to:
  // 1. Provide console, importModule, importOPFS, signal, exports helpers
  // 2. Destructure existing scope variables (let for mutable, const for immutable)
  // 3. Execute the transformed code
  // 4. Sync mutable variables back to scope (in finally to handle errors)
  if (syncBack) {
    return `
${helperAliases}
${constDestructure}
${mutableDestructure}

try {
${code}
} finally {
  ${syncBack}
}
`;
  }

  return `
${helperAliases}
${constDestructure}
${mutableDestructure}

${code}
`;
}

/**
 * Check if a string is a valid JavaScript identifier.
 *
 * @param name - The string to check
 * @returns True if the string is a valid identifier
 */
export function isValidIdentifier(name: string): boolean {
  if (!name || name.length === 0) return false;

  // Check cache first
  const cached = identifierCache.get(name);
  if (cached !== undefined) return cached;

  // Quick check for reserved words and basic validity
  try {
    // This will throw if the name is not a valid identifier
    new Function(`let ${name}`);
    identifierCache.set(name, true);
    return true;
  } catch {
    identifierCache.set(name, false);
    return false;
  }
}

/**
 * Clear the identifier cache. Useful for testing or memory cleanup.
 */
export function clearIdentifierCache(): void {
  identifierCache.clear();
}
