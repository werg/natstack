import { useEffect, useCallback, RefObject } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import {
  focusedSectionAtom,
  focusedIndexAtom,
  stagedFilesAtom,
  unstagedFilesAtom,
  pollingPausedAtom,
  moveFocusUpAtom,
  moveFocusDownAtom,
  toggleFocusedSectionAtom,
  discardPathAtom,
} from "../store";
import type { GitNotification } from "../store";

export interface UseKeyboardNavigationOptions {
  containerRef: RefObject<HTMLDivElement | null>;
  onStageFile: (path: string) => void;
  onUnstageFile: (path: string) => void;
  onFocusCommit?: () => void;
  onNotify?: (notification: GitNotification) => void;
}

/**
 * Hook to handle keyboard navigation for the Git status view
 */
export function useKeyboardNavigation({
  containerRef,
  onStageFile,
  onUnstageFile,
  onFocusCommit,
  onNotify,
}: UseKeyboardNavigationOptions) {
  const focusedSection = useAtomValue(focusedSectionAtom);
  const focusedIndex = useAtomValue(focusedIndexAtom);
  const stagedFiles = useAtomValue(stagedFilesAtom);
  const unstagedFiles = useAtomValue(unstagedFilesAtom);
  const pollingPaused = useAtomValue(pollingPausedAtom);

  const moveFocusUp = useSetAtom(moveFocusUpAtom);
  const moveFocusDown = useSetAtom(moveFocusDownAtom);
  const toggleFocusedSection = useSetAtom(toggleFocusedSectionAtom);
  const setDiscardPath = useSetAtom(discardPathAtom);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Don't handle if focus is in an input/textarea
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }
      // Don't steal keys from Monaco editor or contenteditable elements
      const target = e.target as HTMLElement | null;
      if (
        target?.closest(".monaco-editor") ||
        target?.closest("[contenteditable='true']")
      ) {
        return;
      }
      // Don't handle shortcuts when dialogs are open
      if (pollingPaused) {
        return;
      }
      // Ignore modified keystrokes (keep browser/app shortcuts working)
      if (e.metaKey || e.ctrlKey || e.altKey) {
        return;
      }

      const files =
        focusedSection === "unstaged" ? unstagedFiles : stagedFiles;
      // Clamp index to valid range
      const clampedIndex = files.length === 0 ? 0 : Math.min(focusedIndex, files.length - 1);
      const focusedFile = files[clampedIndex];

      switch (e.key) {
        case "j":
        case "ArrowDown":
          e.preventDefault();
          if (files.length > 0) {
            moveFocusDown();
          }
          break;
        case "k":
        case "ArrowUp":
          e.preventDefault();
          if (files.length > 0) {
            moveFocusUp();
          }
          break;
        case "s":
          e.preventDefault();
          if (focusedSection === "unstaged" && focusedFile) {
            onStageFile(focusedFile.path);
          } else if (focusedSection === "staged") {
            onNotify?.({
              type: "info",
              title: "File already staged",
              description: "Use 'u' to unstage",
            });
          }
          break;
        case "u":
          e.preventDefault();
          if (focusedSection === "staged" && focusedFile) {
            onUnstageFile(focusedFile.path);
          } else if (focusedSection === "unstaged") {
            onNotify?.({
              type: "info",
              title: "File not staged",
              description: "Use 's' to stage",
            });
          }
          break;
        case "d":
          e.preventDefault();
          if (focusedSection === "unstaged" && focusedFile) {
            setDiscardPath(focusedFile.path);
          } else if (focusedSection === "staged") {
            onNotify?.({
              type: "info",
              title: "Cannot discard staged file",
              description: "Unstage first with 'u'",
            });
          }
          break;
        case "c":
          e.preventDefault();
          onFocusCommit?.();
          if (stagedFiles.length === 0) {
            onNotify?.({
              type: "info",
              title: "Nothing to commit",
              description: "Stage changes first",
            });
          }
          break;
        case "`":
          e.preventDefault();
          toggleFocusedSection();
          break;
      }
    },
    [
      focusedSection,
      focusedIndex,
      unstagedFiles,
      stagedFiles,
      onStageFile,
      onUnstageFile,
      pollingPaused,
      onFocusCommit,
      onNotify,
      moveFocusUp,
      moveFocusDown,
      toggleFocusedSection,
      setDiscardPath,
    ]
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    container.addEventListener("keydown", handleKeyDown);
    return () => container.removeEventListener("keydown", handleKeyDown);
  }, [containerRef, handleKeyDown]);
}
