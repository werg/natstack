/**
 * Shared filesystem utilities for panels and workers.
 */

import type { FileStats } from "../types.js";

/**
 * Convert any stat-like object to our FileStats interface.
 * Captures boolean values at creation time so they can be returned as methods.
 * Preserves `mode` for isomorphic-git compatibility.
 */
export function toFileStats(stats: unknown): FileStats {
  const s = stats as Record<string, unknown> | null | undefined;
  const isFileFn = s?.["isFile"];
  const isDirFn = s?.["isDirectory"];
  // Call methods with proper `this` binding - some fs implementations need their context
  const isFileBool = typeof isFileFn === "function" ? (isFileFn as () => boolean).call(s) : !!isFileFn;
  const isDirBool = typeof isDirFn === "function" ? (isDirFn as () => boolean).call(s) : !!isDirFn;
  const sizeVal = s?.["size"];
  const mtimeVal = s?.["mtime"];
  const ctimeVal = s?.["ctime"];
  const modeVal = s?.["mode"];

  // Default mode: 0o100644 for files, 0o40755 for directories
  // These include the file type bits that isomorphic-git expects
  const defaultMode = isDirBool ? 0o40755 : 0o100644;

  return {
    isFile: () => isFileBool,
    isDirectory: () => isDirBool,
    size: typeof sizeVal === "number" ? sizeVal : 0,
    mtime: mtimeVal instanceof Date ? mtimeVal.toISOString() : String(mtimeVal ?? ""),
    ctime: ctimeVal instanceof Date ? ctimeVal.toISOString() : String(ctimeVal ?? ""),
    mode: typeof modeVal === "number" ? modeVal : defaultMode,
  };
}
