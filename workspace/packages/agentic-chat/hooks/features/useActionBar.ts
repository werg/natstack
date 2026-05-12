/**
 * useActionBar — top-of-chat action bar component compilation.
 *
 * The action bar value is panel-local. Callers decide whether it came from
 * state args, a file-backed tool call, or another host-specific source.
 */

import { useEffect, useMemo, useState } from "react";
import { compileComponent } from "@workspace/eval";
import type { ActionBarData, ActionBarState, InlineUiComponentEntry } from "../../types";

interface UseActionBarOptions {
  data: ActionBarData | null;
}

export interface ActionBarHookState {
  actionBar: ActionBarState | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseActionBarData(value: unknown): ActionBarData | null {
  if (!isRecord(value)) return null;
  if (typeof value["id"] !== "string" || typeof value["code"] !== "string") return null;

  return {
    id: value["id"],
    path: typeof value["path"] === "string" ? value["path"] : undefined,
    code: value["code"],
    props: isRecord(value["props"]) ? value["props"] : undefined,
    maxHeight: typeof value["maxHeight"] === "number" && Number.isFinite(value["maxHeight"])
      ? value["maxHeight"]
      : undefined,
  };
}

export function useActionBar({ data }: UseActionBarOptions): ActionBarHookState {
  const [component, setComponent] = useState<InlineUiComponentEntry | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    if (!data) {
      setComponent(undefined);
      return () => { cancelled = true; };
    }

    setComponent(undefined);
    void (async () => {
      try {
        const result = await compileComponent<import("react").ComponentType<{ props: Record<string, unknown>; chat: Record<string, unknown>; scope: Record<string, unknown>; scopes: Record<string, unknown> }>>(data.code);
        if (cancelled) return;
        if (result.success) {
          setComponent({ Component: result.Component!, cacheKey: result.cacheKey! });
        } else {
          setComponent({ cacheKey: data.code, error: result.error });
        }
      } catch (err) {
        if (cancelled) return;
        setComponent({ cacheKey: data.code, error: err instanceof Error ? err.message : String(err) });
      }
    })();

    return () => { cancelled = true; };
  }, [data?.id, data?.code]);

  const actionBar = useMemo(() => (
    data ? { data, component } : null
  ), [data, component]);

  return { actionBar };
}
