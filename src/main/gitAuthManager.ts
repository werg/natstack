import { randomBytes } from "crypto";

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
 * Manages bearer tokens for panel authentication to the git server.
 * Each panel ID gets one token. Tokens grant:
 * - Read (fetch) access to all repos for any authenticated panel
 * - Write (push) access to repos NOT under tree/ or singleton/ prefixes
 * - Write (push) access to repos under their own panel ID path (e.g., tree/my-panel/*)
 */
export class GitAuthManager {
  // token -> panelId
  private tokenToPanelId = new Map<string, string>();
  // panelId -> token
  private panelIdToToken = new Map<string, string>();

  /**
   * Generate or retrieve token for a panel ID
   */
  getOrCreateToken(panelId: string): string {
    const existing = this.panelIdToToken.get(panelId);
    if (existing) {
      return existing;
    }

    const token = randomBytes(32).toString("hex");
    this.tokenToPanelId.set(token, panelId);
    this.panelIdToToken.set(panelId, token);
    return token;
  }

  /**
   * Check if a panel can access a repo path for a given operation.
   *
   * Rules:
   * - Fetch (read): All authenticated panels can read any repo
   * - Push (write) to repos NOT starting with tree/ or singleton/: allowed for anyone
   * - Push (write) to tree/<path> or singleton/<path>: panel ID must match or be a prefix
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
   * Validate a bearer token and check access for a repo
   */
  validateAccess(
    token: string,
    repoPath: string,
    operation: "fetch" | "push"
  ): { valid: boolean; reason?: string } {
    const panelId = this.tokenToPanelId.get(token);
    if (!panelId) {
      return { valid: false, reason: "Invalid token" };
    }

    const accessResult = this.canAccess(panelId, repoPath, operation);
    if (!accessResult.allowed) {
      return { valid: false, reason: accessResult.reason };
    }

    return { valid: true };
  }

  /**
   * Revoke token for a panel (e.g., when panel is closed)
   */
  revokeToken(panelId: string): boolean {
    const token = this.panelIdToToken.get(panelId);
    if (!token) return false;

    this.panelIdToToken.delete(panelId);
    this.tokenToPanelId.delete(token);
    return true;
  }

  /**
   * Clear all tokens
   */
  clear(): void {
    this.tokenToPanelId.clear();
    this.panelIdToToken.clear();
  }
}
