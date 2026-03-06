/**
 * React hooks for NatStack panel development.
 * Provides declarative, idiomatic React APIs for panel features.
 */

import { useState, useEffect, useMemo } from "react";
import * as runtime from "@workspace/runtime";
import { Rpc } from "@workspace/runtime";
import type { ParentHandle, ThemeAppearance } from "@workspace/runtime";

/**
 * Get the panel API object.
 * This is the same as importing from @workspace/runtime directly, but as a hook for consistency.
 *
 * @example
 * ```tsx
 * function MyPanel() {
 *   const panel = usePanel();
 *   const handleClose = () => panel.closeSelf();
 *   return <button onClick={handleClose}>Close</button>;
 * }
 * ```
 */
export function usePanel() {
  return runtime;
}

/**
 * Get the current panel's theme and subscribe to theme changes.
 *
 * @example
 * ```tsx
 * function MyPanel() {
 *   const theme = usePanelTheme();
 *   return <div>Current theme: {theme}</div>;
 * }
 * ```
 */
export function usePanelTheme(): ThemeAppearance {
  const [theme, setTheme] = useState<ThemeAppearance>(() => runtime.getTheme());

  useEffect(() => {
    const unsubscribe = runtime.onThemeChange((nextTheme) => {
      setTheme(nextTheme);
    });
    return unsubscribe;
  }, []);

  return theme;
}

/**
 * Get the panel's ID.
 * This is a static value, so it's memoized.
 *
 * @example
 * ```tsx
 * function MyPanel() {
 *   const panelId = usePanelId();
 *   return <div>My ID: {panelId}</div>;
 * }
 * ```
 */
export function usePanelId(): string {
  return runtime.id;
}

/**
 * Get the panel's context ID.
 * Context ID format: {mode}_{type}_{identifier}
 * - mode: "safe" | "unsafe" - security context
 * - type: "auto" | "named" - auto = tree-derived, named = explicit
 * - identifier: tree path or random string
 *
 * Panels/workers with the same context share filesystem and storage state.
 *
 * @example
 * ```tsx
 * function MyPanel() {
 *   const contextId = useContextId();
 *   return <div>Context: {contextId}</div>;
 * }
 * ```
 */
export function useContextId(): string {
  return runtime.contextId;
}

/**
 * Get the panel's partition name.
 *
 * @example
 * ```tsx
 * function MyPanel() {
 *   const partition = usePanelPartition();
 *   return <div>Storage partition: {partition ?? "loading..."}</div>;
 * }
 * ```
 */
export function usePanelPartition(): string | null {
  const [partition, setPartition] = useState<string | null>(null);

  useEffect(() => {
    runtime.getInfo().then((info) => setPartition(info.partition)).catch(console.error);
  }, []);

  return partition;
}

/**
 * Subscribe to global RPC events from any panel.
 *
 * @example
 * ```tsx
 * function MyPanel() {
 *   const [events, setEvents] = useState<Array<{ from: string; data: any }>>([]);
 *
 *   usePanelRpcGlobalEvent("status-update", (fromPanelId, payload) => {
 *     setEvents(prev => [...prev, { from: fromPanelId, data: payload }]);
 *   });
 *
 *   return <div>Events: {events.length}</div>;
 * }
 * ```
 */
export function usePanelRpcGlobalEvent<T = unknown>(
  eventName: string,
  handler: (fromPanelId: string, payload: T) => void
): void {
  useEffect(() => {
    const unsubscribe = runtime.rpc.onEvent(eventName, (fromPanelId, payload) => {
      handler(fromPanelId, payload as T);
    });
    return unsubscribe;
  }, [eventName, handler]);
}

// =============================================================================
// ParentHandle Hooks
// =============================================================================

/**
 * Get a typed handle for communicating with the parent panel.
 * Returns null if this panel has no parent (is root).
 *
 * @typeParam T - RPC methods the parent exposes
 * @typeParam E - RPC event map for typed events from parent
 *
 * @example
 * ```tsx
 * interface ParentApi {
 *   notifyReady(): Promise<void>;
 *   reportStatus(status: string): Promise<void>;
 * }
 *
 * function MyPanel() {
 *   const parent = usePanelParent<ParentApi>();
 *
 *   useEffect(() => {
 *     if (parent) {
 *       parent.call.notifyReady();
 *     }
 *   }, [parent]);
 *
 *   return <div>Has parent: {parent ? "Yes" : "No"}</div>;
 * }
 * ```
 */
export function usePanelParent<
  T extends Rpc.ExposedMethods = Rpc.ExposedMethods,
  E extends Rpc.RpcEventMap = Rpc.RpcEventMap
>(): ParentHandle<T, E> | null {
  // getParent() returns a cached handle, so useMemo is for React stability
  return useMemo(() => runtime.getParent<T, E>(), []);
}

/**
 * Track focus state of the panel.
 *
 * @example
 * ```tsx
 * function MyPanel() {
 *   const isFocused = usePanelFocus();
 *   return (
 *     <div style={{ opacity: isFocused ? 1 : 0.5 }}>
 *       {isFocused ? "Focused" : "Not focused"}
 *     </div>
 *   );
 * }
 * ```
 */
export function usePanelFocus(): boolean {
  const [isFocused, setIsFocused] = useState(false);

  useEffect(() => {
    const unsubscribe = runtime.onFocus(() => {
      setIsFocused(true);
    });

    // Reset focus state on blur
    const handleBlur = () => setIsFocused(false);
    window.addEventListener("blur", handleBlur);

    return () => {
      unsubscribe();
      window.removeEventListener("blur", handleBlur);
    };
  }, []);

  return isFocused;
}

// =============================================================================
// Connection Error Hook
// =============================================================================

/**
 * Subscribe to connection errors (terminal WebSocket auth failures).
 * Returns null when connected, or an error object with code and reason.
 *
 * This fires when the WS transport encounters a terminal auth failure
 * (e.g., invalid token, bad handshake). The panel is non-functional at
 * this point since all RPC goes through the WebSocket.
 *
 * @example
 * ```tsx
 * function MyPanel() {
 *   const connError = useConnectionError();
 *   if (connError) {
 *     return <div>Disconnected: {connError.reason} ({connError.code})</div>;
 *   }
 *   return <div>Panel content</div>;
 * }
 * ```
 */
export function useConnectionError(): { code: number; reason: string } | null {
  const [error, setError] = useState<{ code: number; reason: string } | null>(null);

  useEffect(() => {
    return runtime.onConnectionError((err) => {
      setError(err);
    });
  }, []);

  return error;
}
