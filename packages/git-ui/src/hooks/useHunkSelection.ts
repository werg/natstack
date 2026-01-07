import { useState, useMemo, useCallback, useEffect } from "react";
import type { HunkSelection } from "@natstack/git";

interface Hunk {
  lines: Array<{ type: string }>;
}

interface UseHunkSelectionOptions {
  hunks: Hunk[];
  diffPath: string;
}

/**
 * Hook to manage hunk and line selection for staging/unstaging partial changes.
 */
export function useHunkSelection({ hunks, diffPath }: UseHunkSelectionOptions) {
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedHunks, setSelectedHunks] = useState<Map<number, Set<number> | null>>(new Map());

  // Map each hunk to its indices of change lines (non-context lines)
  const hunkChangeIndices = useMemo(() => {
    return hunks.map((hunk) =>
      hunk.lines
        .map((line, index) => (line.type === "context" ? null : index))
        .filter((index): index is number => index !== null)
    );
  }, [hunks]);

  // Clear selections when diff changes to avoid stale line indices.
  useEffect(() => {
    setSelectedHunks(new Map());
  }, [diffPath, hunks]);

  // Clear selections when exiting selection mode
  useEffect(() => {
    if (!selectionMode) {
      setSelectedHunks(new Map());
    }
  }, [selectionMode]);

  const toggleHunkSelection = useCallback((hunkIndex: number) => {
    setSelectedHunks((prev) => {
      const next = new Map(prev);
      if (next.has(hunkIndex)) {
        next.delete(hunkIndex);
        return next;
      }
      next.set(hunkIndex, null);
      return next;
    });
  }, []);

  const toggleLineSelection = useCallback(
    (hunkIndex: number, lineIndex: number) => {
      setSelectedHunks((prev) => {
        const next = new Map(prev);
        const changeIndices = hunkChangeIndices[hunkIndex] ?? [];
        const current = next.get(hunkIndex);

        if (current === null) {
          // Hunk was fully selected, remove just this line
          const set = new Set(changeIndices);
          set.delete(lineIndex);
          if (set.size === 0) {
            next.delete(hunkIndex);
          } else if (set.size === changeIndices.length) {
            next.set(hunkIndex, null);
          } else {
            next.set(hunkIndex, set);
          }
          return next;
        }

        // Toggle line in partial selection
        const set = new Set(current ?? []);
        if (set.has(lineIndex)) {
          set.delete(lineIndex);
        } else {
          set.add(lineIndex);
        }

        if (set.size === 0) {
          next.delete(hunkIndex);
        } else if (set.size === changeIndices.length) {
          // All lines selected = full hunk selection
          next.set(hunkIndex, null);
        } else {
          next.set(hunkIndex, set);
        }
        return next;
      });
    },
    [hunkChangeIndices]
  );

  const buildSelections = useCallback((): HunkSelection[] => {
    const selections: HunkSelection[] = [];
    for (const [hunkIndex, lines] of selectedHunks.entries()) {
      if (lines === null) {
        selections.push({ hunkIndex });
      } else if (lines.size > 0) {
        selections.push({ hunkIndex, lineIndices: Array.from(lines) });
      }
    }
    return selections;
  }, [selectedHunks]);

  const clearSelections = useCallback(() => {
    setSelectedHunks(new Map());
  }, []);

  return {
    selectionMode,
    setSelectionMode,
    selectedHunks,
    hunkChangeIndices,
    toggleHunkSelection,
    toggleLineSelection,
    buildSelections,
    clearSelections,
  };
}
