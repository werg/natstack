/**
 * ToolPreviewField Component
 *
 * Renders a rich preview for tool arguments based on tool name.
 * Used by FeedbackFormRenderer for both restricted and unrestricted mode approval prompts.
 *
 * Provides Monaco diffs, styled git previews, etc. based on the tool type.
 * Falls back to JSON display for unknown tools.
 *
 * Note: Monaco-dependent previews (FileEditPreview, FileWritePreview) are lazy-loaded
 * to avoid bundling Monaco (~27MB) in consumers that don't use file edit/write tools.
 */

import { lazy, Suspense, type ReactNode } from "react";
import { Box, Text, Spinner } from "@radix-ui/themes";
import {
  RmPreview,
  GitCommitPreview,
  GitCheckoutPreview,
  GitAddPreview,
  EnterPlanModePreview,
  ExitPlanModePreview,
  isFileEditArgs,
  isFileWriteArgs,
  isRmArgs,
  isGitCommitArgs,
  isGitCheckoutArgs,
  isGitAddArgs,
  isEnterPlanModeArgs,
  isExitPlanModeArgs,
} from "./tool-previews/core.js";

// Lazy-load Monaco-dependent components to avoid bundling Monaco in all consumers
const FileEditPreview = lazy(() =>
  import("./tool-previews/monaco.js").then((m) => ({ default: m.FileEditPreview }))
);
const FileWritePreview = lazy(() =>
  import("./tool-previews/monaco.js").then((m) => ({ default: m.FileWritePreview }))
);

/** Loading fallback for Monaco previews */
function MonacoLoadingFallback() {
  return (
    <Box
      style={{
        background: "var(--gray-3)",
        borderRadius: 6,
        padding: 24,
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        minHeight: 80,
      }}
    >
      <Spinner size="2" />
    </Box>
  );
}

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
  // file_edit - Monaco diff (lazy-loaded)
  if (toolName === "file_edit" && isFileEditArgs(args)) {
    return (
      <Suspense fallback={<MonacoLoadingFallback />}>
        <FileEditPreview
          file_path={args.file_path}
          old_string={args.old_string}
          new_string={args.new_string}
          replace_all={args.replace_all}
          theme={theme}
        />
      </Suspense>
    );
  }

  // file_write - Monaco code view (lazy-loaded)
  if (toolName === "file_write" && isFileWriteArgs(args)) {
    return (
      <Suspense fallback={<MonacoLoadingFallback />}>
        <FileWritePreview
          file_path={args.file_path}
          content={args.content}
          theme={theme}
        />
      </Suspense>
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

  // enter_plan_mode - Plan mode entry request
  if (toolName === "enter_plan_mode" && isEnterPlanModeArgs(args)) {
    const extendedArgs = args as Record<string, unknown>;
    const reason = typeof extendedArgs["reason"] === "string"
      ? extendedArgs["reason"]
      : undefined;
    return <EnterPlanModePreview reason={reason} />;
  }

  // exit_plan_mode - Plan approval with requested permissions
  if (toolName === "exit_plan_mode" && isExitPlanModeArgs(args)) {
    // planFilePath and plan content may be passed by SDK
    const extendedArgs = args as Record<string, unknown>;
    const planFilePath = typeof extendedArgs["planFilePath"] === "string"
      ? extendedArgs["planFilePath"]
      : undefined;
    const plan = typeof extendedArgs["plan"] === "string"
      ? extendedArgs["plan"]
      : undefined;
    return <ExitPlanModePreview plan={plan} allowedPrompts={args.allowedPrompts} planFilePath={planFilePath} />;
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
