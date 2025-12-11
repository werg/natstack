/**
 * Repo argument specification for createChild.
 * Can be a shorthand string or full object.
 *
 * Shorthand formats:
 * - "panels/shared" - defaults to main/master branch
 * - "panels/shared#develop" - specific branch
 * - "panels/shared@v1.0.0" - specific tag
 * - "panels/shared@abc123" - specific commit (7+ hex chars)
 */
export type RepoArgSpec =
  | string
  | {
      /** Git repository path relative to workspace (e.g., "panels/shared") */
      repo: string;
      /** Branch, tag, or commit hash to checkout */
      ref?: string;
    };

/**
 * Normalized repo arg after parsing shorthand
 */
export interface NormalizedRepoArg {
  /** Name/key of this repo arg */
  name: string;
  /** Repository path */
  repo: string;
  /** Ref to checkout (branch, tag, or commit) */
  ref?: string;
  /** Resolved absolute URL for cloning */
  resolvedUrl: string;
  /** Path in OPFS where this will be cloned (/args/<name>) */
  localPath: string;
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
