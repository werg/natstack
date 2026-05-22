/**
 * `useDocState(key, initial)` — the component-facing entry point for
 * persisting state into the active doc's frontmatter `state:` block.
 *
 * API mirrors `useState`:
 *
 *     const [count, setCount] = useDocState("count", 0);
 *
 * Reads come from the active doc's parsed `state.<key>` value (or
 * `initial` if absent). Writes update the in-memory map immediately
 * (so other consumers re-render via React context) and are merged
 * back into the doc's frontmatter after a short debounce by
 * `DocumentEditor`.
 *
 * Functional updates (`setCount(n => n + 1)`) are resolved by the
 * provider against the LATEST state map, so chained calls within the
 * same tick (or in callbacks) behave like `useState` rather than
 * collapsing to the render-time value.
 *
 * Fallback behavior: outside a `DocStateContext.Provider` (e.g. when
 * this MDX is rendered by the chat panel's `inline_ui`), the hook
 * degrades to plain `React.useState` — ephemeral, but the component
 * still works.
 */

import { createContext, useCallback, useContext, useState } from "react";

export type DocStateUpdate = unknown | ((prev: unknown) => unknown);

export interface DocStateContextValue {
  /** Current state map. */
  state: Record<string, unknown>;
  /**
   * Schedule an update. `value` may be a function `(prev) => next`,
   * which the provider resolves against the LATEST state map so that
   * multiple setter calls in the same tick compose correctly.
   */
  setState: (key: string, value: DocStateUpdate) => void;
}

export const DocStateContext = createContext<DocStateContextValue | null>(null);

export type Setter<T> = (next: T | ((prev: T) => T)) => void;

export function useDocState<T>(key: string, initial: T): [T, Setter<T>] {
  const ctx = useContext(DocStateContext);
  // Always invoke useState so the hook call order is stable across
  // renders regardless of whether a Provider is mounted.
  const [local, setLocal] = useState<T>(initial);

  const ctxSetState = ctx?.setState;
  const stored = ctx ? ctx.state[key] : undefined;
  const value = (stored === undefined ? (ctx ? initial : local) : (stored as T));

  const setValue = useCallback<Setter<T>>(
    (next) => {
      if (!ctxSetState) {
        setLocal(next as never);
        return;
      }
      // Forward functional updates verbatim so the provider can resolve
      // them against the LATEST state map. Calling `next(value)` here
      // would capture the render-time `value` and break chained
      // updates within a single tick.
      if (typeof next === "function") {
        const fn = next as (prev: T) => T;
        ctxSetState(key, (prev: unknown) => fn(
          prev === undefined ? initial : (prev as T),
        ));
      } else {
        ctxSetState(key, next);
      }
    },
    [ctxSetState, key, initial],
  );

  return [value, setValue];
}
