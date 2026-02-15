import { atom } from "jotai";
import type {
  FileState,
  DiffState,
  CommitEntry,
  GitStoreConfig,
  StashEntry,
} from "./types";

// =============================================================================
// Configuration Atom (set once on initialization)
// =============================================================================

export const configAtom = atom<GitStoreConfig | null>(null);

// =============================================================================
// Core State Atoms
// =============================================================================

/**
 * Normalized file state - Map<path, FileState>
 * Using Map for O(1) lookups and structural sharing
 */
export const filesAtom = atom<Map<string, FileState>>(new Map());

/**
 * Cached diffs - Map<key, DiffState>
 * Key format: "working:path" | "staged:path" | "commit:sha:path"
 */
export const diffsAtom = atom<Map<string, DiffState>>(new Map());

/**
 * Stash entries
 */
export const stashesAtom = atom<StashEntry[]>([]);

/**
 * Commit history entries
 */
export const commitsAtom = atom<CommitEntry[]>([]);

/**
 * Whether there are more commits to load
 */
export const commitsHasMoreAtom = atom<boolean>(true);

/**
 * Current commit history depth (for pagination)
 */
export const commitsDepthAtom = atom<number>(10);

// =============================================================================
// UI State Atoms
// =============================================================================

/**
 * Currently focused section for keyboard navigation
 */
export const focusedSectionAtom = atom<"staged" | "unstaged">("unstaged");

/**
 * Currently focused index within the focused section
 */
export const focusedIndexAtom = atom<number>(0);

/**
 * All tracked files in the repository (from git ls-files equivalent)
 * Always shown in the file tree
 */
export const allTrackedFilesAtom = atom<string[]>([]);

/**
 * Whether the header is minimized to show more diff content
 */
export const headerMinimizedAtom = atom<boolean>(false);

/**
 * Empty directories created by the user (not tracked by git)
 * These need to be displayed even though they have no files
 */
export const emptyDirectoriesAtom = atom<Set<string>>(new Set<string>());

// =============================================================================
// Metadata Atoms
// =============================================================================

/**
 * Current branch name
 */
export const branchAtom = atom<string | null>(null);

/**
 * Last successful refresh timestamp
 */
export const lastRefreshAtom = atom<number>(0);

/**
 * Whether a refresh is currently in progress
 */
export const refreshingAtom = atom<boolean>(false);

/**
 * Loading state for initial load
 */
export const loadingAtom = atom<boolean>(true);

/**
 * Error from last refresh attempt
 */
export const errorAtom = atom<Error | null>(null);

/**
 * Whether stash list is loading (set to true when refresh starts)
 */
export const stashLoadingAtom = atom<boolean>(false);

/**
 * Whether a stash action is in progress
 */
export const stashActionLoadingAtom = atom<boolean>(false);

/**
 * Error from stash operations
 */
export const stashErrorAtom = atom<Error | null>(null);

/**
 * Whether commit history is loading (set to true when refresh starts)
 */
export const historyLoadingAtom = atom<boolean>(false);

/**
 * Whether an action (stage, unstage, commit, etc.) is in progress
 */
export const actionLoadingAtom = atom<boolean>(false);

// =============================================================================
// Dialog State Atoms
// =============================================================================
//
// DESIGN NOTE: Dialog state is stored in atoms (not component useState) because:
// 1. pollingPausedAtom needs to check if ANY dialog is open to pause background refresh
// 2. Keyboard shortcuts in GitStatusView check dialog state
// 3. This allows coordination between dialogs and other system behaviors

/**
 * Path of file to discard (null = dialog closed)
 */
export const discardPathAtom = atom<string | null>(null);

/**
 * Whether to show unstage all confirmation dialog
 */
export const showUnstageConfirmAtom = atom<boolean>(false);

/**
 * Stash index to drop (null = dialog closed)
 */
export const dropStashIndexAtom = atom<number | null>(null);

/**
 * Whether to show commit form
 */
export const showCommitFormAtom = atom<boolean>(false);

// =============================================================================
// Diff Loading State Atoms
// =============================================================================

/**
 * Paths currently being loaded
 */
export const loadingDiffsAtom = atom<Set<string>>(new Set<string>());

/**
 * Errors for specific diff paths
 */
export const diffErrorsAtom = atom<Map<string, string>>(new Map());

// =============================================================================
// Shared Cache Atoms (for hooks that need shared caching)
// =============================================================================

import type { BlameLine, FileHistoryEntry } from "@natstack/git";

export interface BlameCacheEntry {
  blame: BlameLine[];
  fetchedAt: number;
}

export interface HistoryCacheEntry {
  history: FileHistoryEntry[];
  fetchedAt: number;
}

/**
 * Shared blame cache - Map<path, CacheEntry>
 * Multiple useFileBlame instances share this cache.
 */
export const blameCacheAtom = atom<Map<string, BlameCacheEntry>>(new Map());

/**
 * Shared file history cache - Map<path, CacheEntry>
 * Multiple useFileHistory instances share this cache.
 */
export const historyCacheAtom = atom<Map<string, HistoryCacheEntry>>(new Map());
