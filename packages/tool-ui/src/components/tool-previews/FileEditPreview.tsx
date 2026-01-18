/**
 * FileEditPreview - Monaco diff view for file_edit tool approvals
 *
 * Shows a syntax-highlighted diff of old_string vs new_string with
 * the target file path as header.
 */

import { Box, Text, Badge, Flex } from "@radix-ui/themes";
import { FileTextIcon } from "@radix-ui/react-icons";
import { DiffEditorDirect } from "@natstack/git-ui/monaco";
import { FILE_EXTENSION_LANGUAGE_MAP } from "@natstack/git-ui/constants";
import { useMemo } from "react";

const MIN_HEIGHT = 80;
const MAX_HEIGHT = 300;
const LINE_HEIGHT = 20;

export interface FileEditPreviewProps {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
  theme?: "light" | "dark";
}

function getLanguageFromPath(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return FILE_EXTENSION_LANGUAGE_MAP[ext] ?? "plaintext";
}

function getShortPath(filePath: string): string {
  // Show last 3 path segments for context
  const parts = filePath.split("/");
  if (parts.length <= 3) return filePath;
  return ".../" + parts.slice(-3).join("/");
}

export function FileEditPreview({
  file_path,
  old_string,
  new_string,
  replace_all,
  theme = "dark",
}: FileEditPreviewProps) {
  const language = useMemo(() => getLanguageFromPath(file_path), [file_path]);
  const shortPath = useMemo(() => getShortPath(file_path), [file_path]);

  const editorHeight = useMemo(() => {
    const maxLines = Math.max(
      old_string.split("\n").length,
      new_string.split("\n").length
    );
    return Math.min(Math.max(maxLines * LINE_HEIGHT, MIN_HEIGHT), MAX_HEIGHT);
  }, [old_string, new_string]);

  return (
    <Box>
      {/* File path header */}
      <Flex gap="2" align="center" mb="2">
        <FileTextIcon style={{ color: "var(--gray-11)" }} />
        <Text size="2" style={{ fontFamily: "monospace" }} title={file_path}>
          {shortPath}
        </Text>
        {replace_all && (
          <Badge color="orange" size="1">
            replace all
          </Badge>
        )}
      </Flex>

      {/* Monaco diff editor */}
      <Box
        style={{
          height: editorHeight,
          borderRadius: 6,
          overflow: "hidden",
          border: "1px solid var(--gray-6)",
        }}
      >
        <DiffEditorDirect
          original={old_string}
          modified={new_string}
          language={language}
          theme={theme === "dark" ? "vs-dark" : "light"}
          options={{
            readOnly: true,
            originalEditable: false,
            minimap: { enabled: false },
            scrollbar: {
              verticalScrollbarSize: 6,
              horizontalScrollbarSize: 6,
            },
            lineNumbers: "on",
            scrollBeyondLastLine: false,
            renderSideBySide: false,
            diffAlgorithm: "advanced",
            renderWhitespace: "selection",
            folding: false,
            glyphMargin: false,
            lineDecorationsWidth: 0,
            lineNumbersMinChars: 3,
          }}
        />
      </Box>
    </Box>
  );
}
