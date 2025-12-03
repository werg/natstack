/**
 * Code Evaluation
 *
 * Builds and evaluates JS/TS code, returning console output and bindings.
 * This is a stateless evaluator - each call is independent.
 */

import {
  getEsbuild,
  transform,
  getLoaderForLanguage,
  BuildError,
  createOPFSPlugin,
} from "@natstack/build";
import { createConsoleCapture } from "./console-capture.js";
import { typeCheckOrThrow, isTypeScriptAvailable } from "./type-check.js";
import type { EvalOptions, EvalResult } from "./types.js";

// Get the AsyncFunction constructor
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<unknown>;

/** Error thrown when execution is aborted */
export class AbortError extends Error {
  constructor(message = "Execution aborted") {
    super(message);
    this.name = "AbortError";
  }
}

/** Error thrown when evaluation fails at runtime */
export class EvalError extends Error {
  constructor(message: string, public readonly cause?: Error) {
    super(message);
    this.name = "EvalError";
  }
}

/**
 * Build and evaluate JS/TS code.
 *
 * @param code - The source code to evaluate
 * @param options - Evaluation options
 * @returns Console output, bindings, and return value
 * @throws BuildError on compilation failure
 * @throws EvalError on runtime error
 */
export async function evaluate(
  code: string,
  options: EvalOptions = { language: "typescript" }
): Promise<EvalResult> {
  const { language, bindings = {}, typeCheck = false, signal } = options;

  // Check if already aborted
  if (signal?.aborted) {
    throw new AbortError();
  }

  // Optional type checking
  if (typeCheck) {
    await typeCheckOrThrow(code, { language, signal });
  }

  // Transform TS/TSX to JS if needed
  let transformedCode = code;
  if (language === "typescript") {
    const loader = getLoaderForLanguage(language, true); // Always support JSX
    const result = await transform(code, {
      loader,
      sourceMaps: true,
      sourcefile: "input",
      signal,
    });
    transformedCode = result.code;
  }

  // Check abort after transform
  if (signal?.aborted) {
    throw new AbortError();
  }

  // Bundle with esbuild to resolve imports
  const esbuild = await getEsbuild();

  // Check abort after getting esbuild
  if (signal?.aborted) {
    throw new AbortError();
  }

  // Create OPFS plugin for import resolution
  const opfsPlugin = await createOPFSPlugin();

  // Check abort after creating plugin
  if (signal?.aborted) {
    throw new AbortError();
  }

  // Bundle the code to resolve any imports from OPFS
  const bundleResult = await esbuild.build({
    stdin: {
      contents: transformedCode,
      loader: "js",
      resolveDir: "/",
      sourcefile: "input.js",
    },
    bundle: true,
    format: "esm",
    write: false,
    platform: "browser",
    target: "es2022",
    plugins: [opfsPlugin],
  });

  if (bundleResult.errors.length > 0) {
    const errorMsg = bundleResult.errors
      .map((e) => `${e.location?.file || "input"}:${e.location?.line || 0}: ${e.text}`)
      .join("\n");
    throw new BuildError(`Build failed:\n${errorMsg}`);
  }

  const bundledCode = bundleResult.outputFiles?.[0]?.text;
  if (!bundledCode) {
    throw new BuildError("No output from esbuild");
  }

  // Check abort after bundle
  if (signal?.aborted) {
    throw new AbortError();
  }

  // Set up console capture
  const consoleCapture = createConsoleCapture({ forward: false });

  // Create execution context with bindings
  const scope: Record<string, unknown> = { ...bindings };
  const exportedBindings: Record<string, unknown> = {};

  // Wrap code to capture exports and provide console
  const wrappedCode = wrapCodeForExecution(bundledCode, Object.keys(bindings));

  try {
    // Create and execute the async function
    const fn = new AsyncFunction(
      "__scope__",
      "__console__",
      "__exports__",
      wrappedCode
    );

    const returnValue = await fn(scope, consoleCapture.proxy, exportedBindings);

    return {
      console: consoleCapture.getOutput(),
      bindings: exportedBindings,
      returnValue,
    };
  } catch (error) {
    // Still return console output on error
    const consoleOutput = consoleCapture.getOutput();

    if (error instanceof AbortError) {
      throw error;
    }

    const evalError = new EvalError(
      error instanceof Error ? error.message : String(error),
      error instanceof Error ? error : undefined
    );

    // Attach console output to error for debugging
    (evalError as EvalError & { console?: typeof consoleOutput }).console = consoleOutput;

    throw evalError;
  }
}

/**
 * Wrap bundled code for execution with proper scope and export capture.
 */
function wrapCodeForExecution(
  code: string,
  bindingNames: string[]
): string {
  // Destructure injected bindings
  const bindingDestructure =
    bindingNames.length > 0
      ? `const { ${bindingNames.join(", ")} } = __scope__;`
      : "";

  // The bundled code is ESM format, so we need to handle it specially
  // We'll execute it and capture any top-level assignments
  return `
const console = __console__;
${bindingDestructure}

// Execute the bundled code
${code}

// Note: ESM exports are handled by esbuild's bundle output
// The last expression value is returned automatically
`;
}

/**
 * Initialize the evaluation environment.
 * Call this early to pre-warm esbuild initialization.
 */
export async function initializeEval(): Promise<void> {
  await getEsbuild();
}
