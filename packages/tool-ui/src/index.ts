/**
 * @natstack/tool-ui
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

// Re-export from agentic-messaging/broker for convenience
export type { FeedbackFormArgs } from "@natstack/agentic-messaging/broker";

// ============================================================================
// Components
// ============================================================================
export { FeedbackFormRenderer, type FeedbackFormRendererProps } from "./components/FeedbackFormRenderer";
export { FeedbackContainer, type FeedbackContainerProps } from "./components/FeedbackContainer";
export { ToolPreviewField, type ToolPreviewFieldProps } from "./components/ToolPreviewField";
export { ErrorBoundary } from "./components/ErrorBoundary";

// Tool Previews
export {
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
  hasRichPreview,
  RICH_PREVIEW_TOOLS,
  type FileEditPreviewProps,
  type FileWritePreviewProps,
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
} from "./components/tool-previews";

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
// Utilities
// ============================================================================
export { createApprovalSchema, type CreateApprovalSchemaParams } from "./utils/createApprovalSchema";

// ============================================================================
// Additional Components
// ============================================================================
export { ApprovalHeaderField, type ApprovalHeaderFieldProps } from "./components/ApprovalHeaderField";
