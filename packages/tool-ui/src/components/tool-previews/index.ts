/**
 * Tool Preview Components
 *
 * Rich UI components for displaying tool call arguments in the approval prompt.
 * Each component provides a specialized view for its tool type.
 */

export { FileEditPreview, type FileEditPreviewProps } from "./FileEditPreview";
export { FileWritePreview, type FileWritePreviewProps } from "./FileWritePreview";
export { RmPreview, type RmPreviewProps } from "./RmPreview";
export { BashPreview, type BashPreviewProps } from "./BashPreview";
export { GitCommitPreview, type GitCommitPreviewProps } from "./GitCommitPreview";
export { GitCheckoutPreview, type GitCheckoutPreviewProps } from "./GitCheckoutPreview";
export { GitAddPreview, type GitAddPreviewProps } from "./GitAddPreview";

// ============================================================================
// Re-export types and type guards from agentic-messaging
// ============================================================================

// These are the canonical definitions - we re-export them for convenience
export {
  // Type guards
  isFileEditArgs,
  isFileWriteArgs,
  isRmArgs,
  isBashArgs,
  isGitCommitArgs,
  isGitCheckoutArgs,
  isGitAddArgs,
  // Rich preview helpers
  hasRichPreview,
  RICH_PREVIEW_TOOLS,
  // Types
  type FileEditArgs,
  type FileWriteArgs,
  type RmArgs,
  type BashArgs,
  type GitCommitArgs,
  type GitCheckoutArgs,
  type GitAddArgs,
  type RichPreviewToolName,
} from "@natstack/agentic-messaging";
