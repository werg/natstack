import { useCallback, useEffect } from "react";
import { useAtom, useAtomValue } from "jotai";
import { submitKeyConfigAtom } from "../state/uiAtoms";
import type { SubmitKeyConfig } from "../types/channel";

/**
 * Check if a keyboard event matches a submit key config.
 */
function matchesSubmitKey(event: KeyboardEvent, config: SubmitKeyConfig): boolean {
  if (event.key !== "Enter") return false;

  const hasModifier = event.shiftKey || event.ctrlKey || event.metaKey;

  switch (config.submitKey) {
    case "Enter":
      return !hasModifier;
    case "Shift+Enter":
      return event.shiftKey && !event.ctrlKey && !event.metaKey;
    case "Ctrl+Enter":
      return event.ctrlKey && !event.shiftKey && !event.metaKey;
    case "Cmd+Enter":
      return event.metaKey && !event.shiftKey && !event.ctrlKey;
    default:
      return false;
  }
}

/**
 * Check if Enter key should insert a newline.
 */
function shouldInsertNewline(event: KeyboardEvent, config: SubmitKeyConfig): boolean {
  if (event.key !== "Enter") return false;

  // If this matches submit, don't insert newline
  if (matchesSubmitKey(event, config)) return false;

  // If enter behavior is newline and no modifier, insert newline
  if (config.enterBehavior === "newline" && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
    return true;
  }

  // Otherwise, Shift+Enter typically means newline when Enter is submit
  return event.shiftKey && config.submitKey === "Enter";
}

interface KeyboardShortcutHandlers {
  onSubmit?: () => void;
  onAbort?: () => void;
  onNewChat?: () => void;
  onToggleSidebar?: () => void;
}

/**
 * Hook for keyboard shortcuts.
 */
export function useKeyboardShortcuts(handlers: KeyboardShortcutHandlers) {
  const config = useAtomValue(submitKeyConfigAtom);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Global shortcuts

      // Escape - abort generation
      if (event.key === "Escape" && handlers.onAbort) {
        handlers.onAbort();
        return;
      }

      // Cmd/Ctrl+N - new chat
      if ((event.metaKey || event.ctrlKey) && event.key === "n" && handlers.onNewChat) {
        event.preventDefault();
        handlers.onNewChat();
        return;
      }

      // Cmd/Ctrl+B - toggle sidebar
      if ((event.metaKey || event.ctrlKey) && event.key === "b" && handlers.onToggleSidebar) {
        event.preventDefault();
        handlers.onToggleSidebar();
        return;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handlers, config]);

  return {
    config,
    matchesSubmitKey: (event: KeyboardEvent) => matchesSubmitKey(event, config),
    shouldInsertNewline: (event: KeyboardEvent) => shouldInsertNewline(event, config),
  };
}

/**
 * Hook for input-specific keyboard handling.
 */
export function useInputKeyHandler(
  onSubmit: () => void,
  options?: { disabled?: boolean }
) {
  const config = useAtomValue(submitKeyConfigAtom);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (options?.disabled) return;

      if (matchesSubmitKey(event.nativeEvent, config)) {
        event.preventDefault();
        onSubmit();
      }
    },
    [config, onSubmit, options?.disabled]
  );

  return { handleKeyDown, config };
}

/**
 * Hook for getting/setting submit key config.
 */
export function useSubmitKeyConfig() {
  return useAtom(submitKeyConfigAtom);
}
