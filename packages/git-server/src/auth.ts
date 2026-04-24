/**
 * Git authentication and authorization.
 *
 * GitAuthManager wraps a TokenManager to enforce per-panel push access
 * based on repo path ownership rules.
 */

import type { TokenManagerLike } from "./types.js";

/**
 * Allowed characters in repo path segments. Repo paths arrive from HTTP URL
 * paths and are also used in lookup / push routing — reject anything that
 * could be parsed as a git CLI flag (`-…`) or break out of the repo dir
 * (`..`, `\0`, control chars).
 */
const SAFE_REPO_PATH_RE = /^[A-Za-z0-9._/@-]+$/;

function normalizeRepoPath(repoPath: string): string {
  const normalized = repoPath
    .replace(/^\/+/, "")
    .replace(/\.git(\/.*)?$/, "")
    .replace(/\/+$/, "");
  // Defense-in-depth: reject obviously malformed paths before they hit
  // any spawn() call downstream. The CLI never sees this string directly,
  // but `tree/<panelId>…` and `singleton/<panelId>…` flow into other
  // git invocations elsewhere.
  if (normalized.length > 0) {
    const segments = normalized.split("/");
    for (const seg of segments) {
      if (seg === "" || seg === "." || seg === ".." || seg.startsWith("-")) {
        throw new Error(`Invalid repo path segment: ${seg}`);
      }
      if (!SAFE_REPO_PATH_RE.test(seg)) {
        throw new Error(`Invalid repo path: ${repoPath}`);
      }
    }
  }
  return normalized;
}

/**
 * Git auth manager — controls which panels can push to which repos.
 *
 * Rules:
 * - Fetch (read) is always allowed for authenticated panels
 * - Write (push) to tree/<path> or singleton/<path>: panel ID must match or be a prefix
 */
export class GitAuthManager {
  constructor(private tokenManager: TokenManagerLike) {}

  getToken(panelId: string): string {
    return this.tokenManager.getToken(panelId);
  }

  revokeToken(panelId: string): boolean {
    return this.tokenManager.revokeToken(panelId);
  }

  canAccess(
    panelId: string,
    repoPath: string,
    operation: "fetch" | "push"
  ): { allowed: boolean; reason?: string } {
    let normalizedPath: string;
    try {
      normalizedPath = normalizeRepoPath(repoPath);
    } catch (err) {
      return { allowed: false, reason: err instanceof Error ? err.message : "Invalid repo path" };
    }

    if (operation === "fetch") {
      return { allowed: true };
    }

    const isTreePath = normalizedPath.startsWith("tree/");
    const isSingletonPath = normalizedPath.startsWith("singleton/");

    if (!isTreePath && !isSingletonPath) {
      return { allowed: true };
    }

    if (normalizedPath === panelId || normalizedPath.startsWith(panelId + "/")) {
      return { allowed: true };
    }

    return {
      allowed: false,
      reason: `Panel "${panelId}" cannot push to protected repo "${normalizedPath}"`,
    };
  }

  validateAccess(
    token: string,
    repoPath: string,
    operation: "fetch" | "push"
  ): { valid: boolean; reason?: string } {
    const entry = this.tokenManager.validateToken(token);
    const panelId = entry?.callerId ?? null;
    if (!panelId) {
      return { valid: false, reason: "Invalid token" };
    }

    const accessResult = this.canAccess(panelId, repoPath, operation);
    if (!accessResult.allowed) {
      return { valid: false, reason: accessResult.reason };
    }

    return { valid: true };
  }
}
