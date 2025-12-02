import { randomBytes } from "crypto";

/**
 * Global token manager for panel/worker authentication.
 * Provides unified token management for all services (Git, CDP, etc.)
 *
 * Each panel/worker ID gets one token. Services can use this manager
 * to authenticate requests from panels/workers.
 */
export class TokenManager {
  // token -> panelId
  private tokenToPanelId = new Map<string, string>();
  // panelId -> token
  private panelIdToToken = new Map<string, string>();

  /**
   * Generate or retrieve token for a panel/worker ID.
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
   * Validate a bearer token.
   * Returns the panel ID if valid, null otherwise.
   */
  validateToken(token: string): string | null {
    return this.tokenToPanelId.get(token) ?? null;
  }

  /**
   * Get the panel ID associated with a token.
   */
  getPanelIdFromToken(token: string): string | null {
    return this.tokenToPanelId.get(token) ?? null;
  }

  /**
   * Revoke token for a panel (e.g., when panel is closed).
   */
  revokeToken(panelId: string): boolean {
    const token = this.panelIdToToken.get(panelId);
    if (!token) return false;

    this.panelIdToToken.delete(panelId);
    this.tokenToPanelId.delete(token);
    return true;
  }

  /**
   * Clear all tokens.
   */
  clear(): void {
    this.tokenToPanelId.clear();
    this.panelIdToToken.clear();
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
   * Get or create a token for a panel.
   */
  getOrCreateToken(panelId: string): string {
    return this.tokenManager.getOrCreateToken(panelId);
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
    const panelId = this.tokenManager.validateToken(token);
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

// =============================================================================
// Singleton instance
// =============================================================================

let tokenManager: TokenManager | null = null;

/**
 * Get the global token manager singleton.
 */
export function getTokenManager(): TokenManager {
  if (!tokenManager) {
    tokenManager = new TokenManager();
  }
  return tokenManager;
}
