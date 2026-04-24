import { randomBytes, timingSafeEqual } from "crypto";
import type { CallerKind } from "./serviceDispatcher.js";

/**
 * Constant-time string comparison.
 *
 * Compare two strings without leaking length-or-value information through
 * timing side-channels. Uses Node's `crypto.timingSafeEqual` once the inputs
 * have been encoded to equal-length buffers. A length mismatch returns false
 * directly — `timingSafeEqual` itself throws on length mismatch, and the
 * length of an admin token is not itself a secret in this codebase (all
 * admin tokens are 64-char hex), so the early-out does not leak.
 *
 * Use this for every admin-token / management-token / bearer-token compare
 * where the right-hand operand is server-side state. Plain `===` /
 * `!==` is forbidden for such compares (audit finding #33).
 */
export function constantTimeStringEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Global token manager for panel/worker/shell authentication.
 * Provides unified token management for all services (Git, CDP, etc.)
 *
 * Each caller ID gets one token. Services can use this manager
 * to authenticate requests from panels/workers/shell.
 */
export class TokenManager {
  // token -> { callerId, callerKind }
  private tokenToEntry = new Map<
    string,
    { callerId: string; callerKind: CallerKind }
  >();
  // callerId -> token
  private callerIdToToken = new Map<string, string>();
  // panelId -> parent panel id (null for roots)
  private panelParentIds = new Map<string, string | null>();
  // revocation listeners
  private revokeListeners: ((callerId: string) => void)[] = [];
  // admin token for privileged operations
  private adminToken: string | null = null;

  /**
   * Create a new token for a caller. Throws if a token already exists for this callerId.
   */
  createToken(callerId: string, callerKind: CallerKind): string {
    if (this.callerIdToToken.has(callerId)) {
      throw new Error(`Token already exists for caller "${callerId}"`);
    }

    const token = randomBytes(32).toString("hex");
    this.tokenToEntry.set(token, { callerId, callerKind });
    this.callerIdToToken.set(callerId, token);
    return token;
  }

  /**
   * Ensure a token exists for a caller. If one already exists, return it.
   * If not, create a new one. Used by rebuild/restore paths where the token
   * may or may not have been revoked.
   */
  ensureToken(callerId: string, callerKind: CallerKind): string {
    const existing = this.callerIdToToken.get(callerId);
    if (existing) return existing;
    return this.createToken(callerId, callerKind);
  }

  /**
   * Get the existing token for a caller. Throws if no token exists.
   */
  getToken(callerId: string): string {
    const token = this.callerIdToToken.get(callerId);
    if (!token) {
      throw new Error(`No token exists for caller "${callerId}"`);
    }
    return token;
  }

  /**
   * Validate a bearer token.
   * Returns the entry { callerId, callerKind } if valid, null otherwise.
   */
  validateToken(
    token: string
  ): { callerId: string; callerKind: CallerKind } | null {
    return this.tokenToEntry.get(token) ?? null;
  }

  /**
   * Convenience: get the caller ID (panel ID) associated with a token.
   */
  getPanelIdFromToken(token: string): string | null {
    const entry = this.tokenToEntry.get(token);
    return entry?.callerId ?? null;
  }

  /**
   * Revoke token for a caller (e.g., when panel is closed).
   * Notifies all revocation listeners.
   */
  revokeToken(callerId: string): boolean {
    const token = this.callerIdToToken.get(callerId);
    if (!token) return false;

    this.callerIdToToken.delete(callerId);
    this.tokenToEntry.delete(token);
    this.panelParentIds.delete(callerId);

    for (const listener of this.revokeListeners) {
      listener(callerId);
    }

    return true;
  }

  /**
   * Register a listener that is called when a token is revoked.
   */
  onRevoke(listener: (callerId: string) => void): void {
    this.revokeListeners.push(listener);
  }

  /**
   * Clear all tokens and notify listeners for each.
   */
  clear(): void {
    const callerIds = [...this.callerIdToToken.keys()];
    this.tokenToEntry.clear();
    this.callerIdToToken.clear();
    this.panelParentIds.clear();

    for (const callerId of callerIds) {
      for (const listener of this.revokeListeners) {
        listener(callerId);
      }
    }
  }

  /**
   * Set the admin token for privileged operations.
   */
  setAdminToken(token: string): void {
    this.adminToken = token;
  }

  /**
   * Validate an admin token.
   *
   * Default-deny when no admin token is configured (audit finding #25):
   * we used to return false here too, but only when `token` was set; now we
   * also reject empty/missing presented tokens explicitly.
   *
   * Comparison is constant-time (audit finding #33).
   */
  validateAdminToken(token: string): boolean {
    if (this.adminToken === null) return false;
    if (typeof token !== "string" || token.length === 0) return false;
    return constantTimeStringEqual(token, this.adminToken);
  }

  setPanelParent(panelId: string, parentId: string | null): void {
    this.panelParentIds.set(panelId, parentId);
  }

  getPanelParent(panelId: string): string | null | undefined {
    return this.panelParentIds.get(panelId);
  }

  isPanelDescendantOf(panelId: string, ancestorId: string): boolean {
    let current = this.panelParentIds.get(panelId);
    const visited = new Set<string>();
    while (current) {
      if (current === ancestorId) return true;
      if (visited.has(current)) return false;
      visited.add(current);
      current = this.panelParentIds.get(current) ?? null;
    }
    return false;
  }

}

// =============================================================================
// Git-specific authentication (extends base token validation)
// =============================================================================

/**
 * Normalizes a git repo path by removing leading slashes and .git suffixes.
 */
function normalizeRepoPath(repoPath: string): string {
  return repoPath
    .replace(/^\/+/, "")
    .replace(/\.git(\/.*)?$/, "")
    .replace(/\/+$/, "");
}

/**
 * Git-specific authentication manager.
 * Wraps TokenManager with git repo access control rules.
 *
 * Access rules:
 * - Read (fetch): All authenticated panels can read any repo
 * - Write (push) to repos NOT under tree/ or singleton/: allowed for anyone
 * - Write (push) to tree/<path> or singleton/<path>: panel ID must match or be a prefix
 */
export class GitAuthManager {
  constructor(private tokenManager: TokenManager) {}

  /**
   * Get the token for a panel.
   */
  getToken(panelId: string): string {
    return this.tokenManager.getToken(panelId);
  }

  /**
   * Revoke a panel's token.
   */
  revokeToken(panelId: string): boolean {
    return this.tokenManager.revokeToken(panelId);
  }

  /**
   * Check if a panel can access a repo path for a given operation.
   */
  canAccess(
    panelId: string,
    repoPath: string,
    operation: "fetch" | "push"
  ): { allowed: boolean; reason?: string } {
    const normalizedPath = normalizeRepoPath(repoPath);

    // Fetch (read) is always allowed for authenticated panels
    if (operation === "fetch") {
      return { allowed: true };
    }

    // For push operations, check if repo is under a protected prefix
    const isTreePath = normalizedPath.startsWith("tree/");
    const isSingletonPath = normalizedPath.startsWith("singleton/");

    if (!isTreePath && !isSingletonPath) {
      // Not a protected path - allow all write access
      return { allowed: true };
    }

    // For protected paths, panel ID must match or be a prefix
    // e.g., panel "tree/my-panel" can push to "tree/my-panel/sub-repo"
    if (normalizedPath === panelId || normalizedPath.startsWith(panelId + "/")) {
      return { allowed: true };
    }

    return {
      allowed: false,
      reason: `Panel "${panelId}" cannot push to protected repo "${normalizedPath}"`,
    };
  }

  /**
   * Validate a bearer token and check access for a repo.
   */
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
