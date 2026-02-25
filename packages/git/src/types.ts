// Canonical source for these types is @natstack/types
import type { RepoArgSpec, NormalizedRepoArg } from "@natstack/types";
export type { RepoArgSpec, NormalizedRepoArg };

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
  /** Local directory path */
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
  /** Progress callback */
  onProgress?: (progress: GitProgress) => void;
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
  /** Progress callback */
  onProgress?: (progress: GitProgress) => void;
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
  /** Overall status (union of index + working tree state) */
  status: 'unmodified' | 'modified' | 'added' | 'deleted' | 'untracked' | 'ignored';
  /** Whether there are staged (index) changes for this path */
  staged: boolean;
  /** Whether there are unstaged (working tree) changes for this path */
  unstaged: boolean;
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

export interface StashEntry {
  /** Stash index (stash@{index}) */
  index: number;
  /** Full ref name (e.g., "stash@{0}") */
  ref: string;
  /** Stash message */
  message: string;
  /** Unix timestamp (seconds) if available */
  timestamp?: number;
}

/**
 * File diff information
 */
export interface FileDiff {
  /** File path */
  path: string;
  /** Content before changes (from HEAD or index) */
  oldContent: string;
  /** Content after changes */
  newContent: string;
  /** Diff hunks */
  hunks: Hunk[];
  /** Whether file is binary */
  binary: boolean;
  /** Binary file metadata when binary is true */
  binaryInfo?: BinaryDiffInfo;
  /** Image preview data when binary is true and file is an image */
  imageDiff?: ImageDiff;
}

/**
 * A hunk in a diff
 */
export interface Hunk {
  /** Hunk header (e.g., "@@ -10,5 +10,7 @@") */
  header: string;
  /** Start line in old file */
  oldStart: number;
  /** Number of lines in old file */
  oldLines: number;
  /** Start line in new file */
  newStart: number;
  /** Number of lines in new file */
  newLines: number;
  /** Lines in this hunk */
  lines: DiffLine[];
}

/**
 * A line in a diff
 */
export interface DiffLine {
  /** Line type */
  type: "context" | "add" | "delete";
  /** Line content */
  content: string;
  /** Line number in old file */
  oldLineNo?: number;
  /** Line number in new file */
  newLineNo?: number;
}

// ============================================================================
// Hunk-level staging
// ============================================================================

export interface HunkSelection {
  hunkIndex: number;
  /** Line indices in the hunk (0-based). Undefined = entire hunk. */
  lineIndices?: number[];
}

export interface StageHunksOptions {
  dir: string;
  filepath: string;
  hunks: HunkSelection[];
}

// ============================================================================
// Branch/remote operations
// ============================================================================

export interface BranchInfo {
  name: string;
  current: boolean;
  remote?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
}

export interface CreateBranchOptions {
  dir: string;
  name: string;
  startPoint?: string;
  checkout?: boolean;
}

export interface RemoteStatus {
  ahead: number;
  behind: number;
  diverged: boolean;
  remote: string;
  remoteBranch: string;
}

export interface GitProgress {
  phase: string;
  loaded: number;
  total: number;
}

// ============================================================================
// Blame/history
// ============================================================================

export interface BlameLine {
  lineNumber: number;
  content: string;
  commit: string;
  author: string;
  email: string;
  timestamp: number;
  summary: string;
}

export interface FileHistoryEntry {
  commit: string;
  author: { name: string; email: string; timestamp: number };
  message: string;
  diff?: FileDiff;
}

// ============================================================================
// Binary diffs
// ============================================================================

export interface BinaryDiffInfo {
  oldSize: number;
  newSize: number;
  sizeDelta: number;
  mimeType?: string;
  isImage: boolean;
}

export interface ImageDiff {
  oldDataUrl?: string;
  newDataUrl?: string;
  oldDimensions?: { width: number; height: number };
  newDimensions?: { width: number; height: number };
}

// ============================================================================
// Conflict resolution
// ============================================================================

export interface ConflictInfo {
  path: string;
  /** Original file content including conflict markers */
  original?: string;
  base: string;
  ours: string;
  theirs: string;
  markers: ConflictMarker[];
}

export interface ConflictMarker {
  startLine: number;
  endLine: number;
  oursStart: number;
  oursEnd: number;
  theirsStart: number;
  theirsEnd: number;
}

export interface ConflictResolution {
  path: string;
  content: string;
}
