import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Button, Flex, Text } from "@radix-ui/themes";
import { Editor } from "@monaco-editor/react";
import type { editor as MonacoEditor } from "monaco-editor";
import type { ConflictInfo } from "@natstack/git";
import { ConflictMarkerButtons } from "./ConflictMarkerButtons";
import { MonacoErrorBoundary } from "./MonacoErrorBoundary";

type MonacoApi = typeof import("monaco-editor");

const CONFLICT_STYLE_ID = "git-ui-conflict-marker-styles";

/**
 * Inject conflict marker styles into the document (idempotent).
 */
function ensureConflictMarkerStyles() {
  if (typeof document === "undefined") return;
  if (document.getElementById(CONFLICT_STYLE_ID)) return;

  const styleEl = document.createElement("style");
  styleEl.id = CONFLICT_STYLE_ID;
  styleEl.textContent = `
    .monaco-editor .conflict-marker-line {
      background-color: rgba(239, 68, 68, 0.2);
    }
    .monaco-editor .conflict-marker-glyph {
      background-color: rgb(239, 68, 68);
      margin-left: 3px;
      width: 4px !important;
    }
  `;
  document.head.appendChild(styleEl);
}

interface ThreeWayMergeEditorProps {
  conflict: ConflictInfo;
  onResolve: (content: string) => Promise<void>;
  theme?: "light" | "dark";
  disabled?: boolean;
}

type ConflictSegment =
  | { type: "text"; value: string }
  | { type: "conflict"; ours: string; theirs: string; base?: string };

type Choice = "ours" | "theirs" | "both";

function parseConflictSegments(content: string): ConflictSegment[] {
  const lines = content.split("\n");
  const segments: ConflictSegment[] = [];
  let buffer: string[] = [];
  let i = 0;

  const flushBuffer = () => {
    if (buffer.length > 0) {
      segments.push({ type: "text", value: buffer.join("\n") });
      buffer = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!line.startsWith("<<<<<<<")) {
      buffer.push(line);
      i++;
      continue;
    }

    flushBuffer();
    i++;
    const ours: string[] = [];
    while (i < lines.length && !lines[i]!.startsWith("|||||||") && !lines[i]!.startsWith("=======")) {
      ours.push(lines[i]!);
      i++;
    }

    let base: string[] = [];
    if (i < lines.length && lines[i]!.startsWith("|||||||")) {
      i++;
      while (i < lines.length && !lines[i]!.startsWith("=======")) {
        base.push(lines[i]!);
        i++;
      }
    }

    if (i < lines.length && lines[i]!.startsWith("=======")) {
      i++;
    }

    const theirs: string[] = [];
    while (i < lines.length && !lines[i]!.startsWith(">>>>>>>")) {
      theirs.push(lines[i]!);
      i++;
    }

    if (i < lines.length && lines[i]!.startsWith(">>>>>>>")) {
      i++;
    }

    segments.push({
      type: "conflict",
      ours: ours.join("\n"),
      theirs: theirs.join("\n"),
      base: base.length > 0 ? base.join("\n") : undefined,
    });
  }

  flushBuffer();
  return segments;
}

function buildResult(segments: ConflictSegment[], choices: Choice[]): string {
  const parts: string[] = [];
  let conflictIndex = 0;

  for (const segment of segments) {
    if (segment.type === "text") {
      parts.push(segment.value);
      continue;
    }

    const choice = choices[conflictIndex] ?? "ours";
    if (choice === "ours") {
      parts.push(segment.ours);
    } else if (choice === "theirs") {
      parts.push(segment.theirs);
    } else {
      const combined = [segment.ours, segment.theirs].filter(Boolean).join("\n");
      parts.push(combined);
    }
    conflictIndex++;
  }

  return parts.join("\n");
}

