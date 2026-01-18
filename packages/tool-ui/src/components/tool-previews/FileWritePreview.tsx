/**
 * FileWritePreview - Monaco code view for file_write tool approvals
 *
 * Shows the content that will be written to the file with syntax highlighting.
 */

import { Box, Text, Flex } from "@radix-ui/themes";
import { PlusIcon } from "@radix-ui/react-icons";
import { MonacoEditor } from "@natstack/git-ui/monaco";
import { FILE_EXTENSION_LANGUAGE_MAP } from "@natstack/git-ui/constants";
import { useMemo } from "react";

const MIN_HEIGHT = 80;
const MAX_HEIGHT = 300;
const LINE_HEIGHT = 20;

export interface FileWritePreviewProps {
  file_path: string;
  content: string;
  theme?: "light" | "dark";
}

function getLanguageFromPath(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return FILE_EXTENSION_LANGUAGE_MAP[ext] ?? "plaintext";
}

function getShortPath(filePath: string): string {
  const parts = filePath.split("/");
  if (parts.length <= 3) return filePath;
  return ".../" + parts.slice(-3).join("/");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FileWritePreview({
  file_path,
  content,
  theme = "dark",
}: FileWritePreviewProps) {
  const language = useMemo(() => getLanguageFromPath(file_path), [file_path]);
  const shortPath = useMemo(() => getShortPath(file_path), [file_path]);
  const byteSize = useMemo(() => new TextEncoder().encode(content).length, [content]);

  const editorHeight = useMemo(() => {
    const lineCount = content.split("\n").length;
    return Math.min(Math.max(lineCount * LINE_HEIGHT, MIN_HEIGHT), MAX_HEIGHT);
  }, [content]);

  return (
    <Box>
      {/* Header */}
      <Flex gap="2" align="center" mb="2">
        <PlusIcon style={{ color: "var(--green-9)" }} />
        <Text size="2" weight="medium">
          Write file:
        </Text>
        <Text size="2" style={{ fontFamily: "monospace" }} title={file_path}>
          {shortPath}
        </Text>
      </Flex>

      {/* Monaco editor */}
      <Box
        style={{
          height: editorHeight,
          borderRadius: 6,
          overflow: "hidden",
          border: "1px solid var(--gray-6)",
        }}
      >
        <MonacoEditor
          value={content}
          language={language}
          theme={theme === "dark" ? "vs-dark" : "light"}
          height={editorHeight}
          readOnly
          options={{
            minimap: { enabled: false },
            scrollbar: {
              verticalScrollbarSize: 6,
              horizontalScrollbarSize: 6,
            },
            lineNumbers: "on",
            scrollBeyondLastLine: false,
            folding: false,
            glyphMargin: false,
            lineDecorationsWidth: 0,
            lineNumbersMinChars: 3,
            renderWhitespace: "selection",
          }}
        />
      </Box>

      {/* Byte size footer */}
      <Text size="1" color="gray" mt="1">
        {formatBytes(byteSize)}
      </Text>
    </Box>
  );
}
