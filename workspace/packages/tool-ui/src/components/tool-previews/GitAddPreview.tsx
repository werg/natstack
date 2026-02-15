/**
 * GitAddPreview - Styled file staging display for git_add tool approvals
 *
 * Shows the files to be staged in a clean, green-themed list.
 */

import { Box, Text, Flex } from "@radix-ui/themes";
import { PlusCircledIcon, FileIcon } from "@radix-ui/react-icons";

export interface GitAddPreviewProps {
  files: string[];
  path?: string;
}

/**
 * Abbreviate a file path for display.
 * Shows the last 2-3 segments to keep paths readable.
 */
function abbreviatePath(filePath: string): string {
  const segments = filePath.split("/").filter(Boolean);
  if (segments.length <= 3) return filePath;
  return ".../" + segments.slice(-2).join("/");
}

export function GitAddPreview({ files, path }: GitAddPreviewProps) {
  const fileCount = files.length;
  const summary = fileCount === 1 ? "Stage 1 file" : `Stage ${fileCount} files`;

  return (
    <Box>
      {/* Header */}
      <Flex gap="2" align="center" mb="2">
        <PlusCircledIcon style={{ color: "var(--green-9)" }} />
        <Text size="2" weight="medium" style={{ color: "var(--green-11)" }}>
          {summary}
        </Text>
      </Flex>

      {/* File list */}
      <Box
        style={{
          background: "var(--green-3)",
          borderRadius: 6,
          padding: 12,
          border: "1px solid var(--green-6)",
          maxHeight: 200,
          overflow: "auto",
        }}
      >
        <Flex direction="column" gap="1">
          {files.map((file, index) => (
            <Flex key={index} gap="2" align="center">
              <FileIcon style={{ color: "var(--green-9)", flexShrink: 0 }} />
              <Text
                size="2"
                style={{
                  fontFamily: "monospace",
                  color: "var(--green-11)",
                }}
                title={file}
              >
                {abbreviatePath(file)}
              </Text>
            </Flex>
          ))}
        </Flex>
      </Box>

      {/* Repository path (if specified) */}
      {path && (
        <Text size="1" color="gray" mt="1">
          in {path}
        </Text>
      )}
    </Box>
  );
}
