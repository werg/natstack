/**
 * Event-based editor navigation hook.
 *
 * Provides a clean way to navigate to specific positions in the editor
 * without relying on timeouts. Uses an event emitter pattern where:
 * - The parent component can queue navigation requests
 * - The EditorPanel subscribes and handles navigation when ready
 */

import { useCallback, useRef } from "react";

export interface NavigationRequest {
  line: number;
  column: number;
}

export interface UseEditorNavigationResult {
  /** Subscribe to navigation requests (call from EditorPanel) */
  subscribe: (handler: (req: NavigationRequest) => void) => () => void;
  /** Request navigation to a position */
  navigateTo: (line: number, column: number) => void;
}

/**
 * Hook for managing editor navigation events.
 *
 * This solves the problem of needing to navigate to a position in the editor
 * after the editor has been created/switched, without using fragile timeouts.
 */
export function useEditorNavigation(): UseEditorNavigationResult {
  const handlerRef = useRef<((req: NavigationRequest) => void) | null>(null);
  const pendingRef = useRef<NavigationRequest | null>(null);

  const subscribe = useCallback((handler: (req: NavigationRequest) => void) => {
    handlerRef.current = handler;

    // If there was a pending request before subscription, execute it now
    if (pendingRef.current) {
      const pending = pendingRef.current;
      pendingRef.current = null;
      handler(pending);
    }

    return () => {
      handlerRef.current = null;
    };
  }, []);

  const navigateTo = useCallback((line: number, column: number) => {
    const request: NavigationRequest = { line, column };

    if (handlerRef.current) {
      // Handler is ready, execute immediately
      handlerRef.current(request);
    } else {
      // Store as pending for when handler subscribes
      pendingRef.current = request;
    }
  }, []);

  return {
    subscribe,
    navigateTo,
  };
}