export function ThreeWayMergeEditor({ conflict, onResolve, theme, disabled }: ThreeWayMergeEditorProps) {
  const segments = useMemo(
    () => parseConflictSegments(conflict.original ?? ""),
    [conflict.original]
  );
  const conflictCount = segments.filter((segment) => segment.type === "conflict").length;

  const [choices, setChoices] = useState<Choice[]>(() => Array(conflictCount).fill("ours"));
  const [manualResult, setManualResult] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);

  // Inject conflict marker styles once on mount
  useEffect(() => {
    ensureConflictMarkerStyles();
  }, []);

  // Track editor for decorations
  const resolvedEditorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<MonacoApi | null>(null);
  const decorationIdsRef = useRef<string[]>([]);

  // Apply conflict marker decorations to the resolved editor
  const applyConflictDecorations = useCallback(() => {
    const editor = resolvedEditorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;

    const model = editor.getModel();
    if (!model) return;

    const decorations: MonacoEditor.IModelDeltaDecoration[] = [];
    const lineCount = model.getLineCount();

    for (let i = 1; i <= lineCount; i++) {
      const line = model.getLineContent(i);
      if (
        line.startsWith("<<<<<<<") ||
        line.startsWith("=======") ||
        line.startsWith(">>>>>>>") ||
        line.startsWith("|||||||")
      ) {
        decorations.push({
          range: new monaco.Range(i, 1, i, line.length + 1),
          options: {
            isWholeLine: true,
            className: "conflict-marker-line",
            glyphMarginClassName: "conflict-marker-glyph",
          },
        });
      }
    }

    decorationIdsRef.current = editor.deltaDecorations(decorationIdsRef.current, decorations);
  }, []);

  // Handle editor mount
  const handleResolvedEditorMount = useCallback(
    (editor: MonacoEditor.IStandaloneCodeEditor, monaco: MonacoApi) => {
      resolvedEditorRef.current = editor;
      monacoRef.current = monaco;
      applyConflictDecorations();

      // Re-apply decorations when content changes
      editor.onDidChangeModelContent(() => {
        applyConflictDecorations();
      });
    },
    [applyConflictDecorations]
  );

  useEffect(() => {
    setChoices(Array(conflictCount).fill("ours"));
    setManualResult(null);
  }, [conflict.path, conflictCount]);

  const resultContent = useMemo(() => {
    if (manualResult !== null) return manualResult;
    return buildResult(segments, choices);
  }, [manualResult, segments, choices]);

  const handleChoice = useCallback((index: number, choice: Choice) => {
    setChoices((prev) => {
      const next = [...prev];
      next[index] = choice;
      return next;
    });
    setManualResult(null);
  }, []);

  const handleResolve = useCallback(async () => {
    setResolving(true);
    setResolveError(null);
    try {
      await onResolve(resultContent);
    } catch (err) {
      setResolveError(err instanceof Error ? err.message : String(err));
    } finally {
      setResolving(false);
    }
  }, [onResolve, resultContent]);

  // Build list of conflict indices (not segment indices)
  const conflictIndices = useMemo(() => {
    const indices: number[] = [];
    segments.forEach((segment) => {
      if (segment.type === "conflict") {
        indices.push(indices.length);
      }
    });
    return indices;
  }, [segments]);

  return (
    <Box>
      {conflictCount > 0 && (
        <Flex direction="column" gap="2" mb="3">
          {conflictIndices.map((conflictIdx) => (
            <ConflictMarkerButtons
              key={conflictIdx}
              index={conflictIdx}
              marker={conflict.markers[conflictIdx]}
              onSelect={(choice) => handleChoice(conflictIdx, choice)}
            />
          ))}
        </Flex>
      )}

      <Box
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
          gap: "var(--space-3)",
        }}
      >
        <Box>
          <Text size="1" color="gray">Base</Text>
          <MonacoErrorBoundary fallbackHeight={200}>
            <Editor
              value={conflict.base}
              theme={theme === "dark" ? "vs-dark" : "light"}
              height="200px"
              options={{ readOnly: true, minimap: { enabled: false }, lineNumbers: "on" }}
            />
          </MonacoErrorBoundary>
        </Box>
        <Box>
          <Text size="1" color="gray">Ours</Text>
          <MonacoErrorBoundary fallbackHeight={200}>
            <Editor
              value={conflict.ours}
              theme={theme === "dark" ? "vs-dark" : "light"}
              height="200px"
              options={{ readOnly: true, minimap: { enabled: false }, lineNumbers: "on" }}
            />
          </MonacoErrorBoundary>
        </Box>
        <Box>
          <Text size="1" color="gray">Theirs</Text>
          <MonacoErrorBoundary fallbackHeight={200}>
            <Editor
              value={conflict.theirs}
              theme={theme === "dark" ? "vs-dark" : "light"}
              height="200px"
              options={{ readOnly: true, minimap: { enabled: false }, lineNumbers: "on" }}
            />
          </MonacoErrorBoundary>
        </Box>
        <Box>
          <Text size="1" color="gray">Resolved</Text>
          <MonacoErrorBoundary fallbackHeight={200}>
            <Editor
              value={resultContent}
              theme={theme === "dark" ? "vs-dark" : "light"}
              height="200px"
              options={{
                minimap: { enabled: false },
                lineNumbers: "on",
                glyphMargin: true,
              }}
              onChange={(value) => setManualResult(value ?? "")}
              onMount={handleResolvedEditorMount}
            />
          </MonacoErrorBoundary>
        </Box>
      </Box>

      <Flex justify="end" mt="3" gap="3" align="center">
        {resolveError && (
          <Text size="1" color="red">{resolveError}</Text>
        )}
        <Button variant="solid" onClick={() => void handleResolve()} disabled={resolving || disabled}>
          {resolving || disabled ? "Resolving..." : "Mark Resolved"}
        </Button>
      </Flex>
    </Box>
  );
}
