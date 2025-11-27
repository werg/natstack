/**
 * React hooks for NatStack panel development.
 * Provides declarative, idiomatic React APIs for panel features.
 */

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  panel as panelAPI,
  type PanelTheme,
  type PanelRpcHandleOptions,
  type CreateChildOptions,
  type Rpc,
} from "@natstack/core";

/**
 * Get the panel API object.
 * This is the same as importing panelAPI directly, but as a hook for consistency.
 *
 * @example
 * ```tsx
 * function MyPanel() {
 *   const panel = usePanel();
 *   const handleClick = () => panel.setTitle("New Title");
 *   return <button onClick={handleClick}>Rename</button>;
 * }
 * ```
 */
export function usePanel() {
  return panelAPI;
}

/**
 * Get the current panel's theme and subscribe to theme changes.
 *
 * @example
 * ```tsx
 * function MyPanel() {
 *   const theme = usePanelTheme();
 *   return <div>Current theme: {theme.appearance}</div>;
 * }
 * ```
 */
export function usePanelTheme(): PanelTheme {
  const [theme, setTheme] = useState<PanelTheme>(() => panelAPI.getTheme());

  useEffect(() => {
    const unsubscribe = panelAPI.onThemeChange((nextTheme) => {
      setTheme(nextTheme);
    });
    return unsubscribe;
  }, []);

  return theme;
}

/**
 * Get the panel's environment variables.
 * Loads once on mount.
 *
 * @example
 * ```tsx
 * function MyPanel() {
 *   const env = usePanelEnv();
 *   return <div>Parent ID: {env.PARENT_ID}</div>;
 * }
 * ```
 */
export function usePanelEnv(): Record<string, string> {
  const [env, setEnv] = useState<Record<string, string>>({});

  useEffect(() => {
    panelAPI.getEnv().then(setEnv).catch(console.error);
  }, []);

  return env;
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
  return useMemo(() => panelAPI.getId(), []);
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
    panelAPI.getPartition().then(setPartition).catch(console.error);
  }, []);

  return partition;
}

/**
 * Get an RPC handle to communicate with another panel.
 * Returns a stable handle that can be used to call methods and subscribe to events.
 *
 * @example
 * ```tsx
 * interface ChildAPI {
 *   ping(): Promise<string>;
 *   getData(): Promise<{ count: number }>;
 * }
 *
 * interface ChildEvents extends Rpc.RpcEventMap {
 *   "data-changed": { value: string };
 *   "status": { ready: boolean };
 * }
 *
 * function MyPanel() {
 *   const [childId, setChildId] = useState<string | null>(null);
 *   const childHandle = usePanelRpc<ChildAPI, ChildEvents>(childId);
 *
 *   const handlePing = async () => {
 *     if (childHandle) {
 *       const response = await childHandle.call.ping();
 *       console.log(response);
 *     }
 *   };
 *
 *   // Typed event subscription
 *   useEffect(() => {
 *     if (!childHandle) return;
 *     return childHandle.on("data-changed", (payload) => {
 *       console.log(payload.value); // Fully typed!
 *     });
 *   }, [childHandle]);
 *
 *   return <button onClick={handlePing}>Ping Child</button>;
 * }
 * ```
 */
export function usePanelRpc<
  T extends Rpc.ExposedMethods = Rpc.ExposedMethods,
  E extends Rpc.RpcEventMap = Rpc.RpcEventMap
>(targetPanelId: string | null | undefined, options?: PanelRpcHandleOptions): Rpc.PanelRpcHandle<T, E> | null {
  return useMemo(() => {
    if (!targetPanelId) return null;
    return panelAPI.rpc.getHandle<T, E>(targetPanelId, options);
  }, [targetPanelId, options]);
}

/**
 * Subscribe to RPC events from a specific panel.
 *
 * @example
 * ```tsx
 * function MyPanel({ childId }: { childId: string }) {
 *   const [lastEvent, setLastEvent] = useState(null);
 *
 *   usePanelRpcEvent(childId, "data-changed", (payload) => {
 *     setLastEvent(payload);
 *   });
 *
 *   return <div>Last event: {JSON.stringify(lastEvent)}</div>;
 * }
 * ```
 */
export function usePanelRpcEvent<T = unknown>(
  targetPanelId: string | null | undefined,
  eventName: string,
  handler: (payload: T) => void
): void {
  const stableHandler = useCallback(handler, [handler]);

  useEffect(() => {
    if (!targetPanelId) return;

    const handle = panelAPI.rpc.getHandle(targetPanelId);
    const unsubscribe = handle.on(eventName, stableHandler);

    return unsubscribe;
  }, [targetPanelId, eventName, stableHandler]);
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
    const unsubscribe = panelAPI.rpc.onEvent(eventName, (fromPanelId, payload) => {
      handler(fromPanelId, payload as T);
    });
    return unsubscribe;
  }, [eventName, handler]);
}

/**
 * Manage child panels with automatic cleanup.
 *
 * @example
 * ```tsx
 * function MyPanel() {
 *   const { children, createChild, removeChild } = useChildPanels();
 *
 *   const handleAddChild = async () => {
 *     await createChild("panels/example");
 *   };
 *
 *   return (
 *     <div>
 *       <button onClick={handleAddChild}>Add Child</button>
 *       <ul>
 *         {children.map(id => (
 *           <li key={id}>
 *             {id}
 *             <button onClick={() => removeChild(id)}>Remove</button>
 *           </li>
 *         ))}
 *       </ul>
 *     </div>
 *   );
 * }
 * ```
 */
export function useChildPanels() {
  const [children, setChildren] = useState<string[]>([]);

  const createChild = useCallback(
    async (path: string, options?: CreateChildOptions): Promise<string> => {
      const childId = await panelAPI.createChild(path, options);
      setChildren((prev) => [...prev, childId]);
      return childId;
    },
    []
  );

  const removeChild = useCallback(async (childId: string): Promise<void> => {
    await panelAPI.removeChild(childId);
    setChildren((prev) => prev.filter((id) => id !== childId));
  }, []);

  // Listen for child removal events from the system
  useEffect(() => {
    const unsubscribe = panelAPI.onChildRemoved((childId) => {
      setChildren((prev) => prev.filter((id) => id !== childId));
    });
    return unsubscribe;
  }, []);

  return {
    children,
    createChild,
    removeChild,
  };
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
    const unsubscribe = panelAPI.onFocus(() => {
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
