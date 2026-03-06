/**
 * Context-scoping middleware.
 *
 * Provides a reusable pattern for services that operate within a context folder:
 * resolve contextId → ensureContextFolder → validate paths within root.
 */

import type { ContextFolderManager } from "../contextFolderManager.js";
import { resolveWithinContext, validateFilePathWithinRoot } from "./contextPaths.js";

export interface ContextScope {
  /** Absolute path to the context root folder */
  contextRoot: string;
  /** Resolve a relative path within the context root (throws on traversal) */
  resolvePath(relativePath: string): string;
  /** Validate that a file path stays within the context root (throws on traversal) */
  validatePath(filePath: string): void;
}

/**
 * Resolve a context scope from a contextId.
 * Ensures the context folder exists and returns path utilities scoped to it.
 */
export async function resolveContextScope(
  contextFolderManager: ContextFolderManager,
  contextId: string,
): Promise<ContextScope> {
  const contextRoot = await contextFolderManager.ensureContextFolder(contextId);
  return {
    contextRoot,
    resolvePath: (rel) => resolveWithinContext(contextRoot, rel),
    validatePath: (fp) => validateFilePathWithinRoot(contextRoot, fp),
  };
}
