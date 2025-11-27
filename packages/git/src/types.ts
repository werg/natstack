/**
 * Git dependency specification in panel manifest
 */
export interface GitDependency {
  /** Git repository URL or relative path */
  repo: string;
  /** Branch name to track */
  branch?: string;
  /** Specific commit hash to pin to */
  commit?: string;
  /** Tag to pin to */
  tag?: string;
}

/**
 * Resolved git dependency with computed paths
 */
export interface ResolvedDependency extends GitDependency {
  /** Name/key of this dependency */
  name: string;
  /** Resolved absolute URL for cloning */
  resolvedUrl: string;
  /** Path in OPFS where this will be cloned */
  localPath: string;
  /** The ref to checkout (commit > tag > branch > 'main') */
  ref: string;
}

/**
 * Options for git operations
 */
export interface GitClientOptions {
  /** Git server base URL (e.g., http://localhost:63524) */
  serverUrl: string;
  /** Bearer token for authentication */
  token: string;
  /** Author info for commits */
  author?: {
    name: string;
    email: string;
  };
}

/**
 * Clone options
 */
export interface CloneOptions {
  /** Repository URL */
  url: string;
  /** Local directory path in OPFS */
  dir: string;
  /** Branch/tag/commit to checkout */
  ref?: string;
  /** Clone only the specified branch (default: true) */
  singleBranch?: boolean;
  /** Shallow clone depth (default: 1 for faster clones) */
  depth?: number;
}

/**
 * Pull options
 */
export interface PullOptions {
  /** Local directory path */
  dir: string;
  /** Remote name (default: 'origin') */
  remote?: string;
  /** Branch to pull (default: current branch) */
  ref?: string;
  /** Author info for merge commit if needed */
  author?: {
    name: string;
    email: string;
  };
}

/**
 * Push options
 */
export interface PushOptions {
  /** Local directory path */
  dir: string;
  /** Remote name (default: 'origin') */
  remote?: string;
  /** Branch to push (default: current branch) */
  ref?: string;
  /** Force push (use with caution) */
  force?: boolean;
}

/**
 * Commit options
 */
export interface CommitOptions {
  /** Local directory path */
  dir: string;
  /** Commit message */
  message: string;
  /** Author info (uses client default if not provided) */
  author?: {
    name: string;
    email: string;
  };
}

/**
 * Status result for a file
 */
export interface FileStatus {
  /** File path relative to repo root */
  path: string;
  /** Status in working tree */
  status: 'unmodified' | 'modified' | 'added' | 'deleted' | 'untracked' | 'ignored';
  /** Whether file is staged */
  staged: boolean;
}

/**
 * Repository status
 */
export interface RepoStatus {
  /** Current branch name */
  branch: string | null;
  /** Current commit hash */
  commit: string | null;
  /** Whether there are uncommitted changes */
  dirty: boolean;
  /** File statuses */
  files: FileStatus[];
}
