import { useState, useEffect } from "react";

// Global injected by preload via --natstack-state-args command line arg
declare global {
  interface Window {
    __natstackStateArgs?: Record<string, unknown>;
  }
}

// Internal bridge function set up by runtime initialization
// This allows setStateArgs to call main process without direct dependency on runtime
let _setStateArgsBridge: ((updates: Record<string, unknown>) => Promise<Record<string, unknown>>) | null = null;

/**
 * Internal: Set up the bridge for setStateArgs.
 * Called by createRuntime during initialization.
 */
export function _initStateArgsBridge(
  bridge: (updates: Record<string, unknown>) => Promise<Record<string, unknown>>
): void {
  _setStateArgsBridge = bridge;
}

/**
 * Get current state args (synchronous, snapshot).
 * Returns the stateArgs that were passed when the panel was created.
 */
export function getStateArgs<T = Record<string, unknown>>(): T {
  return (window.__natstackStateArgs ?? {}) as T;
}

/**
 * React hook for reactive state args access.
 * Re-renders when state args change via setStateArgs().
 */
export function useStateArgs<T = Record<string, unknown>>(): T {
  const [args, setArgs] = useState<T>(() => getStateArgs<T>());

  useEffect(() => {
    const handler = (event: CustomEvent<Record<string, unknown>>) => {
      setArgs(event.detail as T);
    };
    window.addEventListener("natstack:stateArgsChanged", handler as EventListener);
    return () => window.removeEventListener("natstack:stateArgsChanged", handler as EventListener);
  }, []);

  return args;
}

/**
 * Update state args. Validates against manifest schema, persists, and triggers re-render.
 *
 * This sends the updates to the main process which:
 * 1. Merges with current stateArgs
 * 2. Validates against manifest schema
 * 3. Updates the current snapshot
 * 4. Persists to SQLite
 * 5. Broadcasts back via IPC, triggering useStateArgs re-render
 */
export async function setStateArgs(updates: Record<string, unknown>): Promise<void> {
  if (!_setStateArgsBridge) {
    throw new Error("setStateArgs called before runtime initialization");
  }
  // RPC to main process - this validates and persists
  await _setStateArgsBridge(updates);
  // Main broadcasts back, which triggers the event listener in useStateArgs
}
