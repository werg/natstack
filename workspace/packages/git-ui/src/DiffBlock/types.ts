import type { ReactNode } from "react";
import type { HunkSelection, FileDiff } from "@natstack/git";
import type { UIFileStatus, FileChange } from "../store/types";

// Re-export types from @natstack/git
export type { FileDiff, Hunk, DiffLine, HunkSelection } from "@natstack/git";

// Re-export from store/types.ts - single source of truth for FileChange
export type { UIFileStatus, FileChange } from "../store/types";

/** Status badge labels - single letter abbreviations */
export const STATUS_LABELS: Record<UIFileStatus, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  unmodified: "",
};

/** Semantic colors for file status badges */
export const STATUS_COLORS: Record<UIFileStatus, "green" | "yellow" | "red" | "blue" | "gray"> = {
  added: "green",
  modified: "yellow",
  deleted: "red",
  renamed: "blue",
  unmodified: "gray",
};

export interface DiffViewOptions {
  viewMode: "split" | "unified";
  wordDiff: boolean;
  showWhitespace: boolean;
  contextLines: number;
}

export interface FileFilter {
  search: string;
  status: UIFileStatus[] | null;
}

export interface DiffBlockProps {
  files: FileChange[];
  getDiff: (path: string, options?: { force?: boolean }) => Promise<FileDiff | null>;
  /** Changes when the caller wants visible diffs to re-fetch */
  refreshId?: number;
  title?: string;
  summary?: ReactNode;
  collapsible?: boolean;
  defaultCollapsed?: boolean;
  showFileTree?: boolean;
  defaultTreeVisible?: boolean;
  /** External filter state - when provided, internal filter state is ignored */
  filter?: FileFilter;
  /** Callback when filter changes (required when filter is provided) */
  onFilterChange?: (filter: FileFilter) => void;
  largeDiffThreshold?: number;
  largeFolderThreshold?: number;
  onStageFile?: (path: string) => void;
  onStageHunks?: (path: string, hunks: HunkSelection[]) => void;
  onUnstageFile?: (path: string) => void;
  onUnstageHunks?: (path: string, hunks: HunkSelection[]) => void;
  onDiscardFile?: (path: string) => void;
  editable?: boolean;
  onSaveEdit?: (path: string, content: string) => Promise<void>;
  /** Context menu copy action */
  onCopyPath?: (path: string) => void;
  /** Keyboard navigation focus (externally controlled) */
  focusedPath?: string | null;
  /** Files that have both staged and unstaged changes */
  partiallyStagedFiles?: Set<string>;
  /** Theme for Monaco editor ("light" | "dark") */
  theme?: "light" | "dark";
  /** Whether this is staged or working diff (for cache key lookup) */
  diffType?: "staged" | "working";
  /** Set of file paths with pending operations (show loading spinner) */
  pendingFiles?: Set<string>;
  /** Whether to show diff view controls */
  showDiffControls?: boolean;
  /** Shared diff view options (global controls) */
  diffViewOptions?: DiffViewOptions;
  /** Optional change handler for diff view options */
  onDiffViewOptionsChange?: (options: DiffViewOptions) => void;
  /** Custom diff cache key factory */
  diffKey?: (path: string) => string;
  /** Callback to create a new file or directory */
  onCreateFile?: (parentPath: string | null) => void;
  /** Callback to delete a file or directory */
  onDeleteFile?: (path: string, isDirectory: boolean) => void;
}
