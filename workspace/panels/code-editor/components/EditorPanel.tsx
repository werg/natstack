/**
 * Monaco editor panel component.
 *
 * Wraps the Monaco editor with lifecycle management and keyboard shortcuts.
 * Uses modern-monaco via @natstack/git-ui for async Monaco initialization.
 */

import { useRef, useEffect, useState } from "react";
import type { editor, IDisposable } from "modern-monaco/editor-core";
import { Box, Flex, Text } from "@radix-ui/themes";
import {
  getMonaco,
  configureMonacoTypeCheck,
  diagnosticsToMarkers,
  type MonacoNamespace,
} from "@natstack/git-ui";
import { getLanguage, type Diagnostic } from "../types";
import type { UseEditorNavigationResult } from "../hooks/useEditorNavigation";

export interface EditorPanelProps {
  filePath: string | null;
  content: string | null;
  cursorPosition?: { lineNumber: number; column: number };
  scrollTop?: number;
  diagnostics: Diagnostic[];
  onChange: (content: string) => void;
  onSave: () => void;
  onCursorChange: (lineNumber: number, column: number) => void;
  onScrollChange: (scrollTop: number) => void;
  /** Navigation event source for go-to-position requests */
  navigation?: UseEditorNavigationResult;
  style?: React.CSSProperties;
}

// Track if type check has been configured (module-level for singleton behavior)
let typeCheckConfigured = false;

