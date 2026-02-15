/**
 * Feedback Component Compilation
 *
 * Compiles TSX code into React components for custom feedback UIs.
 * Uses @workspace/eval for transformation and execution.
 */

import { useCallback, useMemo, useRef } from "react";
import type { ComponentType } from "react";
import type { FeedbackComponentProps, FeedbackUiToolArgs, FeedbackUiToolResult } from "../types";

// Lazy-loaded @workspace/eval (~460KB sucrase deferred until first feedback component compile)
let evalModule: typeof import("@workspace/eval") | null = null;
async function getEvalModule() {
  if (!evalModule) {
    try { evalModule = await import("@workspace/eval"); }
    catch (e) { throw new Error(`Failed to load eval module: ${e instanceof Error ? e.message : e}`); }
  }
  return evalModule;
}

/**
 * Execute and extract the default export as a React component.
 * This is a thin wrapper around executeDefault with React typing.
 */
function executeComponent(code: string): ComponentType<FeedbackComponentProps> {
  if (!evalModule) throw new Error("Eval module not loaded - compileFeedbackComponent must be called first");
  return evalModule.executeDefault<ComponentType<FeedbackComponentProps>>(code);
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

  // Warn if the component doesn't reference onSubmit — it likely won't be able to return data
  if (!code.includes("onSubmit")) {
    console.warn(
      "[feedback_custom] Component code does not reference 'onSubmit'. " +
      "The user will not be able to submit a response. Did you forget to destructure { onSubmit } from props?"
    );
  }

  try {
    const { transformCode, preloadRequires } = await getEvalModule();
    const transformed = await transformCode(code, { syntax: "tsx" });

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

// ============================================================================
// Inline UI Component Compilation
// ============================================================================

/**
 * Props for inline UI components - just arbitrary props to pass through.
 */
export interface InlineUiComponentProps {
  props: Record<string, unknown>;
}

/**
 * Result of compiling an inline UI component.
 */
export interface InlineUiCompileResult {
  success: boolean;
  /** The compiled React component (if successful) */
  Component?: ComponentType<InlineUiComponentProps>;
  /** Cache key for cleanup (if successful) */
  cacheKey?: string;
  /** Error message (if failed) */
  error?: string;
}

/** Separate cache for inline UI components */
const inlineUiCache = new Map<string, ComponentType<InlineUiComponentProps>>();

/**
 * Execute and extract the default export as an inline UI component.
 */
function executeInlineUiComponent(code: string): ComponentType<InlineUiComponentProps> {
  if (!evalModule) throw new Error("Eval module not loaded - compileInlineUiComponent must be called first");
  return evalModule.executeDefault<ComponentType<InlineUiComponentProps>>(code);
}

/**
 * Compile an inline UI component from TSX code.
 * Unlike feedback components, this passes arbitrary props through to the component.
 */
export async function compileInlineUiComponent(args: { code: string }): Promise<InlineUiCompileResult> {
  const { code } = args;

  try {
    const { transformCode, preloadRequires } = await getEvalModule();
    const transformed = await transformCode(code, { syntax: "tsx" });

    // Preload all required modules (async - may load from CDN if not pre-bundled)
    const preloadResult = await preloadRequires(transformed.requires);
    if (!preloadResult.success) {
      return {
        success: false,
        error: preloadResult.error,
      };
    }

    // Use transformed code as cache key
    const cacheKey = transformed.code;

    return {
      success: true,
      Component: createInlineUiComponentFactory(cacheKey),
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
 * Create a component factory for inline UI that passes props through.
 */
function createInlineUiComponentFactory(
  cacheKey: string
): ComponentType<InlineUiComponentProps> {
  return function InlineUiWrapper(wrapperProps: InlineUiComponentProps) {
    // Get or compile the component
    const CompiledComponent = useMemo(() => {
      const cached = inlineUiCache.get(cacheKey);
      if (cached) {
        return cached;
      }
      const compiled = executeInlineUiComponent(cacheKey);
      inlineUiCache.set(cacheKey, compiled);
      return compiled;
    }, []);

    // Pass props through to the compiled component
    return <CompiledComponent props={wrapperProps.props} />;
  };
}

/**
 * Clean up a cached inline UI component.
 */
export function cleanupInlineUiComponent(cacheKey: string): void {
  inlineUiCache.delete(cacheKey);
}
