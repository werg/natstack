/**
 * Types used by the git-server package.
 * These mirror the types in the main app to avoid coupling.
 */

export interface WorkspaceNode {
  name: string;
  path: string;
  isGitRepo: boolean;
  launchable?: { title: string; hidden?: boolean };
  packageInfo?: { name: string; version?: string };
  skillInfo?: { name: string; description: string };
  children: WorkspaceNode[];
}

export interface WorkspaceTree {
  children: WorkspaceNode[];
}

export interface BranchInfo {
  name: string;
  current: boolean;
  remote?: string;
}

export interface CommitInfo {
  oid: string;
  message: string;
  author: { name: string; timestamp: number };
}

/** Minimal GitWatcher interface — subset used by GitServer. */
export interface GitWatcherLike {
  on(event: string, callback: (repoPath: string) => void): () => void;
}

/** GitHub proxy configuration. */
export interface GitHubProxyConfig {
  enabled?: boolean;
  token?: string;
  depth?: number;
}

/** Minimal TokenManager interface — subset used by GitAuthManager. */
export interface TokenManagerLike {
  getToken(callerId: string): string;
  revokeToken(callerId: string): boolean;
  validateToken(token: string): { callerId: string; callerKind: string } | null;
}
