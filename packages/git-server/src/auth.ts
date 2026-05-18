/**
 * Git authentication and authorization.
 *
 * GitAuthManager authorizes an already-authenticated caller for repo access.
 * Bearer validation happens at the gateway before requests reach GitServer.
 */

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
  constructor(private getSourceForCaller: (callerId: string) => string | null = () => null) {}

  canAccess(
    callerId: string,
    callerKind: string,
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

    if (callerKind === "shell" || callerKind === "server" || callerKind === "extension") {
      return { allowed: true };
    }

    if (callerKind === "worker") {
      const source = this.getSourceForCaller(callerId);
      if (!source) {
        return { allowed: false, reason: `Worker "${callerId}" has no source identity` };
      }
      const normalizedSource = normalizeRepoPath(source);
      if (normalizedPath === normalizedSource || normalizedPath.startsWith(normalizedSource + "/")) {
        return { allowed: true };
      }
      return {
        allowed: false,
        reason: `Worker "${callerId}" cannot push to repo "${normalizedPath}" outside source "${normalizedSource}"`,
      };
    }

    const isTreePath = normalizedPath.startsWith("tree/");
    const isSingletonPath = normalizedPath.startsWith("singleton/");

    if (!isTreePath && !isSingletonPath) {
      return { allowed: true };
    }

    if (normalizedPath === callerId || normalizedPath.startsWith(callerId + "/")) {
      return { allowed: true };
    }

    return {
      allowed: false,
      reason: `Panel "${callerId}" cannot push to protected repo "${normalizedPath}"`,
    };
  }
}
