/**
 * Shared path safety utilities for services that accept user-provided paths.
 *
 * All services accepting relative paths MUST validate them against directory
 * traversal using `resolveWithinContext()`.
 */

import * as path from "path";

/**
 * Resolve a relative path within a context root, preventing directory traversal.
 *
 * @throws Error if the resolved path escapes the context root.
 */
export function resolveWithinContext(contextRoot: string, relativePath: string): string {
  const resolved = path.resolve(contextRoot, relativePath);
  if (!resolved.startsWith(contextRoot + path.sep) && resolved !== contextRoot) {
    throw new Error(`Path escapes context root: ${relativePath}`);
  }
  return resolved;
}

/**
 * Validate that a file path stays within a given root directory.
 *
 * @throws Error if the resolved file path escapes the root.
 */
export function validateFilePathWithinRoot(rootPath: string, filePath: string): void {
  const resolved = path.resolve(rootPath, filePath);
  if (!resolved.startsWith(rootPath + path.sep) && resolved !== rootPath) {
    throw new Error(`file_path escapes panel root: ${filePath}`);
  }
}
