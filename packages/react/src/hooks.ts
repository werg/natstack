/**
 * React hooks for NatStack panel development.
 * Provides declarative, idiomatic React APIs for panel features.
 */

import { useState, useEffect, useCallback, useMemo } from "react";
import * as runtime from "@natstack/runtime";
import { Rpc } from "@natstack/runtime";
import type { CreateChildOptions, ChildHandle, ParentHandle, ThemeAppearance, BootstrapResult } from "@natstack/runtime";

/**
 * Get the panel API object.
 * This is the same as importing from @natstack/runtime directly, but as a hook for consistency.
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
 * Panels/workers with the same context share OPFS state.
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

// =============================================================================
// ChildHandle Hooks
// =============================================================================

/**
 * Manage child panels.
 * Returns ChildHandles for unified interaction with children.
 * Note: Panels cannot be closed/removed - they are permanent history.
 *
 * @example
 * ```tsx
 * interface EditorApi {
 *   openFile(path: string): Promise<void>;
 * }
 *
 * function MyPanel() {
 *   const { children, createChild } = useChildPanels();
 *
 *   const handleAddChild = async () => {
 *     const editor = await createChild<EditorApi>({
 *       type: 'app',
 *       name: 'editor',
 *       source: 'panels/editor',
 *     });
 *     await editor.call.openFile('/foo.txt');
 *   };
 *
 *   return (
 *     <div>
 *       <button onClick={handleAddChild}>Add Child</button>
 *       <ul>
 *         {children.map(handle => (
 *           <li key={handle.id}>
 *             {handle.name} ({handle.type})
 *           </li>
 *         ))}
 *       </ul>
 *     </div>
 *   );
 * }
 * ```
 */
