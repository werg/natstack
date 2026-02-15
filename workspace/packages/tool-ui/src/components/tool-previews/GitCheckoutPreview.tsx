/**
 * GitCheckoutPreview - Display for git_checkout tool approvals
 *
 * Handles three modes:
 * - Branch switch: switching to an existing branch
 * - Branch create: creating a new branch (create: true)
 * - File restore: restoring a file (discards local changes)
 */

import { Box, Text, Flex, Callout } from "@radix-ui/themes";
import {
  GitHubLogoIcon,
  PlusIcon,
  ExclamationTriangleIcon,
  ResetIcon,
} from "@radix-ui/react-icons";

export interface GitCheckoutPreviewProps {
  branch?: string;
  file?: string;
  create?: boolean;
  path?: string;
}

function getShortPath(filePath: string): string {
  const parts = filePath.split("/");
  if (parts.length <= 3) return filePath;
  return ".../" + parts.slice(-3).join("/");
}

export function GitCheckoutPreview({
  branch,
  file,
  create,
  path,
}: GitCheckoutPreviewProps) {
  // File restore (most dangerous - discards changes)
  if (file) {
    return (
      <Callout.Root color="orange" size="2">
        <Callout.Icon>
          <ExclamationTriangleIcon />
        </Callout.Icon>
        <Callout.Text>
          <Flex direction="column" gap="1">
            <Flex gap="2" align="center">
              <ResetIcon />
              <Text weight="medium">Restore file:</Text>
              <Text style={{ fontFamily: "monospace" }}>{getShortPath(file)}</Text>
            </Flex>
            <Text size="1" color="orange">
              This will discard local changes!
            </Text>
          </Flex>
        </Callout.Text>
      </Callout.Root>
    );
  }

  // Create new branch
  if (branch && create) {
    return (
      <Box
        style={{
          background: "var(--green-3)",
          borderRadius: 6,
          padding: 12,
          border: "1px solid var(--green-6)",
        }}
      >
        <Flex gap="2" align="center">
          <PlusIcon style={{ color: "var(--green-9)" }} />
          <Text size="2" weight="medium">
            Create new branch:
          </Text>
          <Text
            size="2"
            weight="bold"
            style={{ fontFamily: "monospace", color: "var(--green-11)" }}
          >
            {branch}
          </Text>
        </Flex>
        {path && (
          <Text size="1" color="gray" mt="1" style={{ display: "block" }}>
            in {path}
          </Text>
        )}
      </Box>
    );
  }

  // Switch to existing branch
  if (branch) {
    return (
      <Box
        style={{
          background: "var(--blue-3)",
          borderRadius: 6,
          padding: 12,
          border: "1px solid var(--blue-6)",
        }}
      >
        <Flex gap="2" align="center">
          <GitHubLogoIcon style={{ color: "var(--blue-9)" }} />
          <Text size="2" weight="medium">
            Switch to branch:
          </Text>
          <Text
            size="2"
            weight="bold"
            style={{ fontFamily: "monospace", color: "var(--blue-11)" }}
          >
            {branch}
          </Text>
        </Flex>
        {path && (
          <Text size="1" color="gray" mt="1" style={{ display: "block" }}>
            in {path}
          </Text>
        )}
      </Box>
    );
  }

  // Fallback: no branch or file specified (shouldn't happen)
  return (
    <Callout.Root color="gray" size="2">
      <Callout.Icon>
        <GitHubLogoIcon />
      </Callout.Icon>
      <Callout.Text>Git checkout operation</Callout.Text>
    </Callout.Root>
  );
}