export function EditorPanel({
  filePath,
  content,
  cursorPosition,
  scrollTop,
  diagnostics,
  onChange,
  onSave,
  onCursorChange,
  onScrollChange,
  navigation,
  style,
}: EditorPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [monaco, setMonaco] = useState<MonacoNamespace | null>(null);
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const modelRef = useRef<editor.ITextModel | null>(null);
  const disposablesRef = useRef<IDisposable[]>([]);
  const isUpdatingRef = useRef(false);
  const initIdRef = useRef(0);

  // Store callbacks in refs to avoid re-creating editor
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const onCursorChangeRef = useRef(onCursorChange);
  onCursorChangeRef.current = onCursorChange;
  const onScrollChangeRef = useRef(onScrollChange);
  onScrollChangeRef.current = onScrollChange;

  // Initialize Monaco on mount
  useEffect(() => {
    getMonaco().then(async (m) => {
      // Configure type checking once
      if (!typeCheckConfigured) {
        typeCheckConfigured = true;
        await configureMonacoTypeCheck();
      }
      setMonaco(m);
    });
  }, []);

  // Track initial content for editor creation (avoids re-render dependency)
  const initialContentRef = useRef<string | null>(null);
  const hasInitializedRef = useRef(false);

  // Capture initial content in an effect (React 18 concurrent rendering safe)
  useEffect(() => {
    if (content !== null && !hasInitializedRef.current) {
      initialContentRef.current = content;
      hasInitializedRef.current = true;
    }
  }, [content]);

  // Reset when filePath changes
  useEffect(() => {
    hasInitializedRef.current = false;
    initialContentRef.current = null;
  }, [filePath]);

  // Create/dispose editor only when filePath changes (NOT content)
  useEffect(() => {
    if (!monaco || !containerRef.current || content === null) return;

    const thisInitId = ++initIdRef.current;
    const container = containerRef.current;

    // Dispose previous editor
    for (const d of disposablesRef.current) {
      d.dispose();
    }
    disposablesRef.current = [];

    if (editorRef.current) {
      editorRef.current.dispose();
      editorRef.current = null;
    }

    // Dispose previous model
    if (modelRef.current && !modelRef.current.isDisposed()) {
      modelRef.current.dispose();
    }
    modelRef.current = null;

    // Create model with current content
    const language = getLanguage(filePath ?? undefined);
    const uri = filePath
      ? monaco.Uri.parse(`file://${filePath}`)
      : monaco.Uri.parse(`file:///untitled-${Date.now()}`);

    // Check for existing model - if found and not disposed, reuse it
    // Important: Check isDisposed() to avoid race condition with disposal above
    let model = monaco.editor.getModel(uri);
    if (model && !model.isDisposed()) {
      // Reuse existing model, update content if different
      const currentContent = initialContentRef.current ?? content;
      if (model.getValue() !== currentContent) {
        isUpdatingRef.current = true;
        model.setValue(currentContent);
        isUpdatingRef.current = false;
      }
    } else {
      // Dispose any stale model reference before creating new one
      if (model && model.isDisposed()) {
        model = null;
      }
      model = monaco.editor.createModel(initialContentRef.current ?? content, language, uri);
    }
    modelRef.current = model;

    // Reset initial content ref for next file
    initialContentRef.current = null;

    // Create editor
    const ed = monaco.editor.create(container, {
      model,
      theme: "vs-dark",
      automaticLayout: true,
      fontSize: 14,
      lineNumbers: "on",
      minimap: { enabled: true },
      scrollBeyondLastLine: false,
      wordWrap: "off",
      tabSize: 2,
      insertSpaces: true,
    });
    editorRef.current = ed;

    // Restore cursor position
    if (cursorPosition) {
      ed.setPosition(cursorPosition);
    }

    // Restore scroll position
    if (scrollTop !== undefined) {
      ed.setScrollTop(scrollTop);
    }

    // Listen for content changes
    const contentDisposable = ed.onDidChangeModelContent(() => {
      if (isUpdatingRef.current) return;
      const value = ed.getValue();
      onChangeRef.current(value);
    });
    disposablesRef.current.push(contentDisposable);

    // Listen for cursor position changes
    const cursorDisposable = ed.onDidChangeCursorPosition((e) => {
      onCursorChangeRef.current(e.position.lineNumber, e.position.column);
    });
    disposablesRef.current.push(cursorDisposable);

    // Listen for scroll changes
    const scrollDisposable = ed.onDidScrollChange((e) => {
      onScrollChangeRef.current(e.scrollTop);
    });
    disposablesRef.current.push(scrollDisposable);

    // Add Ctrl+S save shortcut
    const saveDisposable = ed.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
      () => {
        onSaveRef.current();
      }
    );
    if (saveDisposable) {
      disposablesRef.current.push({ dispose: () => {} }); // Command disposer not needed
    }

    // Focus editor
    ed.focus();

    return () => {
      if (initIdRef.current !== thisInitId) return;

      for (const d of disposablesRef.current) {
        d.dispose();
      }
      disposablesRef.current = [];

      if (editorRef.current) {
        editorRef.current.dispose();
        editorRef.current = null;
      }

      if (modelRef.current && !modelRef.current.isDisposed()) {
        modelRef.current.dispose();
        modelRef.current = null;
      }
    };
    // filePath and monaco are the dependencies - editor handles content updates
    // via separate useEffect to avoid full recreation on typing
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, monaco]);

  // Handle external content changes (e.g., file reloaded from disk)
  useEffect(() => {
    if (!editorRef.current || !modelRef.current) return;
    if (isUpdatingRef.current) return;
    if (content === null) return;

    const currentValue = modelRef.current.getValue();
    if (content !== currentValue) {
      isUpdatingRef.current = true;
      modelRef.current.setValue(content);
      isUpdatingRef.current = false;
    }
  }, [content]);

  // Update diagnostics markers
  useEffect(() => {
    if (!monaco) return;
    const model = modelRef.current;
    if (!model || model.isDisposed() || !filePath) return;

    // diagnostics are already filtered for this file by useDiagnostics.forFile()
    // Don't pass filterFile to avoid double-filtering with potentially mismatched paths
    const markers = diagnosticsToMarkers(diagnostics);
    monaco.editor.setModelMarkers(model, "natstack-typecheck", markers);
  }, [monaco, diagnostics, filePath]);

  // Subscribe to navigation events
  useEffect(() => {
    if (!navigation) return;

    const goToPosition = (line: number, column: number) => {
      const ed = editorRef.current;
      if (!ed) return;

      ed.setPosition({ lineNumber: line, column });
      ed.revealPositionInCenter({ lineNumber: line, column });
      ed.focus();
    };

    return navigation.subscribe((req) => {
      goToPosition(req.line, req.column);
    });
  }, [navigation]);

  // Show loading state while Monaco initializes
  if (!monaco) {
    return (
      <Flex
        align="center"
        justify="center"
        style={{
          ...style,
          backgroundColor: "var(--gray-1)",
        }}
      >
        <Text size="2" color="gray">
          Loading editor...
        </Text>
      </Flex>
    );
  }

  // Show placeholder when no file is open
  if (content === null) {
    return (
      <Flex
        align="center"
        justify="center"
        style={{
          ...style,
          backgroundColor: "var(--gray-1)",
        }}
      >
        <Text size="2" color="gray">
          Select a file to edit
        </Text>
      </Flex>
    );
  }

  return (
    <Box
      ref={containerRef}
      style={{
        ...style,
        width: "100%",
        height: "100%",
      }}
    />
  );
}
