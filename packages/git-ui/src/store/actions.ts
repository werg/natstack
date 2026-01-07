import { atom } from "jotai";
import {
  configAtom,
  filesAtom,
  diffsAtom,
  stashesAtom,
  commitsAtom,
  commitsHasMoreAtom,
  commitsDepthAtom,
  branchAtom,
  lastRefreshAtom,
  refreshingAtom,
  loadingAtom,
  errorAtom,
  stashLoadingAtom,
  stashActionLoadingAtom,
  stashErrorAtom,
  historyLoadingAtom,
  actionLoadingAtom,
  focusedSectionAtom,
  focusedIndexAtom,
  loadingDiffsAtom,
  diffErrorsAtom,
} from "./atoms";
import { unstagedFilesAtom, stagedFilesAtom } from "./selectors";
import type { FileState, RefreshTrigger, DiffState } from "./types";
import type { HunkSelection } from "@natstack/git";
import { MAX_CACHED_DIFFS } from "../constants";

// =============================================================================
// Utility Functions
// =============================================================================

function mapStatus(status: string): FileState["status"] {
  switch (status) {
    case "added":
    case "untracked":
      return "added";
    case "modified":
      return "modified";
    case "deleted":
      return "deleted";
    default:
      return "modified";
  }
}

/**
 * Build a cache key for diff entries.
 * Centralizes the cache key format to prevent inconsistencies.
 */
export function buildDiffCacheKey(
  type: "working" | "staged" | "commit",
  path: string,
  sha?: string
): string {
  if (type === "commit") {
    if (!sha) throw new Error("sha required for commit diff cache key");
    return `commit:${sha}:${path}`;
  }
  return `${type}:${path}`;
}

/**
 * Delete diff cache entries for specific paths.
 * Also clears any in-flight loading state to prevent stale data from racing in.
 */
export const deleteDiffCacheForPathsAtom = atom(null, (_, set, paths: string[]) => {
  // Build all keys to delete
  const keysToDelete = paths.flatMap((path) => [
    buildDiffCacheKey("working", path),
    buildDiffCacheKey("staged", path),
  ]);

  // Clear cached diffs
  set(diffsAtom, (prev) => {
    const next = new Map(prev);
    for (const key of keysToDelete) {
      next.delete(key);
    }
    return next;
  });

  // Also clear from loading set to prevent in-flight requests from re-populating stale data
  set(loadingDiffsAtom, (prev: Set<string>) => {
    const next = new Set(prev);
    for (const key of keysToDelete) {
      next.delete(key);
    }
    return next;
  });

  // Clear any errors for these paths
  set(diffErrorsAtom, (prev) => {
    const next = new Map(prev);
    for (const key of keysToDelete) {
      next.delete(key);
    }
    return next;
  });
});

// =============================================================================
// Refresh Actions
// =============================================================================

/**
 * Refresh git status from the repository.
 *
 * PRINCIPLE: Git is the source of truth. We always fetch fresh state and
 * replace our atoms entirely. No complex change detection that can race.
 */
export const refreshStatusAtom = atom(
  null,
  async (get, set, trigger: RefreshTrigger = { type: "manual-refresh" }) => {
    const config = get(configAtom);
    if (!config) return;

    const { dir, gitClient } = config;

    // Debounce interval-based refreshes
    if (trigger.type === "interval") {
      const lastRefresh = get(lastRefreshAtom);
      if (Date.now() - lastRefresh < trigger.minAge) {
        return;
      }
    }

    // Clear diff cache on branch switch - diffs from old branch are stale
    if (trigger.type === "user-action" && trigger.action === "checkout-branch") {
      set(diffsAtom, new Map());
      set(diffErrorsAtom, new Map());
      set(loadingDiffsAtom, new Set());
    }

    set(refreshingAtom, true);
    set(errorAtom, null);

    try {
      const repoStatus = await gitClient.status(dir);

      // Build new files map from git state - this is the source of truth
      const newFiles = new Map<string, FileState>();

      for (const file of repoStatus.files) {
        if (file.status === "unmodified" || file.status === "ignored") continue;

        newFiles.set(file.path, {
          path: file.path,
          status: mapStatus(file.status),
          staged: file.staged,
          unstaged: file.unstaged,
        });
      }

      // ALWAYS replace filesAtom with fresh git state
      // No conditional updates - simple and correct
      set(filesAtom, newFiles);
      set(branchAtom, repoStatus.branch);
      set(lastRefreshAtom, Date.now());

      // Note: We don't clear diff cache on regular refresh.
      // Diffs are invalidated by user actions (stage/unstage/etc).
      // This allows diffs to persist across polling refreshes.

    } catch (err) {
      set(errorAtom, err instanceof Error ? err : new Error(String(err)));
    } finally {
      set(refreshingAtom, false);
      set(loadingAtom, false);
    }
  }
);

