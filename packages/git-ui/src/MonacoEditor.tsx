/**
 * React wrapper for modern-monaco Editor.
 *
 * Replaces @monaco-editor/react usage with modern-monaco.
 * Provides a similar API for easy migration.
 */
import { useEffect, useRef, useState, useCallback } from "react";
import { getMonaco, type MonacoNamespace } from "./modernMonaco.js";
import type { editor } from "modern-monaco/editor-core";
import { MonacoLoadingState } from "./MonacoLoadingState.js";

export interface MonacoEditorProps {
  /** Initial value for the editor */
  value: string;
  /** Language for syntax highlighting */
  language?: string;
  /** Editor theme */
  theme?: "vs-dark" | "light";
  /** Read-only mode */
  readOnly?: boolean;
  /** Editor height (CSS value or number in pixels) */
  height?: number | string;
  /** Additional editor options */
  options?: editor.IStandaloneEditorConstructionOptions;
  /** Called when editor content changes */
  onChange?: (value: string) => void;
  /** Called when editor is mounted */
  onMount?: (editor: editor.IStandaloneCodeEditor, monaco: MonacoNamespace) => void;
}

/**
 * React component wrapping Monaco editor with modern-monaco.
 *
 * This provides a similar API to @monaco-editor/react for easy migration.
 */
export function MonacoEditor({
  value,
  language,
  theme = "vs-dark",
  readOnly,
  height,
  options,
  onChange,
  onMount,
}: MonacoEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [monaco, setMonaco] = useState<MonacoNamespace | null>(null);
  const [initError, setInitError] = useState<Error | null>(null);
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const isUpdatingRef = useRef(false);

  // Store callbacks in refs to avoid re-creating editor
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onMountRef = useRef(onMount);
  onMountRef.current = onMount;

  // Initialize Monaco with error handling
  const initMonaco = useCallback(() => {
    setInitError(null);
    getMonaco()
      .then(setMonaco)
      .catch((err) => {
        console.error("[MonacoEditor] Failed to initialize Monaco:", err);
        setInitError(err instanceof Error ? err : new Error(String(err)));
      });
  }, []);

  useEffect(() => {
    initMonaco();
  }, [initMonaco]);

  // Create editor when Monaco is ready
  useEffect(() => {
    if (!monaco || !containerRef.current) return;

    const ed = monaco.editor.create(containerRef.current, {
      value,
      language,
      theme,
      readOnly,
      automaticLayout: true,
      ...options,
    });

    editorRef.current = ed;
    onMountRef.current?.(ed, monaco);

    // Listen for content changes
    const changeDisposable = ed.onDidChangeModelContent(() => {
      if (isUpdatingRef.current) return;
      const newValue = ed.getValue();
      onChangeRef.current?.(newValue);
    });

    return () => {
      changeDisposable.dispose();
      ed.dispose();
      editorRef.current = null;
    };
    // Only re-create editor if Monaco instance changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monaco]);

  // Handle value updates from props
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed) return;

    const currentValue = ed.getValue();
    if (value !== currentValue) {
      isUpdatingRef.current = true;
      ed.setValue(value);
      isUpdatingRef.current = false;
    }
  }, [value]);

  // Handle theme updates
  useEffect(() => {
    if (monaco) {
      monaco.editor.setTheme(theme);
    }
  }, [monaco, theme]);

  // Handle language updates
  useEffect(() => {
    const ed = editorRef.current;
    const model = ed?.getModel();
    if (monaco && model && language) {
      monaco.editor.setModelLanguage(model, language);
    }
  }, [monaco, language]);

  // Track previous options to avoid unnecessary updates
  // We use a ref + shallow comparison instead of JSON.stringify which is:
  // 1. O(n) on every render
  // 2. Fails for circular references
  // 3. Order-sensitive for object keys
  const prevOptionsRef = useRef<typeof options>(undefined);

  // Handle options updates - only when options object identity changes
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed || !options) return;

    // Skip if same reference
    if (options === prevOptionsRef.current) return;

    // Update the editor with new options
    ed.updateOptions(options);
    prevOptionsRef.current = options;
  }, [options]);

  // Handle readOnly updates
  useEffect(() => {
    const ed = editorRef.current;
    if (ed) {
      ed.updateOptions({ readOnly });
    }
  }, [readOnly]);

  // Show loading/error state while Monaco initializes
  if (!monaco) {
    return (
      <MonacoLoadingState
        message="Loading editor..."
        error={initError}
        height={height}
        theme={theme}
        onRetry={initError ? initMonaco : undefined}
      />
    );
  }

  return (
    <div
      ref={containerRef}
      style={{
        width: "100%",
        height: typeof height === "number" ? `${height}px` : height ?? "100%",
      }}
    />
  );
}
