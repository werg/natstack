import { useAtomValue } from "jotai";
import {
  branchAtom,
  configAtom,
  errorAtom,
  loadingAtom,
  refreshingAtom,
  stagedFilesAtom,
  unstagedFilesAtom,
  partiallyStagedFilesAtom,
  hasStagedAtom,
  hasChangesAtom,
} from "./store";
import type { FileChange } from "./store/types";

/**
 * Result of useGitStatus hook
 */
export interface UseGitStatusResult {
  /** Files with staged changes */
  stagedFiles: FileChange[];
  /** Files with unstaged changes */
  unstagedFiles: FileChange[];
  /** Files that appear in both staged and unstaged (partially staged) */
  partiallyStagedFiles: Set<string>;
  /** Whether there are any staged changes */
  hasStaged: boolean;
  /** Whether there are any changes (staged or unstaged) */
  hasChanges: boolean;
  /** Current branch name */
  branch: string | null;
  /** Whether initial load is in progress */
  loading: boolean;
  /** Whether a refresh is in progress */
  refreshing: boolean;
  /** Error from last operation */
  error: Error | null;
  /** Whether the store has been initialized */
  initialized: boolean;
}

/**
 * Hook to read git status from the global store.
 *
 * IMPORTANT: This hook only reads state. The store must be initialized
 * separately using `initializeStoreAtom` before this hook returns useful data.
 * GitStatusView handles initialization automatically.
 *
 * @example
 * ```tsx
 * // In a component that's a child of GitStatusView:
 * function MyComponent() {
 *   const { stagedFiles, loading } = useGitStatus();
 *   if (loading) return <Spinner />;
 *   return <FileList files={stagedFiles} />;
 * }
 * ```
 */
export function useGitStatus(): UseGitStatusResult {
  const stagedFiles = useAtomValue(stagedFilesAtom);
  const unstagedFiles = useAtomValue(unstagedFilesAtom);
  const partiallyStagedFiles = useAtomValue(partiallyStagedFilesAtom);
  const hasStaged = useAtomValue(hasStagedAtom);
  const hasChanges = useAtomValue(hasChangesAtom);
  const branch = useAtomValue(branchAtom);
  const loading = useAtomValue(loadingAtom);
  const refreshing = useAtomValue(refreshingAtom);
  const error = useAtomValue(errorAtom);
  const config = useAtomValue(configAtom);

  return {
    stagedFiles,
    unstagedFiles,
    partiallyStagedFiles,
    hasStaged,
    hasChanges,
    branch,
    loading,
    refreshing,
    error,
    initialized: config !== null,
  };
}
