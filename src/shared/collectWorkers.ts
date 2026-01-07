/**
 * Utility for collecting worker declarations from package dependencies.
 * Re-exports from collectWorkers.mjs for TypeScript consumers.
 */

// @ts-expect-error - Importing .mjs file which TypeScript allows but warns about
import { collectWorkersFromDependencies as collect, workersToArray as toArray } from "./collectWorkers.mjs";

/**
 * Information about a collected worker declaration.
 */
export interface CollectedWorker {
  /** The module specifier to bundle (e.g., "monaco-editor/esm/vs/editor/editor.worker.js") */
  specifier: string;
  /** The package name that declared this worker */
  declaredBy: string;
}

/**
 * Map of output path (e.g., "monaco/editor.worker.js") to worker info.
 */
export type CollectedWorkers = Record<string, CollectedWorker>;

export interface CollectWorkersOptions {
  /** Optional logger for warnings (e.g., worker conflicts) */
  log?: (msg: string) => void;
}

/**
 * Collect all worker declarations from a node_modules directory.
 *
 * Scans all installed packages (including scoped packages) for
 * natstack.workers declarations in their package.json files.
 *
 * @example
 * ```ts
 * const workers = collectWorkersFromDependencies('./node_modules');
 * // workers = {
 * //   "monaco/editor.worker.js": {
 * //     specifier: "monaco-editor/esm/vs/editor/editor.worker.js",
 * //     declaredBy: "@natstack/git-ui"
 * //   }
 * // }
 * ```
 */
export const collectWorkersFromDependencies: (
  nodeModulesDir: string,
  options?: CollectWorkersOptions
) => CollectedWorkers = collect;

/**
 * Worker entry in array format, for easy iteration.
 */
export interface WorkerEntry {
  /** Output path (e.g., "monaco/editor.worker.js") */
  name: string;
  /** Module specifier to bundle */
  specifier: string;
  /** Package that declared this worker */
  declaredBy: string;
}

/**
 * Convert collected workers to a simple array format for iteration.
 */
export const workersToArray: (workers: CollectedWorkers) => WorkerEntry[] = toArray;
