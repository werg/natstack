import { useRef, useEffect, useState, useCallback } from "react";
import { getMonaco, type MonacoNamespace } from "../modernMonaco.js";
import type { editor, IDisposable } from "modern-monaco/editor-core";
import { MonacoLoadingState } from "../MonacoLoadingState.js";

/**
 * Check if an unhandled rejection is a known Monaco DiffEditor error.
 * These are harmless async errors when diff computations are canceled.
 */
function isMonacoDiffError(event: PromiseRejectionEvent): boolean {
  const message = event.reason?.message || String(event.reason);
  return (
    message === "Canceled" ||
    message === "Canceled: Canceled" ||
    message === "no diff result available"
  );
}

export interface DiffEditorDirectProps {
  original: string;
  modified: string;
  language?: string;
  theme?: "light" | "vs-dark";
  options?: editor.IDiffEditorConstructionOptions;
  onMount?: (editor: editor.IStandaloneDiffEditor) => void;
  onModifiedChange?: (value: string) => void;
}

/**
 * A DiffEditor component that uses Monaco's API directly via modern-monaco.
 *
 * This replaces @monaco-editor/react's DiffEditor to fix a disposal bug
 * where models are disposed before the DiffEditorWidget is reset.
 * See: https://github.com/suren-atoyan/monaco-react/issues/647
 *
 * Key fix: We control disposal order:
 * 1. Dispose event listeners
 * 2. Dispose the editor
 * 3. Dispose models (last)
 */
export function DiffEditorDirect({
  original,
  modified,
  language,
  theme = "vs-dark",
  options,
  onMount,
  onModifiedChange,
}: DiffEditorDirectProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [monaco, setMonaco] = useState<MonacoNamespace | null>(null);
  const [initError, setInitError] = useState<Error | null>(null);
  const editorRef = useRef<editor.IStandaloneDiffEditor | null>(null);
  const originalModelRef = useRef<editor.ITextModel | null>(null);
  const modifiedModelRef = useRef<editor.ITextModel | null>(null);
  const listenerRef = useRef<IDisposable | null>(null);
  // Track initialization per-effect cycle to handle React Strict Mode double-invocation
  const initIdRef = useRef(0);

  // Store callback in ref to avoid re-creating editor on callback change
  const onModifiedChangeRef = useRef(onModifiedChange);
  onModifiedChangeRef.current = onModifiedChange;

  const onMountRef = useRef(onMount);
  onMountRef.current = onMount;

  // Initialize Monaco with error handling
  const initMonaco = useCallback(() => {
    setInitError(null);
    getMonaco()
      .then(setMonaco)
      .catch((err) => {
        console.error("[DiffEditorDirect] Failed to initialize Monaco:", err);
        setInitError(err instanceof Error ? err : new Error(String(err)));
      });
  }, []);

  useEffect(() => {
    initMonaco();
  }, [initMonaco]);

  // Initialize editor when Monaco is ready
  useEffect(() => {
    if (!monaco || !containerRef.current) return;

    // Track this initialization cycle - each effect invocation gets a unique ID
    // This handles React Strict Mode double-invocation correctly
    const thisInitId = ++initIdRef.current;

    // Suppress Monaco's internal async errors while this editor is mounted
    const errorHandler = (event: PromiseRejectionEvent) => {
      if (isMonacoDiffError(event)) {
        event.preventDefault();
      }
    };
    window.addEventListener("unhandledrejection", errorHandler);

    // Create models with unique URIs to avoid conflicts
    const uniqueId = Math.random().toString(36).slice(2);
    const originalModel = monaco.editor.createModel(
      original,
      language,
      monaco.Uri.parse(`diff://original-${uniqueId}`)
    );
    const modifiedModel = monaco.editor.createModel(
      modified,
      language,
      monaco.Uri.parse(`diff://modified-${uniqueId}`)
    );
    originalModelRef.current = originalModel;
    modifiedModelRef.current = modifiedModel;

    // Create diff editor
    const diffEditor = monaco.editor.createDiffEditor(containerRef.current, {
      ...options,
      automaticLayout: true,
    });
    editorRef.current = diffEditor;

    diffEditor.setModel({
      original: originalModel,
      modified: modifiedModel,
    });

    // Set initial theme
    monaco.editor.setTheme(theme);

    // Attach change listener for modified content
    const listener = diffEditor
      .getModifiedEditor()
      .onDidChangeModelContent(() => {
        const value = editorRef.current?.getModifiedEditor().getValue();
        if (value !== undefined) {
          onModifiedChangeRef.current?.(value);
        }
      });
    listenerRef.current = listener;

    // Call onMount callback
    onMountRef.current?.(diffEditor);

    // CRITICAL: Correct disposal order to prevent Monaco bug
    return () => {
      // Only clean up if this is still the active initialization
      // (prevents issues with React Strict Mode double-mount)
      if (initIdRef.current !== thisInitId) return;

      // 1. Remove error handler
      window.removeEventListener("unhandledrejection", errorHandler);

      // 2. Dispose event listeners first
      listener.dispose();
      listenerRef.current = null;

      // 3. Clear the model to stop any pending diff computation
      diffEditor.setModel(null);

      // 4. Dispose the editor
      diffEditor.dispose();
      editorRef.current = null;

      // 5. Dispose models last
      originalModel.dispose();
      originalModelRef.current = null;
      modifiedModel.dispose();
      modifiedModelRef.current = null;
    };
    // Only run when Monaco is ready - content updates handled separately
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monaco]);

  // Update original content when prop changes
  useEffect(() => {
    const model = originalModelRef.current;
    if (model && original !== model.getValue()) {
      model.setValue(original);
    }
  }, [original]);

  // Update modified content when prop changes
  useEffect(() => {
    const model = modifiedModelRef.current;
    if (model && modified !== model.getValue()) {
      model.setValue(modified);
    }
  }, [modified]);

  // Update language when prop changes
  useEffect(() => {
    if (monaco && language) {
      if (originalModelRef.current) {
        monaco.editor.setModelLanguage(originalModelRef.current, language);
      }
      if (modifiedModelRef.current) {
        monaco.editor.setModelLanguage(modifiedModelRef.current, language);
      }
    }
  }, [monaco, language]);

  // Update options when prop changes
  useEffect(() => {
    if (options && editorRef.current) {
      editorRef.current.updateOptions(options);
    }
  }, [options]);

  // Update theme when prop changes
  useEffect(() => {
    if (monaco) {
      monaco.editor.setTheme(theme);
    }
  }, [monaco, theme]);

  // Show loading/error state while Monaco initializes
  if (!monaco) {
    return (
      <MonacoLoadingState
        message="Loading diff..."
        error={initError}
        theme={theme}
        onRetry={initError ? initMonaco : undefined}
      />
    );
  }

  return (
    <div
      ref={containerRef}
      style={{ width: "100%", height: "100%" }}
    />
  );
}
