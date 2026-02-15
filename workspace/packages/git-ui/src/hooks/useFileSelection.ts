import { useState, useCallback, useEffect, useMemo } from "react";
import type { FileChange } from "../DiffBlock/types";

export interface UseFileSelectionOptions {
  files: FileChange[];
  /** External controlled selection (when provided, internal state is ignored) */
  focusedPath?: string | null;
}

export interface UseFileSelectionResult {
  selectedFiles: Set<string>;
  handleFileSelect: (path: string, event: React.MouseEvent) => void;
  clearSelection: () => void;
  selectAll: () => void;
}

/**
 * Custom hook to manage file selection state with support for:
 * - Single selection (regular click)
 * - Multi-selection (Ctrl/Cmd + click)
 * - Range selection (Shift + click)
 * - Controlled mode (via focusedPath prop)
 * - Auto-selection of first file when list changes
 */
export function useFileSelection({
  files,
  focusedPath,
}: UseFileSelectionOptions): UseFileSelectionResult {
  // Internal selection state - Set of selected file paths for multi-select
  const [uncontrolledSelection, setUncontrolledSelection] = useState<Set<string>>(new Set());
  // Track last clicked file for shift-click range selection
  const [lastClickedPath, setLastClickedPath] = useState<string | null>(null);

  // Selection: controlled (focusedPath provided) or uncontrolled (internal state)
  const selectedFiles = useMemo(() => {
    if (focusedPath !== undefined && focusedPath !== null) {
      return new Set([focusedPath]);
    }
    return uncontrolledSelection;
  }, [focusedPath, uncontrolledSelection]);

  // Auto-select first file when list changes and nothing is selected (uncontrolled mode only)
  useEffect(() => {
    // Skip if controlled by focusedPath
    if (focusedPath !== undefined && focusedPath !== null) return;

    if (files.length === 0) {
      if (uncontrolledSelection.size > 0) {
        setUncontrolledSelection(new Set());
      }
      return;
    }

    // Clean up selection: remove files that no longer exist in filtered list
    const validPaths = new Set(files.map((f) => f.path));
    const stillValid = new Set([...uncontrolledSelection].filter((p) => validPaths.has(p)));

    if (stillValid.size !== uncontrolledSelection.size) {
      // Some selections became invalid
      if (stillValid.size === 0) {
        // Auto-select first file if nothing valid remains
        setUncontrolledSelection(new Set([files[0]?.path].filter(Boolean) as string[]));
      } else {
        setUncontrolledSelection(stillValid);
      }
    } else if (uncontrolledSelection.size === 0 && files.length > 0) {
      // No selection and files exist - auto-select first
      setUncontrolledSelection(new Set([files[0]!.path]));
    }
  }, [files, uncontrolledSelection, focusedPath]);

  const handleFileSelect = useCallback(
    (path: string, event: React.MouseEvent) => {
      const isCtrlOrMeta = event.ctrlKey || event.metaKey;
      const isShift = event.shiftKey;

      setUncontrolledSelection((prev) => {
        if (isShift && lastClickedPath) {
          // Shift-click: select range from last clicked to current
          const paths = files.map((f) => f.path);
          const lastIndex = paths.indexOf(lastClickedPath);
          const currentIndex = paths.indexOf(path);
          if (lastIndex !== -1 && currentIndex !== -1) {
            const start = Math.min(lastIndex, currentIndex);
            const end = Math.max(lastIndex, currentIndex);
            const range = paths.slice(start, end + 1);
            // Add range to existing selection (or replace if no modifier)
            return new Set([...prev, ...range]);
          }
        }

        if (isCtrlOrMeta) {
          // Ctrl/Cmd-click: toggle individual file
          const next = new Set(prev);
          if (next.has(path)) {
            next.delete(path);
          } else {
            next.add(path);
          }
          return next;
        }

        // Regular click: replace selection with single file
        return new Set([path]);
      });

      setLastClickedPath(path);
    },
    [files, lastClickedPath]
  );

  const clearSelection = useCallback(() => {
    setUncontrolledSelection(new Set());
    setLastClickedPath(null);
  }, []);

  const selectAll = useCallback(() => {
    setUncontrolledSelection(new Set(files.map((f) => f.path)));
  }, [files]);

  return {
    selectedFiles,
    handleFileSelect,
    clearSelection,
    selectAll,
  };
}