/**
 * Manual refresh entry point - does a FULL state reset.
 *
 * Clears all caches and reloads everything fresh from git.
 * Use this when the UI seems out of sync with git state.
 */
export const manualRefreshAtom = atom(null, async (_, set) => {
  // Clear all caches FIRST to ensure clean state
  set(diffsAtom, new Map());
  set(diffErrorsAtom, new Map());
  set(loadingDiffsAtom, new Set());

  // Then fetch fresh state from git
  await Promise.all([
    set(refreshStatusAtom, { type: "manual-refresh" }),
    set(refreshStashesAtom),
    set(refreshHistoryAtom),
  ]);
});

/**
 * Refresh stash list
 */
export const refreshStashesAtom = atom(null, async (get, set) => {
  const config = get(configAtom);
  if (!config) return;

  const { dir, gitClient } = config;

  set(stashLoadingAtom, true);
  set(stashErrorAtom, null);

  try {
    const stashes = await gitClient.stashList(dir);
    set(stashesAtom, stashes);
  } catch (err) {
    set(stashErrorAtom, err instanceof Error ? err : new Error(String(err)));
  } finally {
    set(stashLoadingAtom, false);
  }
});

/**
 * Refresh commit history
 */
export const refreshHistoryAtom = atom(null, async (get, set, resetDepth = false) => {
  const config = get(configAtom);
  if (!config) return;

  const { dir, gitClient } = config;

  if (resetDepth) {
    set(commitsDepthAtom, 10);
  }

  const depth = get(commitsDepthAtom);

  set(historyLoadingAtom, true);

  try {
    const commits = await gitClient.log(dir, { depth });
    set(commitsAtom, commits);
    set(commitsHasMoreAtom, commits.length >= depth);
  } catch (err) {
    // History loading is not critical - log in development for debugging
    if (process.env["NODE_ENV"] !== "production") {
      console.warn("[git-ui] Failed to load commit history:", err);
    }
  } finally {
    set(historyLoadingAtom, false);
  }
});

/**
 * Load more commit history
 */
export const loadMoreHistoryAtom = atom(null, async (get, set) => {
  const config = get(configAtom);
  if (!config) return;

  const hasMore = get(commitsHasMoreAtom);
  const loading = get(historyLoadingAtom);
  if (!hasMore || loading) return;

  const newDepth = get(commitsDepthAtom) + 10;
  set(commitsDepthAtom, newDepth);

  const { dir, gitClient } = config;

  set(historyLoadingAtom, true);

  try {
    const commits = await gitClient.log(dir, { depth: newDepth });
    set(commitsAtom, commits);
    set(commitsHasMoreAtom, commits.length >= newDepth);
  } catch (err) {
    // History loading is not critical - log in development for debugging
    if (process.env["NODE_ENV"] !== "production") {
      console.warn("[git-ui] Failed to load more commit history:", err);
    }
  } finally {
    set(historyLoadingAtom, false);
  }
});

// =============================================================================
// File Actions
// =============================================================================

/**
 * Stage a file
 */
export const stageFileAtom = atom(null, async (get, set, path: string) => {
  const config = get(configAtom);
  if (!config) return;

  const { dir, gitClient, onNotify } = config;

  set(actionLoadingAtom, true);

  try {
    await gitClient.add(dir, path);
    set(deleteDiffCacheForPathsAtom, [path]);
    await set(refreshStatusAtom);

    const fileName = path.split("/").pop() || path;
    onNotify?.({ type: "success", title: "Staged file", description: fileName });
  } catch (err) {
    onNotify?.({
      type: "error",
      title: "Failed to stage file",
      description: err instanceof Error ? err.message : String(err),
    });
  } finally {
    set(actionLoadingAtom, false);
  }
});

