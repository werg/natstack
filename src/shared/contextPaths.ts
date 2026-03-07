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

/**
 * Validate a project name — rejects path separators and traversal patterns.
 *
 * @throws Error if the name contains invalid characters.
 */
export function validateProjectName(name: string): void {
  if (!name || name === "." || name === "..") {
    throw new Error(`Invalid project name: ${name}`);
  }
  if (/[/\\]/.test(name)) {
    throw new Error(`Project name must not contain path separators: ${name}`);
  }
  if (name.includes("..")) {
    throw new Error(`Project name must not contain '..': ${name}`);
  }
  // Must be a valid npm package name segment and produce a valid PascalCase identifier.
  // Lowercase alphanumeric, hyphens, underscores; must start with a letter.
  if (!/^[a-z][a-z0-9_-]*$/.test(name)) {
    throw new Error(
      `Project name must start with a lowercase letter and contain only lowercase letters, digits, hyphens, or underscores: ${name}`,
    );
  }
}
