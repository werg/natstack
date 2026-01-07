import { useState, useEffect, useCallback } from "react";
import type { DiffViewOptions } from "../DiffBlock/types";
import { DIFF_VIEW_STORAGE_KEY, DEFAULT_DIFF_VIEW_OPTIONS } from "../constants";

/**
 * Hook to manage diff view options with localStorage persistence.
 * Options are automatically saved when changed and restored on mount.
 */
export function useDiffViewOptions(): [DiffViewOptions, (next: DiffViewOptions) => void] {
  const [options, setOptionsState] = useState<DiffViewOptions>(() => {
    // Try to load from localStorage on initial mount
    if (typeof window === "undefined" || !window.localStorage) {
      return DEFAULT_DIFF_VIEW_OPTIONS;
    }

    try {
      const stored = localStorage.getItem(DIFF_VIEW_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as Partial<DiffViewOptions>;
        // Merge with defaults to handle missing/new fields
        return {
          viewMode: parsed.viewMode ?? DEFAULT_DIFF_VIEW_OPTIONS.viewMode,
          wordDiff: parsed.wordDiff ?? DEFAULT_DIFF_VIEW_OPTIONS.wordDiff,
          showWhitespace: parsed.showWhitespace ?? DEFAULT_DIFF_VIEW_OPTIONS.showWhitespace,
          contextLines: parsed.contextLines ?? DEFAULT_DIFF_VIEW_OPTIONS.contextLines,
        };
      }
    } catch {
      // Ignore parse errors, use defaults
    }

    return DEFAULT_DIFF_VIEW_OPTIONS;
  });

  // Save to localStorage when options change
  const setOptions = useCallback((next: DiffViewOptions) => {
    setOptionsState(next);

    if (typeof window !== "undefined" && window.localStorage) {
      try {
        localStorage.setItem(DIFF_VIEW_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Ignore storage errors (e.g., quota exceeded)
      }
    }
  }, []);

  // Listen for storage events from other tabs
  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleStorage = (e: StorageEvent) => {
      if (e.key === DIFF_VIEW_STORAGE_KEY && e.newValue) {
        try {
          const parsed = JSON.parse(e.newValue) as DiffViewOptions;
          setOptionsState(parsed);
        } catch {
          // Ignore parse errors
        }
      }
    };

    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  return [options, setOptions];
}
