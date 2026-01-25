/**
 * Core Tool Preview Components (Monaco-free)
 *
 * These components don't require Monaco and can be imported without
 * bundling the Monaco editor.
 */

export { RmPreview, type RmPreviewProps } from "./RmPreview.js";
export { GitCommitPreview, type GitCommitPreviewProps } from "./GitCommitPreview.js";
export { GitCheckoutPreview, type GitCheckoutPreviewProps } from "./GitCheckoutPreview.js";
export { GitAddPreview, type GitAddPreviewProps } from "./GitAddPreview.js";
export { ExitPlanModePreview, type ExitPlanModePreviewProps } from "./ExitPlanModePreview.js";
export { EnterPlanModePreview, type EnterPlanModePreviewProps } from "./EnterPlanModePreview.js";

// ============================================================================
// Re-export types and type guards from agentic-messaging
// ============================================================================

// These are the canonical definitions - we re-export them for convenience
export {
  // Type guards
  isFileEditArgs,
  isFileWriteArgs,
  isRmArgs,
  isGitCommitArgs,
  isGitCheckoutArgs,
  isGitAddArgs,
  isEnterPlanModeArgs,
  isExitPlanModeArgs,
  // Rich preview helpers
  hasRichPreview,
  RICH_PREVIEW_TOOLS,
  // Types
  type FileEditArgs,
  type FileWriteArgs,
  type RmArgs,
  type GitCommitArgs,
  type GitCheckoutArgs,
  type GitAddArgs,
  type EnterPlanModeArgs,
  type ExitPlanModeArgs,
  type AllowedPrompt,
  type RichPreviewToolName,
} from "@natstack/agentic-messaging";
