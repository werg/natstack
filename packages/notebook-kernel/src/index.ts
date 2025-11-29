/**
 * @natstack/notebook-kernel
 *
 * A JS-based notebook kernel for executing cells in a persistent closure.
 *
 * Features:
 * - Step-by-step cell execution with persistent scope
 * - Dynamic imports from CDN (npm packages)
 * - Dynamic imports from OPFS with transitive resolution
 * - Console output capture
 * - Binding injection
 * - TypeScript/JSX support via esbuild-wasm
 * - Execution timeout and abort support
 *
 * Important Notes:
 * - esbuild-wasm instance is shared globally across all kernels and loaders
 *   to prevent "already initialized" errors. This means all kernels share
 *   the same esbuild configuration (the first one to initialize wins).
 */

// Main kernel
export {
  NotebookKernel,
  AbortError,
  TimeoutError,
  TransformAbortError,
  type KernelOptions,
  type ExecutionOptions,
} from "./kernel.js";

// Executor (for advanced usage)
export { executeCell, type ExecuteOptions } from "./executor.js";

// OPFS loader (for advanced usage)
export { OPFSModuleLoader, createOPFSImporter } from "./opfs-loader.js";
export type { OPFSModuleLoaderOptions } from "./opfs-loader.js";

// Console capture (for advanced usage)
export { createConsoleCapture } from "./console-capture.js";
export type { ConsoleCaptureOptions } from "./console-capture.js";

// Cell transformer (for advanced usage)
export { transformCell } from "./transformer.js";

// TypeScript/JSX cell transform (for advanced usage)
export {
  transformCellCode,
  isCellTransformAvailable,
  initializeCellTransform,
  type CellTransformOptions,
  type CellTransformResult,
} from "./cell-transform.js";

// Shared esbuild initialization (for advanced usage)
export {
  getEsbuild,
  isEsbuildAvailable,
  getEsbuildSync,
  type EsbuildInitOptions,
} from "./esbuild-init.js";

// Import helpers (for advanced usage)
export {
  importModule,
  createImportModule,
  isBareSpecifier,
  resolveSpecifier,
  DEFAULT_CDN,
} from "./imports.js";
export type { ImportModuleOptions } from "./imports.js";

// Types
export type {
  ConsoleEntry,
  CellResult,
  NotebookSession,
  SessionOptions,
  ExecutionHelpers,
  ConsoleCapture,
  TransformResult,
} from "./types.js";

import { NotebookKernel, type KernelOptions } from "./kernel.js";

/**
 * Create a new notebook kernel with default options.
 */
export function createKernel(options?: KernelOptions): NotebookKernel {
  return new NotebookKernel(options);
}
