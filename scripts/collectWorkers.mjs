/**
 * Utility for collecting worker declarations from package dependencies.
 *
 * Packages can declare workers they need in their package.json:
 * ```json
 * {
 *   "natstack": {
 *     "workers": {
 *       "monaco/editor.worker.js": "monaco-editor/esm/vs/editor/editor.worker.js"
 *     }
 *   }
 * }
 * ```
 *
 * Build systems scan dependencies and bundle all declared workers.
 */

import * as fs from "fs";
import * as path from "path";

/**
 * @typedef {Object} CollectedWorker
 * @property {string} specifier - The module specifier to bundle (e.g., "monaco-editor/esm/vs/editor/editor.worker.js")
 * @property {string} declaredBy - The package name that declared this worker
 */

/**
 * @typedef {Object.<string, CollectedWorker>} CollectedWorkers
 * Maps output path (e.g., "monaco/editor.worker.js") to worker info
 */

/**
 * Collect worker declarations from a single package.
 *
 * @param {string} pkgDir - Path to the package directory
 * @param {CollectedWorkers} workers - Map to collect workers into
 * @param {(msg: string) => void} [log] - Optional logger
 */
function collectFromPackage(pkgDir, workers, log) {
  const pkgJsonPath = path.join(pkgDir, "package.json");
  if (!fs.existsSync(pkgJsonPath)) return;

  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
  } catch {
    return; // Skip malformed package.json
  }

  const natstackWorkers = pkg.natstack?.workers;

  if (natstackWorkers && typeof natstackWorkers === "object") {
    for (const [outputPath, specifier] of Object.entries(natstackWorkers)) {
      if (typeof specifier !== "string") continue;

      if (workers[outputPath] && workers[outputPath].specifier !== specifier) {
        log?.(
          `Warning: Worker conflict for "${outputPath}" - ` +
            `declared by both ${workers[outputPath].declaredBy} and ${pkg.name}`
        );
      }
      workers[outputPath] = { specifier, declaredBy: pkg.name };
    }
  }
}

/**
 * Recursively scan a node_modules directory for packages with worker declarations.
 *
 * @param {string} nodeModulesDir - Path to node_modules directory
 * @param {CollectedWorkers} workers - Map to collect workers into
 * @param {Set<string>} visited - Set of already-visited directories (to handle symlinks)
 * @param {(msg: string) => void} [log] - Optional logger
 */
function scanNodeModules(nodeModulesDir, workers, visited, log) {
  // Resolve symlinks to get the real path for cycle detection
  let realPath;
  try {
    realPath = fs.realpathSync(nodeModulesDir);
  } catch {
    return; // Can't resolve path, skip
  }

  if (visited.has(realPath)) {
    return; // Already scanned this directory
  }
  visited.add(realPath);

  if (!fs.existsSync(nodeModulesDir)) {
    return;
  }

  let entries;
  try {
    entries = fs.readdirSync(nodeModulesDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    // Skip hidden directories
    if (entry.name.startsWith(".")) continue;

    const entryPath = path.join(nodeModulesDir, entry.name);

    if (entry.name.startsWith("@")) {
      // Scoped package directory - scan packages inside
      let scopedEntries;
      try {
        scopedEntries = fs.readdirSync(entryPath, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const scopedEntry of scopedEntries) {
        if (!scopedEntry.isDirectory()) continue;
        const scopedPkgPath = path.join(entryPath, scopedEntry.name);
        collectFromPackage(scopedPkgPath, workers, log);

        // Recursively scan nested node_modules
        const nestedNodeModules = path.join(scopedPkgPath, "node_modules");
        scanNodeModules(nestedNodeModules, workers, visited, log);
      }
    } else {
      // Regular package
      collectFromPackage(entryPath, workers, log);

      // Recursively scan nested node_modules
      const nestedNodeModules = path.join(entryPath, "node_modules");
      scanNodeModules(nestedNodeModules, workers, visited, log);
    }
  }
}

/**
 * Collect all worker declarations from a node_modules directory.
 *
 * Scans all installed packages (including scoped packages and nested
 * node_modules for transitive dependencies) for natstack.workers
 * declarations in their package.json files.
 *
 * @param {string} nodeModulesDir - Path to node_modules directory
 * @param {Object} [options]
 * @param {(msg: string) => void} [options.log] - Optional logger for warnings
 * @returns {CollectedWorkers} Map of output path -> worker info
 */
export function collectWorkersFromDependencies(nodeModulesDir, options = {}) {
  const { log } = options;
  /** @type {CollectedWorkers} */
  const workers = {};
  /** @type {Set<string>} */
  const visited = new Set();

  scanNodeModules(nodeModulesDir, workers, visited, log);

  return workers;
}

/**
 * Convert collected workers to a simple array format for iteration.
 *
 * @param {CollectedWorkers} workers - Collected workers map
 * @returns {Array<{name: string, specifier: string, declaredBy: string}>}
 */
export function workersToArray(workers) {
  return Object.entries(workers).map(([name, { specifier, declaredBy }]) => ({
    name,
    specifier,
    declaredBy,
  }));
}
