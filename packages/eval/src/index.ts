// Transform TS/TSX/JSX to CommonJS
export { transformCode } from "./transform.js";
export type { TransformOptions, TransformResult } from "./transform.js";

// Execute transformed code
export { execute, executeDefault, validateRequires, getDefaultRequire } from "./execute.js";
export type { ExecuteOptions, ExecuteResult, ValidateRequiresResult } from "./execute.js";

// Console capture for streaming
export {
  createConsoleCapture,
  formatConsoleEntry,
  formatConsoleOutput,
} from "./consoleCapture.js";
export type { ConsoleCapture, ConsoleEntry } from "./consoleCapture.js";

// Async tracking (unified API for panels and workers)
export {
  getAsyncTracking,
  hasAsyncTracking,
  getAsyncTrackingOrFallback,
  createFallbackAsyncTracking,
} from "./asyncTracking.js";
export type {
  TrackingContext,
  TrackingContextOptions,
  AsyncTrackingAPI,
} from "./asyncTracking.js";
