import { atom } from "jotai";
import {
  filesAtom,
  diffsAtom,
  focusedSectionAtom,
  focusedIndexAtom,
  discardPathAtom,
  showUnstageConfirmAtom,
  dropStashIndexAtom,
  showCommitFormAtom,
} from "./atoms";
import type { FileChange, FileState } from "./types";

/**
 * Convert FileState to FileChange format (for component compatibility).
 */
function fileStateToFileChange(file: FileState, staged: boolean): FileChange {
  return {
    path: file.path,
    status: file.status,
    oldPath: file.oldPath,
    staged,
  };
}

// =============================================================================
// Derived Selectors
// =============================================================================

/**
 * Derived atom for staged files.
 * Jotai handles subscription efficiently - only re-renders when filesAtom changes.
 * Component-level React.memo handles UI optimization.
 */
export const stagedFilesAtom = atom((get) => {
  const files = get(filesAtom);
  const result: FileChange[] = [];

  for (const file of files.values()) {
    if (file.staged) {
      result.push(fileStateToFileChange(file, true));
    }
  }

  // Sort by path for consistent ordering
  result.sort((a, b) => a.path.localeCompare(b.path));
  return result;
});

/**
 * Derived atom for unstaged files
 */
export const unstagedFilesAtom = atom((get) => {
  const files = get(filesAtom);
  const result: FileChange[] = [];

  for (const file of files.values()) {
    if (file.unstaged) {
      result.push(fileStateToFileChange(file, false));
    }
  }

  // Sort by path for consistent ordering
  result.sort((a, b) => a.path.localeCompare(b.path));
  return result;
});

/**
 * Set of partially staged file paths (appear in both staged and unstaged)
 */
export const partiallyStagedFilesAtom = atom((get) => {
  const files = get(filesAtom);
  const result = new Set<string>();

  for (const file of files.values()) {
    if (file.staged && file.unstaged) {
      result.add(file.path);
    }
  }

  return result;
});

/**
 * Helper to compute additions/deletions from a diff's hunks.
 * Exported for use in components.
 */
export function computeDiffStats(hunks: Array<{ lines: Array<{ type: string }> }>): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.type === "add") additions++;
      if (line.type === "delete") deletions++;
    }
  }
  return { additions, deletions };
}

/**
 * Whether there are any staged changes
 */
export const hasStagedAtom = atom((get) => {
  const files = get(filesAtom);
  for (const file of files.values()) {
    if (file.staged) return true;
  }
  return false;
});

/**
 * Whether there are any changes (staged or unstaged)
 */
export const hasChangesAtom = atom((get) => {
  const files = get(filesAtom);
  return files.size > 0;
});

/**
 * Whether polling should be paused (dialog open)
 */
export const pollingPausedAtom = atom((get) => {
  return (
    get(showCommitFormAtom) ||
    get(discardPathAtom) !== null ||
    get(showUnstageConfirmAtom) ||
    get(dropStashIndexAtom) !== null
  );
});

/**
 * Currently focused file path based on section and index
 */
export const focusedPathAtom = atom((get) => {
  const section = get(focusedSectionAtom);
  const index = get(focusedIndexAtom);
  const files = section === "unstaged" ? get(unstagedFilesAtom) : get(stagedFilesAtom);

  if (files.length === 0) return null;
  const clampedIndex = Math.min(index, files.length - 1);
  return files[clampedIndex]?.path ?? null;
});

/**
 * Get diff for a specific key from cache
 */
export const getDiffAtom = atom((get) => {
  const diffs = get(diffsAtom);
  return (key: string) => diffs.get(key)?.diff ?? null;
});
