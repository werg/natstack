/**
 * @workspace/tool-ui
 *
 * Shared UI components for feedback forms, tool approval prompts, and tool previews.
 * Provides reusable building blocks for any panel that needs to display feedback UIs
 * or handle tool approval workflows.
 */

// ============================================================================
// Types
// ============================================================================
export type {
  FeedbackResult,
  FeedbackComponentProps,
  ActiveFeedback,
  ActiveFeedbackBase,
  ActiveFeedbackSchema,
  ActiveFeedbackTsx,
  ApprovalLevel,
  ToolApprovalSettings,
  UseToolApprovalResult,
  ToolApprovalProps,
  FeedbackUiToolArgs,
  FeedbackUiToolResult,
} from "./types";

// Re-export from agentic-messaging for convenience
export type { FeedbackFormArgs } from "@workspace/agentic-messaging";

// ============================================================================
// Components
// ============================================================================
export { FeedbackFormRenderer, type FeedbackFormRendererProps } from "./components/FeedbackFormRenderer";
export { FeedbackContainer, type FeedbackContainerProps } from "./components/FeedbackContainer";
export { ToolPreviewField, type ToolPreviewFieldProps } from "./components/ToolPreviewField";
export { ErrorBoundary } from "./components/ErrorBoundary";

// Tool Previews (Monaco-free core exports)
// Note: FileEditPreview and FileWritePreview require Monaco and are available
// from "@workspace/tool-ui/monaco" to avoid bundling Monaco in all consumers.
export {
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
  hasRichPreview,
  RICH_PREVIEW_TOOLS,
  type RmPreviewProps,
  type GitCommitPreviewProps,
  type GitCheckoutPreviewProps,
  type GitAddPreviewProps,
  type FileEditArgs,
  type FileWriteArgs,
  type RmArgs,
  type GitCommitArgs,
  type GitCheckoutArgs,
  type GitAddArgs,
  type RichPreviewToolName,
} from "./components/tool-previews/core.js";

// Re-export types for Monaco previews (types don't cause bundling)
export type {
  FileEditPreviewProps,
  FileWritePreviewProps,
} from "./components/tool-previews/monaco.js";

// ============================================================================
// Hooks
// ============================================================================
export { useFeedbackManager, type UseFeedbackManagerResult } from "./hooks/useFeedbackManager";
export { useToolApproval, APPROVAL_LEVELS, type FeedbackFunctions } from "./hooks/useToolApproval";

// ============================================================================
// Middleware
// ============================================================================
export { wrapMethodsWithApproval } from "./middleware/approval-middleware";
export type { ApprovalFunctions, ToolRoleFunctions, GetToolRoleFunctions } from "./middleware/approval-middleware";

// ============================================================================
// Custom Feedback (TSX)
// ============================================================================
export {
  compileFeedbackComponent,
  cleanupFeedbackComponent,
} from "./eval/feedbackComponent";

// ============================================================================
// Inline UI Components (TSX)
// ============================================================================
export {
  compileInlineUiComponent,
  cleanupInlineUiComponent,
  type InlineUiComponentProps,
  type InlineUiCompileResult,
} from "./eval/feedbackComponent";

// ============================================================================
// Utilities
// ============================================================================
export { createApprovalSchema, type CreateApprovalSchemaParams } from "./utils/createApprovalSchema";

// ============================================================================
// Additional Components
// ============================================================================
export { ApprovalHeaderField, type ApprovalHeaderFieldProps } from "./components/ApprovalHeaderField";
