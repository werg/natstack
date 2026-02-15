import type { FileDiff, StashEntry, GitClient, FsPromisesLike } from "@natstack/git";

/**
 * UI file status values.
 *
 * These are mapped from git's raw status values:
 * - "added" ← git "added" or "untracked" (new files)
 * - "modified" ← git "modified" or any unknown status
 * - "deleted" ← git "deleted"
 * - "renamed" ← detected when oldPath differs from path
 * - "unmodified" ← tracked file with no changes (used when showing all files)
 */
export type UIFileStatus = "added" | "modified" | "deleted" | "renamed" | "unmodified";

/**
 * Normalized file state stored in the files Map
 */
export interface FileState {
  path: string;
  status: UIFileStatus;
  staged: boolean;
  unstaged: boolean;
  oldPath?: string;
}

/**
 * Cached diff entry
 */
export interface DiffState {
  /** The diff data */
  diff: FileDiff;
}

/**
 * Commit entry from git log
 */
export interface CommitEntry {
  oid: string;
  message: string;
  author: {
    name: string;
    email: string;
    timestamp: number;
  };
}

/**
 * Refresh trigger types for event-driven updates
 */
export type RefreshTrigger =
  | { type: "user-action"; action: string }
  | { type: "manual-refresh" }
  | { type: "focus-gained" }
  | { type: "initial" }
  | { type: "interval"; minAge: number };

/**
 * Git store configuration (passed when initializing)
 */
export interface GitStoreConfig {
  dir: string;
  gitClient: GitClient;
  fs: FsPromisesLike;
  /** Callback for notifications */
  onNotify?: (notification: GitNotification) => void;
}

/**
 * Notification from git actions
 */
export interface GitNotification {
  type: "success" | "error" | "info";
  title: string;
  description?: string;
}

/**
 * FileChange type compatible with DiffBlock components
 */
export interface FileChange {
  path: string;
  status: UIFileStatus;
  oldPath?: string;
  staged: boolean;
  /** Number of added lines (computed from diff when available) */
  additions?: number;
  /** Number of deleted lines (computed from diff when available) */
  deletions?: number;
  /** True for empty directory entries (no files inside yet) */
  isDirectory?: boolean;
}

// Re-export types from @natstack/git
export type { FileDiff, StashEntry, GitClient, FsPromisesLike };
