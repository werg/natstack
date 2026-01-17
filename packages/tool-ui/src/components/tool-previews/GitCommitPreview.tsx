/**
 * GitCommitPreview - Styled commit message display for git_commit tool approvals
 *
 * Shows the commit message in a clean, monospace block.
 */

import { Box, Text, Flex } from "@radix-ui/themes";
import { CommitIcon } from "@radix-ui/react-icons";

export interface GitCommitPreviewProps {
  message: string;
  path?: string;
}

export function GitCommitPreview({ message, path }: GitCommitPreviewProps) {
  // Split message into subject and body
  const lines = message.split("\n");
  const subject = lines[0];
  const body = lines.slice(1).join("\n").trim();

  return (
    <Box>
      {/* Header */}
      <Flex gap="2" align="center" mb="2">
        <CommitIcon style={{ color: "var(--green-9)" }} />
        <Text size="2" weight="medium">
          Commit message:
        </Text>
      </Flex>

      {/* Message box */}
      <Box
        style={{
          background: "var(--gray-3)",
          borderRadius: 6,
          padding: 12,
          border: "1px solid var(--gray-6)",
        }}
      >
        {/* Subject line */}
        <Text
          size="2"
          weight="medium"
          style={{
            fontFamily: "monospace",
            display: "block",
          }}
        >
          {subject}
        </Text>

        {/* Body (if present) */}
        {body && (
          <Text
            size="2"
            color="gray"
            style={{
              fontFamily: "monospace",
              whiteSpace: "pre-wrap",
              display: "block",
              marginTop: 8,
            }}
          >
            {body}
          </Text>
        )}
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
