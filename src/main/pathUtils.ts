import * as path from "path";

/**
 * Normalizes a panel path to ensure it's relative and doesn't escape the workspace.
 * Returns the normalized relative path.
 *
 * @param panelPath - The path to normalize (must be relative)
 * @param workspaceRoot - The workspace root directory
 * @throws Error if path is absolute, empty, or escapes workspace
 */
export function normalizeRelativePanelPath(
  panelPath: string,
  workspaceRoot: string
): { relativePath: string; absolutePath: string } {
  if (path.isAbsolute(panelPath)) {
    throw new Error("Panel path must be relative to the workspace root");
  }

  const normalized = path
    .normalize(panelPath)
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");

  if (!normalized || normalized === "." || normalized.startsWith("..")) {
    throw new Error(`Invalid panel path (must stay within workspace): ${panelPath}`);
  }

  const absolutePath = path.join(workspaceRoot, normalized);
  const relativeToRoot = path.relative(workspaceRoot, absolutePath);
  if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
    throw new Error(`Panel path escapes workspace root: ${panelPath}`);
  }

  return { relativePath: normalized, absolutePath };
}

/**
 * Validates and normalizes a relative panel path without computing absolute path.
 * Useful when workspace root is not yet known or not needed.
 */
export function validateRelativePath(panelPath: string): string {
  if (path.isAbsolute(panelPath)) {
    throw new Error("Panel path must be relative");
  }

  const normalized = path
    .normalize(panelPath)
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");

  if (!normalized || normalized === "." || normalized.startsWith("..")) {
    throw new Error(`Invalid panel path: ${panelPath}`);
  }

  return normalized;
}