export function useChildPanels() {
  const [children, setChildren] = useState<ChildHandle[]>([]);

  const createChild = useCallback(async <
    T extends Rpc.ExposedMethods = Rpc.ExposedMethods,
    E extends Rpc.RpcEventMap = Rpc.RpcEventMap
  >(source: string, options?: CreateChildOptions): Promise<ChildHandle<T, E>> => {
    const handle = await runtime.createChild<T, E>(source, options);
    setChildren((prev) => [...prev, handle as ChildHandle]);
    return handle;
  }, []);

  const createBrowserChild = useCallback(async <
    T extends Rpc.ExposedMethods = Rpc.ExposedMethods,
    E extends Rpc.RpcEventMap = Rpc.RpcEventMap
  >(url: string): Promise<ChildHandle<T, E>> => {
    const handle = await runtime.createBrowserChild<T, E>(url);
    setChildren((prev) => [...prev, handle as ChildHandle]);
    return handle;
  }, []);

  return {
    children,
    createChild,
    createBrowserChild,
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
// ChildHandle Hooks
// =============================================================================

/**
 * Get a child handle by name with automatic updates.
 * Returns undefined if the child doesn't exist.
 *
 * @typeParam T - RPC methods the child exposes
 * @typeParam E - RPC event map for typed events
 * @param name - The child's name (as provided in createChild spec)
 * @returns ChildHandle or undefined if not found
 *
 * @example
 * ```tsx
 * interface EditorApi {
 *   openFile(path: string): Promise<void>;
 *   getContent(): Promise<string>;
 * }
 *
 * function MyPanel() {
 *   const editor = usePanelChild<EditorApi>("editor");
 *
 *   const handleOpen = async () => {
 *     if (editor) {
 *       await editor.call.openFile("/foo.txt");
 *     }
 *   };
 *
 *   return (
 *     <div>
 *       <button onClick={handleOpen} disabled={!editor}>
 *         Open File
 *       </button>
 *     </div>
 *   );
 * }
 * ```
 */
export function usePanelChild<
  T extends Rpc.ExposedMethods = Rpc.ExposedMethods,
  E extends Rpc.RpcEventMap = Rpc.RpcEventMap
>(name: string): ChildHandle<T, E> | undefined {
  const [handle, setHandle] = useState<ChildHandle<T, E> | undefined>(() =>
    runtime.getChild<T, E>(name)
  );

  useEffect(() => {
    // Check if it already exists
    const existing = runtime.getChild<T, E>(name);
    if (existing) {
      setHandle(existing);
    }

    // Subscribe to child added events
    const unsubAdded = runtime.onChildAdded((addedName, addedHandle) => {
      if (addedName === name) {
        setHandle(addedHandle as ChildHandle<T, E>);
      }
    });

    // Subscribe to child removed events (children can be closed/removed)
    const unsubRemoved = runtime.onChildRemoved((removedName) => {
      if (removedName === name) {
        setHandle(undefined);
      }
    });

    return () => {
      unsubAdded();
      unsubRemoved();
    };
  }, [name]);

  return handle;
}

/**
 * Get all children as a Map with automatic updates.
 * Useful for rendering a list of children or iterating over them.
 *
 * Note: Children can be closed/removed. The map updates automatically.
 *
 * @returns ReadonlyMap of child names to ChildHandles
 *
 * @example
 * ```tsx
 * function MyPanel() {
 *   const children = usePanelChildren();
 *
 *   return (
 *     <ul>
 *       {[...children.entries()].map(([name, handle]) => (
 *         <li key={handle.id}>
 *           {name} ({handle.type}) - {handle.title}
 *         </li>
 *       ))}
 *     </ul>
 *   );
 * }
 * ```
 */
export function usePanelChildren(): ReadonlyMap<string, ChildHandle> {
  const [children, setChildren] = useState<ReadonlyMap<string, ChildHandle>>(
    () => new Map(runtime.children)
  );

  useEffect(() => {
    // Sync initial state
    setChildren(new Map(runtime.children));

    // Subscribe to child added events
    const unsubAdded = runtime.onChildAdded(() => {
      setChildren(new Map(runtime.children));
    });

    // Subscribe to child removed events (children can be closed/removed)
    const unsubRemoved = runtime.onChildRemoved(() => {
      setChildren(new Map(runtime.children));
    });

    return () => {
      unsubAdded();
      unsubRemoved();
    };
  }, []);

  return children;
}

/**
 * Create a child panel on first mount.
 * The child is created when the hook is first called.
 *
 * Note: Panels are permanent history and persist across component unmounts.
 * The handle is set to null on unmount to prevent state updates, but the
 * panel itself remains in the tree.
 *
 * @typeParam T - RPC methods the child exposes
 * @typeParam E - RPC event map for typed events
 * @param spec - Child specification (or null to skip creation)
 * @returns ChildHandle or null while loading/if spec is null
 *
 * @example
 * ```tsx
 * interface WorkerApi {
 *   compute(data: number[]): Promise<number>;
 * }
 *
 * function MyPanel() {
 *   const worker = usePanelCreateChild<WorkerApi>({
 *     type: "worker",
 *     name: "compute-worker",
 *     source: "workers/compute",
 *   });
 *
 *   const handleCompute = async () => {
 *     if (worker) {
 *       const result = await worker.call.compute([1, 2, 3]);
 *       console.log("Result:", result);
 *     }
 *   };
 *
 *   return <button onClick={handleCompute}>Compute</button>;
 * }
 * ```
 */
export function usePanelCreateChild<
  T extends Rpc.ExposedMethods = Rpc.ExposedMethods,
  E extends Rpc.RpcEventMap = Rpc.RpcEventMap
  >(
  spec:
    | null
    | { kind: "browser"; url: string }
    | { kind?: "appOrWorker"; source: string; options?: CreateChildOptions }
): ChildHandle<T, E> | null {
  const [handle, setHandle] = useState<ChildHandle<T, E> | null>(null);

  useEffect(() => {
    if (!spec) {
      setHandle(null);
      return;
    }

    let mounted = true;

    const createPromise =
      spec.kind === "browser"
        ? runtime.createBrowserChild<T, E>(spec.url)
        : runtime.createChild<T, E>(spec.source, spec.options);

    createPromise.then((h) => {
      if (mounted) {
        setHandle(h);
      }
      // Note: Panels are permanent history - no cleanup on unmount
    }).catch((error) => {
      console.error("[usePanelCreateChild] Failed to create child:", error);
    });

    return () => {
      mounted = false;
      // Note: Panels are permanent history - no cleanup on unmount
    };
  // We intentionally only run this once on mount
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return handle;
}

// =============================================================================
// Bootstrap Hooks
// =============================================================================

export interface BootstrapState {
  /** Whether bootstrap is still in progress */
  loading: boolean;
  /** Bootstrap result (null if still loading or no bootstrap needed) */
  result: BootstrapResult | null;
  /** Error message if bootstrap failed */
  error: string | null;
}

/**
 * Subscribe to bootstrap state.
 * Returns loading/result/error states for the bootstrap process.
 *
 * Bootstrap clones repoArgs repositories before panel code runs.
 * This hook allows panels to show loading UI while bootstrap completes.
 *
 * @returns BootstrapState with loading, result, and error fields
 *
 * @example
 * ```tsx
 * function MyPanel() {
 *   const bootstrap = useBootstrap();
 *
 *   if (bootstrap.loading) {
 *     return <div>Cloning repositories...</div>;
 *   }
 *
 *   if (bootstrap.error) {
 *     return <div>Bootstrap failed: {bootstrap.error}</div>;
 *   }
 *
 *   // Bootstrap complete - can now access cloned repos
 *   return <div>Ready! Source at {bootstrap.result?.sourcePath}</div>;
 * }
 * ```
 */
export function useBootstrap(): BootstrapState {
  const [state, setState] = useState<BootstrapState>(() => ({
    loading: true,
    result: null,
    error: null,
  }));

  useEffect(() => {
    let mounted = true;

    const promise = runtime.bootstrapPromise;
    if (!promise) {
      // No bootstrap needed
      setState({ loading: false, result: null, error: null });
      return;
    }

    promise
      .then((result: BootstrapResult | null) => {
        if (mounted) {
          setState({ loading: false, result, error: null });
        }
      })
      .catch((err: unknown) => {
        if (mounted) {
          const message = err instanceof Error ? err.message : String(err);
          setState({ loading: false, result: null, error: message });
        }
      });

    return () => {
      mounted = false;
    };
  }, []);

  return state;
}

/**
 * Get the bootstrap promise for direct awaiting.
 * Useful for imperative code that needs to wait for bootstrap.
 *
 * @returns Promise that resolves to BootstrapResult or null
 *
 * @example
 * ```tsx
 * async function initializeApp() {
 *   const bootstrap = await getBootstrapPromise();
 *   if (bootstrap?.success) {
 *     console.log("Source at:", bootstrap.sourcePath);
 *   }
 * }
 * ```
 */
export function getBootstrapPromise(): Promise<BootstrapResult | null> {
  return runtime.bootstrapPromise ?? Promise.resolve(null);
}

// Suspense support for bootstrap
let bootstrapSuspensePromise: Promise<BootstrapResult | null> | null = null;
let bootstrapSuspenseResult: BootstrapResult | null = null;
let bootstrapSuspenseError: unknown = null;
let bootstrapSuspenseStatus: "pending" | "fulfilled" | "rejected" = "pending";

function getBootstrapSuspense(): BootstrapResult | null {
  if (bootstrapSuspenseStatus === "fulfilled") {
    return bootstrapSuspenseResult;
  }
  if (bootstrapSuspenseStatus === "rejected") {
    throw bootstrapSuspenseError;
  }

  if (!bootstrapSuspensePromise) {
    const promise = runtime.bootstrapPromise;
    if (!promise) {
      bootstrapSuspenseStatus = "fulfilled";
      bootstrapSuspenseResult = null;
      return null;
    }

    bootstrapSuspensePromise = promise
      .then((result: BootstrapResult | null) => {
        bootstrapSuspenseStatus = "fulfilled";
        bootstrapSuspenseResult = result;
        return result;
      })
      .catch((err: unknown) => {
        bootstrapSuspenseStatus = "rejected";
        bootstrapSuspenseError = err;
        throw err;
      });
  }

  throw bootstrapSuspensePromise;
}

/**
 * Hook for use inside a Suspense boundary that waits for bootstrap.
 * Throws a promise while loading (for Suspense) or an error if bootstrap failed.
 *
 * @returns BootstrapResult or null if no bootstrap was needed
 * @throws Promise while bootstrap is in progress (for Suspense)
 * @throws Error if bootstrap failed
 *
 * @example
 * ```tsx
 * function BootstrappedContent() {
 *   const bootstrap = useBootstrapSuspense();
 *   return <div>Source at: {bootstrap?.sourcePath ?? "N/A"}</div>;
 * }
 *
 * function MyPanel() {
 *   return (
 *     <Suspense fallback={<div>Loading repos...</div>}>
 *       <BootstrappedContent />
 *     </Suspense>
 *   );
 * }
 * ```
 */
export function useBootstrapSuspense(): BootstrapResult | null {
  return getBootstrapSuspense();
}
