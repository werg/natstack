/**
 * Feedback Component Compilation
 *
 * Compiles TSX code into React components for custom feedback UIs.
 * Uses @natstack/eval for transformation and execution.
 */

import { useCallback, useMemo, useRef } from "react";
import type { ComponentType } from "react";
import { transformCode, executeDefault, preloadRequires } from "@natstack/eval";
import type { FeedbackComponentProps, FeedbackUiToolArgs, FeedbackUiToolResult } from "../types";

/**
 * Execute and extract the default export as a React component.
 * This is a thin wrapper around executeDefault with React typing.
 */
function executeComponent(code: string): ComponentType<FeedbackComponentProps> {
  return executeDefault<ComponentType<FeedbackComponentProps>>(code);
}

/**
 * Cache for compiled components, keyed by transformed code.
 * This prevents re-compilation on re-renders while ensuring different code produces different components.
 * Cache entries are cleaned up via cleanupFeedbackComponent() after feedback completion.
 */
const componentCache = new Map<string, ComponentType<FeedbackComponentProps>>();

/**
 * Clean up a cached component after the feedback process completes.
 * Call this when the feedback UI is dismissed or resolved.
 */
export function cleanupFeedbackComponent(cacheKey: string): void {
  componentCache.delete(cacheKey);
}

/**
 * Compile a feedback UI component from TSX code.
 * Asynchronously preloads required modules (including dynamic loading from CDN if needed).
 */
export async function compileFeedbackComponent(args: FeedbackUiToolArgs): Promise<FeedbackUiToolResult> {
  const { code } = args;

  try {
    const transformed = transformCode(code, { syntax: "tsx" });

    // Preload all required modules (async - may load from CDN if not pre-bundled)
    const preloadResult = await preloadRequires(transformed.requires);
    if (!preloadResult.success) {
      return {
        success: false,
        error: preloadResult.error,
      };
    }

    // Use transformed code as cache key (unique per distinct code)
    const cacheKey = transformed.code;

    return {
      success: true,
      Component: createComponentFactory(cacheKey),
      cacheKey,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Create a component factory that injects onSubmit/onCancel/onError at render time.
 * Uses cacheKey (the transformed code) to look up or store the compiled component.
 */
function createComponentFactory(
  cacheKey: string
): ComponentType<FeedbackComponentProps> {
  return function FeedbackWrapper(props: FeedbackComponentProps) {
    const { onSubmit, onCancel, onError } = props;
    const resolvedRef = useRef(false);

    // Use useMemo with cacheKey to ensure stable component reference
    const CompiledComponent = useMemo(() => {
      const cached = componentCache.get(cacheKey);
      if (cached) {
        return cached;
      }
      const compiled = executeComponent(cacheKey);
      componentCache.set(cacheKey, compiled);
      return compiled;
    }, []);

    const safeOnSubmit = useCallback(
      (value: unknown) => {
        if (resolvedRef.current) return;
        resolvedRef.current = true;
        onSubmit(value);
      },
      [onSubmit]
    );

    const safeOnCancel = useCallback(() => {
      if (resolvedRef.current) return;
      resolvedRef.current = true;
      onCancel();
    }, [onCancel]);

    const safeOnError = useCallback(
      (message: string) => {
        if (resolvedRef.current) return;
        resolvedRef.current = true;
        onError(message);
      },
      [onError]
    );

    return <CompiledComponent onSubmit={safeOnSubmit} onCancel={safeOnCancel} onError={safeOnError} />;
  };
}
