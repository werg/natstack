/**
 * Git UI custom hooks
 *
 * These hooks use local state for simplicity. They read gitClient config
 * from the global Jotai store but manage their own loading/error/data state.
 */

export { useFileBlame } from "./useFileBlame";
export { useFileHistory } from "./useFileHistory";
export { useDiffViewOptions } from "./useDiffViewOptions";
export { useHunkSelection } from "./useHunkSelection";
export { useKeyboardNavigation } from "./useKeyboardNavigation";
export type { UseKeyboardNavigationOptions } from "./useKeyboardNavigation";
export { useConflicts } from "./useConflicts";
export { useGitBranches } from "./useGitBranches";
export { useGitRemote } from "./useGitRemote";
