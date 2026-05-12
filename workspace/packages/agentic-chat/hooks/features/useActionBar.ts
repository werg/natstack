/**
 * useActionBar — top-of-chat action bar component compilation.
 *
 * The action bar value is panel-local. Callers decide whether it came from
 * state args, a file-backed tool call, or another host-specific source.
 */

import { useEffect, useMemo, useState } from "react";
import { compileComponent } from "@workspace/eval";
import type { LoadSourceFile, SandboxOptions } from "@workspace/eval";
import type { ActionBarData, ActionBarState, InlineUiComponentEntry } from "../../types";

interface UseActionBarOptions {
  data: ActionBarData | null;
  loadSourceFile?: LoadSourceFile;
  loadImport?: SandboxOptions["loadImport"];
}

export interface ActionBarHookState {
  actionBar: ActionBarState | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseActionBarData(value: unknown): ActionBarData | null {
  if (!isRecord(value)) return null;
  if (typeof value["id"] !== "string") return null;
  const source = value["source"];
  let parsedSource: ActionBarData["source"] | null = null;
  if (isRecord(source) && source["type"] === "code" && typeof source["code"] === "string") {
    parsedSource = { type: "code", code: source["code"] };
  } else if (isRecord(source) && source["type"] === "file" && typeof source["path"] === "string") {
    parsedSource = { type: "file", path: source["path"] };
  } else if (typeof value["code"] === "string") {
    parsedSource = { type: "code", code: value["code"] };
  } else if (typeof value["path"] === "string") {
    parsedSource = { type: "file", path: value["path"] };
  }
  if (!parsedSource) return null;

  return {
    id: value["id"],
    source: parsedSource,
    imports: isRecord(value["imports"])
      ? Object.fromEntries(Object.entries(value["imports"]).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
      : undefined,
    props: isRecord(value["props"]) ? value["props"] : undefined,
    maxHeight: typeof value["maxHeight"] === "number" && Number.isFinite(value["maxHeight"])
      ? value["maxHeight"]
      : undefined,
  };
}

export function useActionBar({ data, loadSourceFile, loadImport }: UseActionBarOptions): ActionBarHookState {
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
        const sourceCode = data.source.type === "file"
          ? await loadSourceFile?.(data.source.path)
          : data.source.code;
        if (!sourceCode) throw new Error(`Unable to load action bar source for ${data.id}`);
        const sourcePath = data.source.type === "file" ? data.source.path : undefined;
        const result = await compileComponent<import("react").ComponentType<{ props: Record<string, unknown>; chat: Record<string, unknown>; scope: Record<string, unknown>; scopes: Record<string, unknown> }>>(sourceCode, {
          imports: data.imports,
          sourcePath,
          loadSourceFile,
          loadImport,
        });
        if (cancelled) return;
        if (result.success) {
          setComponent({ Component: result.Component!, cacheKey: result.cacheKey! });
        } else {
          setComponent({ cacheKey: sourceCode, error: result.error });
        }
      } catch (err) {
        if (cancelled) return;
        setComponent({ cacheKey: data.id, error: err instanceof Error ? err.message : String(err) });
      }
    })();

    return () => { cancelled = true; };
  }, [data?.id, data?.source, loadSourceFile, loadImport]);

  const actionBar = useMemo(() => (
    data ? { data, component } : null
  ), [data, component]);

  return { actionBar };
}
