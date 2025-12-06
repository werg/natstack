/**
 * @natstack/build-eval
 *
 * Build and evaluate JS/TS code, returning console output and bindings.
 */

export {
  evaluate,
  initializeEval,
  AbortError,
  EvalError,
} from "./evaluate.js";

export { createConsoleCapture, type ConsoleCaptureOptions } from "./console-capture.js";

export {
  typeCheck,
  typeCheckOrThrow,
  isTypeScriptAvailable,
} from "./type-check.js";

export type {
  EvalOptions,
  EvalResult,
  EvalContext,
  ConsoleEntry,
  ConsoleCapture,
  TypeCheckOptions,
  TypeCheckResult,
  TypeCheckError,
} from "./types.js";

// Re-export BuildError from @natstack/build for convenience
export { BuildError } from "@natstack/build";