/**
 * Stage selected hunks/lines
 */
export const stageHunksAtom = atom(
  null,
  async (
    get,
    set,
    payload: { path: string; hunks: HunkSelection[] }
  ) => {
    const config = get(configAtom);
    if (!config) return;

    const { dir, gitClient, onNotify } = config;

    set(actionLoadingAtom, true);

    try {
      await gitClient.stageHunks({
        dir,
        filepath: payload.path,
        hunks: payload.hunks,
      });

      set(deleteDiffCacheForPathsAtom, [payload.path]);
      await set(refreshStatusAtom);

      const fileName = payload.path.split("/").pop() || payload.path;
      onNotify?.({ type: "success", title: "Staged selection", description: fileName });
    } catch (err) {
      onNotify?.({
        type: "error",
        title: "Failed to stage selection",
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      set(actionLoadingAtom, false);
    }
  }
);

/**
 * Stage all files
 */
export const stageAllAtom = atom(null, async (get, set, paths: string[]) => {
  const config = get(configAtom);
  if (!config) return;

  const { dir, gitClient, onNotify } = config;

  set(actionLoadingAtom, true);

  try {
    await Promise.all(paths.map((path) => gitClient.add(dir, path)));

    set(deleteDiffCacheForPathsAtom, paths);

    await set(refreshStatusAtom);

    onNotify?.({
      type: "success",
      title: `Staged ${paths.length} file${paths.length !== 1 ? "s" : ""}`,
    });
  } catch (err) {
    onNotify?.({
      type: "error",
      title: "Failed to stage files",
      description: err instanceof Error ? err.message : String(err),
    });
  } finally {
    set(actionLoadingAtom, false);
  }
});

/**
 * Unstage a file
 */
export const unstageFileAtom = atom(null, async (get, set, path: string) => {
  const config = get(configAtom);
  if (!config) return;

  const { dir, gitClient, onNotify } = config;

  set(actionLoadingAtom, true);

  try {
    await gitClient.unstage(dir, path);
    set(deleteDiffCacheForPathsAtom, [path]);
    await set(refreshStatusAtom);

    const fileName = path.split("/").pop() || path;
    onNotify?.({ type: "success", title: "Unstaged file", description: fileName });
  } catch (err) {
    onNotify?.({
      type: "error",
      title: "Failed to unstage file",
      description: err instanceof Error ? err.message : String(err),
    });
  } finally {
    set(actionLoadingAtom, false);
  }
});

/**
 * Unstage selected hunks/lines
 */
export const unstageHunksAtom = atom(
  null,
  async (
    get,
    set,
    payload: { path: string; hunks: HunkSelection[] }
  ) => {
    const config = get(configAtom);
    if (!config) return;

    const { dir, gitClient, onNotify } = config;

    set(actionLoadingAtom, true);

    try {
      await gitClient.unstageHunks({
        dir,
        filepath: payload.path,
        hunks: payload.hunks,
      });

      set(deleteDiffCacheForPathsAtom, [payload.path]);
      await set(refreshStatusAtom);

      const fileName = payload.path.split("/").pop() || payload.path;
      onNotify?.({ type: "success", title: "Unstaged selection", description: fileName });
    } catch (err) {
      onNotify?.({
        type: "error",
        title: "Failed to unstage selection",
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      set(actionLoadingAtom, false);
    }
  }
);

/**
 * Unstage all files
 */
export const unstageAllAtom = atom(null, async (get, set, paths: string[]) => {
  const config = get(configAtom);
  if (!config) return;

  const { dir, gitClient, onNotify } = config;

  set(actionLoadingAtom, true);

  try {
    await Promise.all(paths.map((path) => gitClient.unstage(dir, path)));

    set(deleteDiffCacheForPathsAtom, paths);

    await set(refreshStatusAtom);

    onNotify?.({
      type: "success",
      title: `Unstaged ${paths.length} file${paths.length !== 1 ? "s" : ""}`,
    });
  } catch (err) {
    onNotify?.({
      type: "error",
      title: "Failed to unstage files",
      description: err instanceof Error ? err.message : String(err),
    });
  } finally {
    set(actionLoadingAtom, false);
  }
});

/**
 * Discard changes to a file
 */
export const discardFileAtom = atom(null, async (get, set, path: string) => {
  const config = get(configAtom);
  if (!config) return;

  const { dir, gitClient, onNotify } = config;

  set(actionLoadingAtom, true);

  try {
    await gitClient.discardChanges(dir, path);

    // Mark diffs as stale for this path
    set(deleteDiffCacheForPathsAtom, [path]);

    await set(refreshStatusAtom);

    const fileName = path.split("/").pop() || path;
    onNotify?.({ type: "success", title: "Discarded changes", description: fileName });
  } catch (err) {
    onNotify?.({
      type: "error",
      title: "Failed to discard changes",
      description: err instanceof Error ? err.message : String(err),
    });
  } finally {
    set(actionLoadingAtom, false);
  }
});

/**
 * Validate that a file path is safe and stays within the repository
 * Returns the normalized path if valid, throws if invalid
 */
function validatePath(path: string): string {
  // Decode URL-encoded characters that could be used for traversal
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // If decoding fails, use original (might have invalid encoding)
  }

  // Normalize path separators
  const normalized = decoded.replace(/\\/g, "/");

  // Reject obviously malicious patterns
  if (
    normalized.startsWith("/") ||
    normalized.startsWith("..") ||
    normalized.includes("/../") ||
    normalized.endsWith("/..") ||
    normalized.includes("//") ||
    // Tilde expansion (could expand to home directory in shell contexts)
    normalized.startsWith("~") ||
    // Null byte injection
    normalized.includes("\0") ||
    // Windows reserved names (con, prn, aux, nul, com1-9, lpt1-9)
    // Note: Only com1-9 and lpt1-9 are reserved, not com10+
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(normalized.split("/").pop() || "")
  ) {
    throw new Error("Invalid file path: path traversal or invalid name not allowed");
  }

  // Split and resolve path segments
  const segments = normalized.split("/").filter(Boolean);
  const resolved: string[] = [];

  for (const segment of segments) {
    if (segment === "..") {
      if (resolved.length === 0) {
        // Trying to go above root
        throw new Error("Invalid file path: path traversal not allowed");
      }
      resolved.pop();
    } else if (segment !== ".") {
      resolved.push(segment);
    }
  }

  const safePath = resolved.join("/");

  // Ensure path is not empty after normalization
  if (!safePath) {
    throw new Error("Invalid file path: empty path");
  }

  return safePath;
}

/**
 * Save file content
 */
export const saveFileAtom = atom(null, async (get, set, path: string, content: string) => {
  const config = get(configAtom);
  if (!config) return;

  const { dir, fs, onNotify } = config;

  // Security: validate and normalize path
  const safePath = validatePath(path);

  set(actionLoadingAtom, true);

  try {
    await fs.writeFile(`${dir}/${safePath}`, content);

    set(deleteDiffCacheForPathsAtom, [safePath]);

    await set(refreshStatusAtom);

    const fileName = safePath.split("/").pop() || safePath;
    onNotify?.({ type: "success", title: "File saved", description: fileName });
  } catch (err) {
    onNotify?.({
      type: "error",
      title: "Failed to save file",
      description: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    set(actionLoadingAtom, false);
  }
});

/**
 * Create a commit
 */
export const commitAtom = atom(null, async (get, set, message: string): Promise<string> => {
  const config = get(configAtom);
  if (!config) throw new Error("Store not initialized");

  const { dir, gitClient, onNotify } = config;

  set(actionLoadingAtom, true);

  try {
    const sha = await gitClient.commit({ dir, message });

    // Clear all diff cache after commit
    set(diffsAtom, new Map());

    await set(refreshStatusAtom);
    await set(refreshHistoryAtom);

    onNotify?.({
      type: "success",
      title: "Commit created",
      description: sha.slice(0, 7),
    });

    return sha;
  } catch (err) {
    onNotify?.({
      type: "error",
      title: "Failed to create commit",
      description: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    set(actionLoadingAtom, false);
  }
});

// =============================================================================
// Stash Actions
// =============================================================================

/**
 * Create a stash
 */
export const createStashAtom = atom(null, async (get, set, options?: { message?: string }) => {
  const config = get(configAtom);
  if (!config) return;

  const { dir, gitClient, onNotify } = config;

  set(stashActionLoadingAtom, true);

  try {
    await gitClient.stash(dir, options);

    // Clear diff cache
    set(diffsAtom, new Map());

    await set(refreshStatusAtom);
    await set(refreshStashesAtom);

    onNotify?.({ type: "success", title: "Stashed changes" });
  } catch (err) {
    onNotify?.({
      type: "error",
      title: "Failed to stash changes",
      description: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    set(stashActionLoadingAtom, false);
  }
});

/**
 * Apply a stash
 */
export const applyStashAtom = atom(null, async (get, set, index: number) => {
  const config = get(configAtom);
  if (!config) return;

  const { dir, gitClient, onNotify } = config;

  set(stashActionLoadingAtom, true);

  try {
    await gitClient.stashApply(dir, index);

    // Clear diff cache
    set(diffsAtom, new Map());

    await set(refreshStatusAtom);
    await set(refreshStashesAtom);

    onNotify?.({ type: "success", title: `Applied stash@{${index}}` });
  } catch (err) {
    onNotify?.({
      type: "error",
      title: "Failed to apply stash",
      description: err instanceof Error ? err.message : String(err),
    });
  } finally {
    set(stashActionLoadingAtom, false);
  }
});

/**
 * Pop a stash
 */
export const popStashAtom = atom(null, async (get, set, index: number) => {
  const config = get(configAtom);
  if (!config) return;

  const { dir, gitClient, onNotify } = config;

  set(stashActionLoadingAtom, true);

  try {
    await gitClient.stashPop(dir, index);

    // Clear diff cache
    set(diffsAtom, new Map());

    await set(refreshStatusAtom);
    await set(refreshStashesAtom);

    onNotify?.({ type: "success", title: `Popped stash@{${index}}` });
  } catch (err) {
    onNotify?.({
      type: "error",
      title: "Failed to pop stash",
      description: err instanceof Error ? err.message : String(err),
    });
  } finally {
    set(stashActionLoadingAtom, false);
  }
});

/**
 * Drop a stash
 */
export const dropStashAtom = atom(null, async (get, set, index: number) => {
  const config = get(configAtom);
  if (!config) return;

  const { dir, gitClient, onNotify } = config;

  set(stashActionLoadingAtom, true);

  try {
    await gitClient.stashDrop(dir, index);

    await set(refreshStashesAtom);

    onNotify?.({ type: "success", title: `Dropped stash@{${index}}` });
  } catch (err) {
    onNotify?.({
      type: "error",
      title: "Failed to drop stash",
      description: err instanceof Error ? err.message : String(err),
    });
  } finally {
    set(stashActionLoadingAtom, false);
  }
});

// =============================================================================
// Diff Loading Actions
// =============================================================================

/**
 * Prune the diff cache to stay within size limits.
 * Uses Map insertion order (FIFO) for eviction.
 */
function pruneDiffCache(cache: Map<string, DiffState>, maxSize: number): Map<string, DiffState> {
  if (cache.size <= maxSize) return cache;

  // Map maintains insertion order - remove oldest entries
  const entries = Array.from(cache.entries());
  const toRemove = entries.slice(0, entries.length - maxSize);
  const next = new Map(cache);
  for (const [key] of toRemove) {
    next.delete(key);
  }

  return next;
}

/**
 * Fetch a diff (working tree, staged, or commit).
 *
 * This action has dual purposes:
 * 1. Returns the diff directly for immediate use by the caller
 * 2. Caches the diff in diffsAtom for other components to read via getDiffAtom
 *
 * @param type - The type of diff: "working" (index vs workdir), "staged" (HEAD vs index), or "commit"
 * @param path - The file path to get the diff for
 * @param options.force - If true, bypass the cache and fetch fresh data
 * @param options.sha - Required for "commit" type - the commit hash
 * @returns The FileDiff, or null if still loading or config not set
 */
export const fetchDiffAtom = atom(
  null,
  async (
    get,
    set,
    type: "working" | "staged" | "commit",
    path: string,
    options?: { force?: boolean; sha?: string }
  ) => {
    const config = get(configAtom);
    if (!config) return null;

    const { dir, gitClient } = config;

    const key = buildDiffCacheKey(type, path, options?.sha);

    // Check cache unless forced
    if (!options?.force) {
      const diffs = get(diffsAtom);
      const cached = diffs.get(key);
      if (cached) {
        return cached.diff;
      }
    }

    // Check if already loading (use key not path to differentiate staged/working)
    const loadingDiffs = get(loadingDiffsAtom);
    if (loadingDiffs.has(key)) {
      return null;
    }

    // Mark as loading
    set(loadingDiffsAtom, (prev: Set<string>) => new Set(prev).add(key));

    try {
      let diff;
      switch (type) {
        case "working":
          diff = await gitClient.getWorkingDiff(dir, path);
          break;
        case "staged":
          diff = await gitClient.getStagedDiff(dir, path);
          break;
        case "commit":
          if (!options?.sha) throw new Error("sha required for commit diff");
          diff = await gitClient.getCommitDiff(dir, options.sha, path);
          break;
      }

      // Store in cache with size limit enforcement
      set(diffsAtom, (prev) => {
        const next = new Map(prev);
        next.set(key, { diff });
        // Prune cache if it exceeds the max size
        return pruneDiffCache(next, MAX_CACHED_DIFFS);
      });

      // Clear error
      set(diffErrorsAtom, (prev) => {
        const next = new Map(prev);
        next.delete(key);
        return next;
      });

      return diff;
    } catch (err) {
      set(diffErrorsAtom, (prev) => {
        const next = new Map(prev);
        next.set(key, err instanceof Error ? err.message : String(err));
        return next;
      });

      return null;
    } finally {
      set(loadingDiffsAtom, (prev: Set<string>) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }
);

/**
 * Clear all diff cache
 */
export const clearDiffCacheAtom = atom(null, (_, set) => {
  set(diffsAtom, new Map());
});

// =============================================================================
// UI Navigation Actions
// =============================================================================

/**
 * Set focused section
 */
export const setFocusedSectionAtom = atom(null, (_, set, section: "staged" | "unstaged") => {
  set(focusedSectionAtom, section);
  set(focusedIndexAtom, 0);
});

/**
 * Move focus up
 */
export const moveFocusUpAtom = atom(null, (_, set) => {
  set(focusedIndexAtom, (prev) => Math.max(0, prev - 1));
});

/**
 * Move focus down
 */
export const moveFocusDownAtom = atom(null, (get, set) => {
  const section = get(focusedSectionAtom);
  const files = section === "unstaged" ? get(unstagedFilesAtom) : get(stagedFilesAtom);
  const maxIndex = Math.max(0, files.length - 1);

  set(focusedIndexAtom, (prev) => Math.min(maxIndex, prev + 1));
});

/**
 * Toggle focused section
 */
export const toggleFocusedSectionAtom = atom(null, (get, set) => {
  const current = get(focusedSectionAtom);
  set(focusedSectionAtom, current === "unstaged" ? "staged" : "unstaged");
  set(focusedIndexAtom, 0);
});

// =============================================================================
// Initialization
// =============================================================================

/**
 * Initialize the store with config and fetch initial data.
 * Synchronous to avoid race conditions with useEffect cleanup in StrictMode.
 */
export const initializeStoreAtom = atom(null, (_, set, config: import("./types").GitStoreConfig) => {
  set(configAtom, config);
  set(loadingAtom, true);

  // Fire and forget - each refresh checks configAtom and handles its own errors
  void set(refreshStatusAtom);
  void set(refreshStashesAtom);
  void set(refreshHistoryAtom);
});

/**
 * Cleanup the store when the component unmounts.
 * Sets config to null to prevent in-flight async operations from updating stale state.
 * Other atoms are left intact - they're bounded by LRU limits and can be reused on remount.
 */
export const cleanupStoreAtom = atom(null, (_, set) => {
  set(configAtom, null);
});
