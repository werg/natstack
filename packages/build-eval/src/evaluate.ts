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
  createFsPlugin,
  executeEsm,
  getExportReturnValue,
} from "@natstack/build";
import { createConsoleCapture } from "./console-capture.js";
import { typeCheckOrThrow } from "./type-check.js";
import type { EvalOptions, EvalResult } from "./types.js";

/** Error thrown when execution is aborted */
export class AbortError extends Error {
  constructor(message = "Execution aborted") {
    super(message);
    this.name = "AbortError";
  }
}

/** Error thrown when evaluation fails at runtime */
export class EvalError extends Error {
  constructor(
    message: string,
    public readonly cause?: Error
  ) {
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
  const {
    language,
    bindings = {},
    typeCheck = false,
    signal,
    importModule,
  } = options;

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

  // Create filesystem plugin for import resolution
  const fsPlugin = createFsPlugin();

  // Check abort after creating plugin
  if (signal?.aborted) {
    throw new AbortError();
  }

  // Bundle the code to resolve any imports from OPFS
  // Use ESM format to support top-level await
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
    plugins: [fsPlugin],
  });

  if (bundleResult.errors.length > 0) {
    const errorMsg = bundleResult.errors
      .map(
        (e) => `${e.location?.file || "input"}:${e.location?.line || 0}: ${e.text}`
      )
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

  try {
    // Execute the bundled ESM code
    const result = await executeEsm(bundledCode, {
      importModule,
      scope: bindings,
      params: {
        __console__: consoleCapture.proxy,
      },
      preamble: "const console = __console__;",
      epilogue: `
// Return default export if present, otherwise the whole exports object
return ${getExportReturnValueCode()};
`,
    });

    return {
      console: consoleCapture.getOutput(),
      bindings: result.exports,
      returnValue: result.returnValue,
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
    (evalError as EvalError & { console?: typeof consoleOutput }).console =
      consoleOutput;

    throw evalError;
  }
}

/**
 * Generate code to extract the return value from exports.
 * Uses "default" in __exports__ to distinguish between
 * `export default undefined` and no default export.
 */
function getExportReturnValueCode(): string {
  return `("default" in __exports__) ? __exports__.default : (Object.keys(__exports__).length > 0 ? __exports__ : undefined)`;
}

/**
 * Initialize the evaluation environment.
 * Call this early to pre-warm esbuild initialization.
 */
export async function initializeEval(): Promise<void> {
  await getEsbuild();
}
