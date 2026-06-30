/**
 * Data-access helpers for the Browser Migration & State panel.
 *
 * Every call goes through the `@workspace-extensions/browser-data` extension.
 * Tier-1 view methods (counts/domains/readiness) resolve without a prompt;
 * Tier-2/3 methods (reveal values, imports, deletes) trigger the approval
 * overlay and may come back denied (EACCES) or uncallable (ENOCALLER). The
 * `useAsync` hook normalizes those into explicit `denied`/`error` states so the
 * UI can render an inline "approval required" affordance instead of crashing.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { browserData } from "@workspace/panel-browser";
import { type AsyncState, classifyError } from "./format";

export { browserData };
export { classifyError, relativeTime, mask, DATA_TYPES } from "./format";
export type { AsyncState, AsyncStatus } from "./format";

/** Run `fn` whenever `deps` change; expose status + a manual `reload`. */
export function useAsync<T>(fn: () => Promise<T>, deps: ReadonlyArray<unknown>): {
  state: AsyncState<T>;
  reload: () => void;
} {
  const [state, setState] = useState<AsyncState<T>>({ status: "idle" });
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const run = useCallback(() => {
    setState((prev) => ({ status: "loading", data: prev.data }));
    fnRef.current()
      .then((data) => {
        if (alive.current) setState({ status: "ready", data });
      })
      .catch((err) => {
        if (!alive.current) return;
        const { status, message } = classifyError(err);
        setState({ status, error: message });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(run, [run]);
  return { state, reload: run };
}
