/**
 * ToolPreviewField Component
 *
 * Renders a rich preview for tool arguments based on tool name.
 * Used by FeedbackFormRenderer for both restricted and unrestricted mode approval prompts.
 *
 * Provides Monaco diffs, styled git previews, etc. based on the tool type.
 * Falls back to JSON display for unknown tools.
 */

import type { ReactNode } from "react";
import { Box, Text } from "@radix-ui/themes";
import {
  FileEditPreview,
  FileWritePreview,
  RmPreview,
  GitCommitPreview,
  GitCheckoutPreview,
  GitAddPreview,
  isFileEditArgs,
  isFileWriteArgs,
  isRmArgs,
  isGitCommitArgs,
  isGitCheckoutArgs,
  isGitAddArgs,
} from "./tool-previews";

export interface ToolPreviewFieldProps {
  toolName: string;
  args: unknown;
  theme?: "light" | "dark";
}

/**
 * Format tool arguments for JSON display.
 * Truncates large values.
 */
function formatArgs(args: unknown): string {
  try {
    const str = JSON.stringify(args, null, 2);
    // Truncate if too long
    if (str.length > 500) {
      return str.slice(0, 500) + "\n...";
    }
    return str;
  } catch {
    return String(args);
  }
}

/**
 * Render the appropriate preview component for the tool arguments.
 * Returns the rich preview if available, otherwise falls back to JSON.
 */
export function ToolPreviewField({
  toolName,
  args,
  theme = "dark",
}: ToolPreviewFieldProps): ReactNode {
  // file_edit - Monaco diff
  if (toolName === "file_edit" && isFileEditArgs(args)) {
    return (
      <FileEditPreview
        file_path={args.file_path}
        old_string={args.old_string}
        new_string={args.new_string}
        replace_all={args.replace_all}
        theme={theme}
      />
    );
  }

  // file_write - Monaco code view
  if (toolName === "file_write" && isFileWriteArgs(args)) {
    return (
      <FileWritePreview
        file_path={args.file_path}
        content={args.content}
        theme={theme}
      />
    );
  }

  // rm - Danger warning card
  if (toolName === "rm" && isRmArgs(args)) {
    return <RmPreview path={args.path} recursive={args.recursive} />;
  }

  // git_commit - Styled commit message
  if (toolName === "git_commit" && isGitCommitArgs(args)) {
    return <GitCommitPreview message={args.message} path={args.path} />;
  }

  // git_checkout - Branch/file operation display
  if (toolName === "git_checkout" && isGitCheckoutArgs(args)) {
    return (
      <GitCheckoutPreview
        branch={args.branch}
        file={args.file}
        create={args.create}
        path={args.path}
      />
    );
  }

  // git_add - File staging display
  if (toolName === "git_add" && isGitAddArgs(args)) {
    return <GitAddPreview files={args.files} path={args.path} />;
  }

  // Default: JSON display
  return (
    <Box
      style={{
        background: "var(--gray-3)",
        borderRadius: 6,
        padding: 12,
        maxHeight: 200,
        overflow: "auto",
      }}
    >
      <Text
        size="1"
        style={{
          fontFamily: "monospace",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {formatArgs(args)}
      </Text>
    </Box>
  );
}
