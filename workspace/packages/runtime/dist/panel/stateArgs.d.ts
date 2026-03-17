declare global {
    interface Window {
        __natstackStateArgs?: Record<string, unknown>;
    }
}
/**
 * Internal: Set up the bridge for setStateArgs.
 * Called by createRuntime during initialization.
 */
export declare function _initStateArgsBridge(bridge: (updates: Record<string, unknown>) => Promise<Record<string, unknown>>): void;
/**
 * Get current state args (synchronous, snapshot).
 * Returns the stateArgs that were passed when the panel was created.
 */
export declare function getStateArgs<T = Record<string, unknown>>(): T;
/**
 * React hook for reactive state args access.
 * Re-renders when state args change via setStateArgs().
 */
export declare function useStateArgs<T = Record<string, unknown>>(): T;
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
export declare function setStateArgs(updates: Record<string, unknown>): Promise<void>;
//# sourceMappingURL=stateArgs.d.ts.map