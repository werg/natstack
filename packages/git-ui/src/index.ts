/**
 * @natstack/git-ui - Git UI components for React
 *
 * This package provides a complete Git status view with:
 * - File staging/unstaging with diff views
 * - Commit creation and history viewing
 * - Stash management
 * - Branch operations
 * - Conflict resolution
 *
 * @remarks
 * **Important**: This package uses a global Jotai store for state management.
 * Only one GitStatusView instance should be mounted at a time. If you need to
 * switch between repositories, unmount the current GitStatusView before mounting
 * a new one with different props. Multiple simultaneous instances will share
 * state unexpectedly.
 */

// Configure Monaco loader to use bundled Monaco (for Electron compatibility)
// This must be done before any Monaco Editor components are imported
import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
loader.config({ monaco });

// Configure Monaco workers (extracted to separate module for clarity)
import { configureMonacoWorkers, type MonacoWorkerConfig } from "./monacoWorkers";
configureMonacoWorkers();

// Re-export Monaco worker configuration for consumers who need custom setup
export { configureMonacoWorkers, type MonacoWorkerConfig } from "./monacoWorkers";

// =============================================================================
// DiffBlock Components
// =============================================================================

export {
  DiffBlock,
  FileTree,
  DiffStack,
  FileDiff,
  FileDiffHeader,
  LargeDiffGuard,
  DiffViewControls,
  HunkHeader,
  LineSelectionOverlay,
  BinaryFileDiff,
  ImageCompare,
} from "./DiffBlock";

export type {
  DiffBlockProps,
  FileChange,
  FileDiffType,
  Hunk,
  DiffLine,
  FileTreeContextMenuActions,
  FileDiffHeaderProps,
  DiffViewOptions,
  FileFilter,
} from "./DiffBlock";

// =============================================================================
// Git Status Components
// =============================================================================

export { GitStatusView } from "./GitStatusView";
export type { GitStatusViewProps, GitNotification } from "./GitStatusView";
export { useGitStatus } from "./useGitStatus";
export type { UseGitStatusResult } from "./useGitStatus";
export { useGitBranches } from "./hooks/useGitBranches";
export { useGitRemote } from "./hooks/useGitRemote";
export { useFileBlame } from "./hooks/useFileBlame";
export { useFileHistory } from "./hooks/useFileHistory";
export { useConflicts } from "./hooks/useConflicts";

export { GitStatusHeader } from "./GitStatusHeader";
export type { GitStatusHeaderProps } from "./GitStatusHeader";
export { BranchSelector } from "./BranchSelector";
export { CreateBranchDialog } from "./CreateBranchDialog";
export { RemoteOperationsBar } from "./RemoteOperationsBar";
export { PushPullProgress } from "./PushPullProgress";
export { AuthErrorDialog } from "./AuthErrorDialog";

export { CommitForm } from "./CommitForm";
export type { CommitFormProps } from "./CommitForm";

export { CommitHistory } from "./CommitHistory";
export type { CommitHistoryProps } from "./CommitHistory";
export { BlameView } from "./BlameView";
export { FileHistoryPanel } from "./FileHistoryPanel";
export { ConflictResolutionView } from "./ConflictResolutionView";
export { ThreeWayMergeEditor } from "./ThreeWayMergeEditor";
export { ConflictMarkerButtons } from "./ConflictMarkerButtons";
export { MonacoErrorBoundary } from "./MonacoErrorBoundary";
export { LoadingState } from "./LoadingState";
export type { LoadingStateProps } from "./LoadingState";

export { StashForm } from "./StashForm";
export type { StashFormProps } from "./StashForm";

export { StashDropConfirmDialog } from "./StashDropConfirmDialog";
export type { StashDropConfirmDialogProps } from "./StashDropConfirmDialog";

export { DiscardConfirmDialog } from "./DiscardConfirmDialog";
export type { DiscardConfirmDialogProps } from "./DiscardConfirmDialog";

export { UnstageConfirmDialog } from "./UnstageConfirmDialog";
export type { UnstageConfirmDialogProps } from "./UnstageConfirmDialog";

export { UnsavedChangesDialog } from "./UnsavedChangesDialog";
export type { UnsavedChangesDialogProps } from "./UnsavedChangesDialog";

export { SettingsDialog } from "./SettingsDialog";
export type { SettingsDialogProps } from "./SettingsDialog";

export { FileOverview } from "./FileOverview";
export type { FileOverviewProps } from "./FileOverview";

// =============================================================================
// Store (Public API - only expose what consumers need)
// =============================================================================
// Internal atoms (filesAtom, diffsAtom, etc.) are intentionally not exported.
// Use the provided hooks and actions instead.

export {
  // Initialization action - required to set up the store
  initializeStoreAtom,
} from "./store";

export type {
  GitStoreConfig,
  CommitEntry,
} from "./store";

// =============================================================================
// Configuration Constants
// =============================================================================

export {
  REFRESH_INTERVAL_MS,
  MIN_REFRESH_AGE_MS,
  LARGE_DIFF_LINE_THRESHOLD,
  LARGE_FOLDER_FILE_THRESHOLD,
  INITIAL_COMMITS_DEPTH,
  COMMITS_PAGE_SIZE,
  MAX_CACHED_COMMITS,
  MAX_CACHED_BLAME_ENTRIES,
  MAX_CACHED_HISTORY_ENTRIES,
  DEFAULT_EDITOR_HEIGHT,
  MIN_EDITOR_HEIGHT,
  DIFF_VIEW_STORAGE_KEY,
  DEFAULT_DIFF_VIEW_OPTIONS,
  KEYBOARD_SHORTCUTS,
} from "./constants";
