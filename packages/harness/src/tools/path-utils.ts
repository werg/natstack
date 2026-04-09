/**
 * Path resolution helpers used by every file tool.
 *
 * Ported from pi-coding-agent's `dist/core/tools/path-utils.js`. Pure logic
 * (no fs / os calls); the macOS-screenshot fallbacks that depended on
 * `accessSync` are gone — workerd has no synchronous fs and the per-context
 * filesystems we operate on don't host macOS screenshots, so the simple
 * `resolveToCwd` path is sufficient. `resolveReadPath` is kept as an alias
 * so the read tool can keep its existing call site.
 */

import { isAbsolute, resolve as resolvePath } from "node:path";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

function normalizeUnicodeSpaces(str: string): string {
  return str.replace(UNICODE_SPACES, " ");
}

function normalizeAtPrefix(filePath: string): string {
  return filePath.startsWith("@") ? filePath.slice(1) : filePath;
}

/**
 * Expand `~` and `~/` to a synthetic home directory and normalise unicode
 * whitespace. workerd has no `os.homedir()`, so we treat `~` as a marker
 * that callers can later remap if they need a literal home; for the
 * per-context fs the contextFolderPath is already absolute.
 */
export function expandPath(filePath: string): string {
  const normalized = normalizeUnicodeSpaces(normalizeAtPrefix(filePath));
  // Workerd has no os.homedir(); leave ~ alone — callers using per-context
  // sandbox roots never produce these paths anyway.
  return normalized;
}

/**
 * Resolve `filePath` relative to `cwd`. If already absolute (after `~`
 * expansion), returns it unchanged.
 */
export function resolveToCwd(filePath: string, cwd: string): string {
  const expanded = expandPath(filePath);
  if (isAbsolute(expanded)) {
    return expanded;
  }
  return resolvePath(cwd, expanded);
}

/**
 * Resolve a path for the read tool. Identical to `resolveToCwd` in the
 * workerd port — the upstream macOS variants depended on `accessSync`,
 * which we don't have.
 */
export function resolveReadPath(filePath: string, cwd: string): string {
  return resolveToCwd(filePath, cwd);
}
