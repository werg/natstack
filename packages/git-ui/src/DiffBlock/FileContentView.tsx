import { useMemo } from "react";
import { Box, Callout } from "@radix-ui/themes";
import { Editor } from "@monaco-editor/react";
import { FileDiffHeader } from "./FileDiffHeader";
import { MonacoErrorBoundary } from "../MonacoErrorBoundary";
import type { FileChange } from "./types";
import {
  MIN_EDITOR_HEIGHT,
  MAX_EDITOR_HEIGHT,
  EDITOR_LINE_HEIGHT_PX,
  FILE_EXTENSION_LANGUAGE_MAP,
} from "../constants";

interface FileContentViewProps {
  file: FileChange;
  content: string;
  isDeleted?: boolean;
  theme?: "light" | "dark";
  onStageFile?: (path: string) => void;
  onUnstageFile?: (path: string) => void;
  onDiscardFile?: (path: string) => void;
}

function getLanguageFromPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  return FILE_EXTENSION_LANGUAGE_MAP[ext || ""] || "plaintext";
}

export function FileContentView({
  file,
  content,
  isDeleted,
  theme,
  onStageFile,
  onUnstageFile,
  onDiscardFile,
}: FileContentViewProps) {
  const language = getLanguageFromPath(file.path);

  const editorHeight = useMemo(() => {
    const lineCount = content.split("\n").length;
    return Math.min(
      Math.max(lineCount * EDITOR_LINE_HEIGHT_PX, MIN_EDITOR_HEIGHT),
      MAX_EDITOR_HEIGHT
    );
  }, [content]);

  const lineCount = content.split("\n").length;

  // For unmodified files, don't show stats since there are no changes
  const stats = file.status === "unmodified"
    ? undefined
    : isDeleted
      ? { additions: 0, deletions: lineCount }
      : { additions: lineCount, deletions: 0 };

  return (
    <Box>
      <FileDiffHeader
        file={file}
        onStageFile={onStageFile}
        onUnstageFile={onUnstageFile}
        onDiscardFile={onDiscardFile}
        stats={stats}
      />
      {isDeleted && (
        <Callout.Root color="red" size="1">
          <Callout.Text>This file has been deleted</Callout.Text>
        </Callout.Root>
      )}
      {!isDeleted && file.status === "added" && (
        <Callout.Root color="green" size="1">
          <Callout.Text>New file</Callout.Text>
        </Callout.Root>
      )}
      <Box style={{ height: editorHeight }}>
        <MonacoErrorBoundary fallbackHeight={Math.max(editorHeight, MIN_EDITOR_HEIGHT)}>
          <Editor
            value={content}
            language={language}
            theme={theme === "dark" ? "vs-dark" : "light"}
            options={{
              readOnly: true,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              lineNumbers: "on",
              scrollbar: { verticalScrollbarSize: 6 },
              renderLineHighlight: "none",
              folding: true,
            }}
          />
        </MonacoErrorBoundary>
      </Box>
    </Box>
  );
}
