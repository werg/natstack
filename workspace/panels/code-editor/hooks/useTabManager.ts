/**
 * Tab management hook for the code editor.
 *
 * Manages open tabs, tracks modifications, and stores cursor/scroll
 * positions for each tab.
 *
 * Uses useReducer to ensure atomic state updates and avoid race conditions
 * when tabs are opened/closed rapidly.
 */

import { useReducer, useCallback, useMemo } from "react";
import type { Tab } from "../types";

export interface UseTabManagerResult {
  /** All open tabs */
  tabs: Tab[];
  /** ID of the active tab */
  activeTabId: string | null;
  /** The currently active tab */
  activeTab: Tab | null;
  /** File path of the active tab */
  activeFilePath: string | null;
  /** Open a file in a new tab or switch to existing */
  openTab: (filePath: string, content: string) => void;
  /** Close a tab by ID */
  closeTab: (tabId: string) => void;
  /** Set the active tab */
  setActiveTab: (tabId: string) => void;
  /** Update tab content */
  updateContent: (tabId: string, content: string) => void;
  /** Mark a tab as saved */
  markSaved: (tabId: string) => void;
  /** Update cursor position for a tab */
  updateCursorPosition: (tabId: string, lineNumber: number, column: number) => void;
  /** Update scroll position for a tab */
  updateScrollTop: (tabId: string, scrollTop: number) => void;
  /** Check if any tabs have unsaved changes */
  hasUnsavedChanges: boolean;
}

/**
 * Extract file name from path.
 */
function getFileName(filePath: string): string {
  const parts = filePath.split("/");
  return parts[parts.length - 1] || filePath;
}

/**
 * Generate a unique tab ID.
 */
function generateTabId(): string {
  return `tab-${crypto.randomUUID().slice(0, 8)}`;
}

// =============================================================================
// Reducer State and Actions
// =============================================================================

interface TabManagerState {
  tabs: Tab[];
  activeTabId: string | null;
}

type TabManagerAction =
  | { type: "OPEN_TAB"; filePath: string; content: string }
  | { type: "CLOSE_TAB"; tabId: string }
  | { type: "SET_ACTIVE_TAB"; tabId: string }
  | { type: "UPDATE_CONTENT"; tabId: string; content: string }
  | { type: "MARK_SAVED"; tabId: string }
  | { type: "UPDATE_CURSOR"; tabId: string; lineNumber: number; column: number }
  | { type: "UPDATE_SCROLL"; tabId: string; scrollTop: number };

function tabManagerReducer(state: TabManagerState, action: TabManagerAction): TabManagerState {
  switch (action.type) {
    case "OPEN_TAB": {
      const existing = state.tabs.find((t) => t.filePath === action.filePath);
      if (existing) {
        // File already open - just switch to it
        return { ...state, activeTabId: existing.id };
      }

      // Create new tab
      const newTab: Tab = {
        id: generateTabId(),
        filePath: action.filePath,
        fileName: getFileName(action.filePath),
        content: action.content,
        savedContent: action.content,
        cursorPosition: { lineNumber: 1, column: 1 },
        scrollTop: 0,
        isModified: false,
      };

      return {
        tabs: [...state.tabs, newTab],
        activeTabId: newTab.id,
      };
    }

    case "CLOSE_TAB": {
      const index = state.tabs.findIndex((t) => t.id === action.tabId);
      if (index === -1) return state;

      const nextTabs = state.tabs.filter((t) => t.id !== action.tabId);

      // Determine new active tab
      let nextActiveId = state.activeTabId;
      if (state.activeTabId === action.tabId) {
        if (nextTabs.length === 0) {
          nextActiveId = null;
        } else {
          // Select the tab to the left, or the first tab if closing the leftmost
          const newIndex = Math.min(index, nextTabs.length - 1);
          nextActiveId = nextTabs[newIndex]?.id ?? null;
        }
      }

      return { tabs: nextTabs, activeTabId: nextActiveId };
    }

    case "SET_ACTIVE_TAB":
      return { ...state, activeTabId: action.tabId };

    case "UPDATE_CONTENT":
      return {
        ...state,
        tabs: state.tabs.map((t) =>
          t.id !== action.tabId
            ? t
            : { ...t, content: action.content, isModified: action.content !== t.savedContent }
        ),
      };

    case "MARK_SAVED":
      return {
        ...state,
        tabs: state.tabs.map((t) =>
          t.id !== action.tabId
            ? t
            : { ...t, savedContent: t.content, isModified: false }
        ),
      };

    case "UPDATE_CURSOR":
      return {
        ...state,
        tabs: state.tabs.map((t) =>
          t.id !== action.tabId
            ? t
            : { ...t, cursorPosition: { lineNumber: action.lineNumber, column: action.column } }
        ),
      };

    case "UPDATE_SCROLL":
      return {
        ...state,
        tabs: state.tabs.map((t) =>
          t.id !== action.tabId
            ? t
            : { ...t, scrollTop: action.scrollTop }
        ),
      };

    default:
      return state;
  }
}

const initialState: TabManagerState = {
  tabs: [],
  activeTabId: null,
};

/**
 * Hook for managing editor tabs.
 */
export function useTabManager(): UseTabManagerResult {
  const [state, dispatch] = useReducer(tabManagerReducer, initialState);

  const activeTab = useMemo(() => {
    return state.tabs.find((t) => t.id === state.activeTabId) ?? null;
  }, [state.tabs, state.activeTabId]);

  const activeFilePath = activeTab?.filePath ?? null;

  const hasUnsavedChanges = useMemo(() => {
    return state.tabs.some((t) => t.isModified);
  }, [state.tabs]);

  const openTab = useCallback((filePath: string, content: string) => {
    dispatch({ type: "OPEN_TAB", filePath, content });
  }, []);

  const closeTab = useCallback((tabId: string) => {
    dispatch({ type: "CLOSE_TAB", tabId });
  }, []);

  const setActiveTab = useCallback((tabId: string) => {
    dispatch({ type: "SET_ACTIVE_TAB", tabId });
  }, []);

  const updateContent = useCallback((tabId: string, content: string) => {
    dispatch({ type: "UPDATE_CONTENT", tabId, content });
  }, []);

  const markSaved = useCallback((tabId: string) => {
    dispatch({ type: "MARK_SAVED", tabId });
  }, []);

  const updateCursorPosition = useCallback((tabId: string, lineNumber: number, column: number) => {
    dispatch({ type: "UPDATE_CURSOR", tabId, lineNumber, column });
  }, []);

  const updateScrollTop = useCallback((tabId: string, scrollTop: number) => {
    dispatch({ type: "UPDATE_SCROLL", tabId, scrollTop });
  }, []);

  return {
    tabs: state.tabs,
    activeTabId: state.activeTabId,
    activeTab,
    activeFilePath,
    openTab,
    closeTab,
    setActiveTab,
    updateContent,
    markSaved,
    updateCursorPosition,
    updateScrollTop,
    hasUnsavedChanges,
  };
}
