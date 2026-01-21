/**
 * Shared utilities for pubsub RPC tools.
 */

import * as path from "path";

/**
 * Resolve a path to an absolute path within the workspace.
 * Throws if the resolved path escapes the workspace root.
 */
export function resolvePath(targetPath: string, workspaceRoot?: string): string {
  const root = workspaceRoot ?? process.cwd();
  const absoluteRoot = path.resolve(root);

  // Resolve the target path relative to workspace root
  const resolved = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(absoluteRoot, targetPath);

  // Normalize to handle .. traversal
  const normalized = path.normalize(resolved);

  // Ensure the path is within workspace root
  if (!normalized.startsWith(absoluteRoot + path.sep) && normalized !== absoluteRoot) {
    throw new Error(`Path escapes workspace: ${targetPath}`);
  }

  return normalized;
}
