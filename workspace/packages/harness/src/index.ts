// =============================================================================
// @workspace/harness — In-process Pi runtime for the agent worker DO
// =============================================================================

// The in-process Pi runtime (PiRunner / AgentHarness) was replaced by the
// event-sourced @workspace/agent-loop + the AgentLoopDriver in
// @workspace/agentic-do (unified-log Stage B cut). The harness package keeps
// the local tools, prompt composition, and shared types.
export type ThinkingLevel = "minimal" | "low" | "medium" | "high";

// Stable runner-level error codes (Phase 7).
export { AgentWorkerError } from "./errors.js";
export type { AgentWorkerErrorCode } from "./errors.js";

export { NATSTACK_BASE_SYSTEM_PROMPT, composeSystemPrompt } from "./system-prompt.js";
export type { ComposeSystemPromptOptions, SystemPromptMode } from "./system-prompt.js";
export { loadNatStackResources, formatSkillIndex } from "./resource-loader.js";
export type { NatStackResources, ResourceLoaderDeps, SkillEntry } from "./resource-loader.js";

// The Pi extension layer (approval gate, channel tools, ask-user, web tools,
// extension runtime/UI bridge) was replaced by pure step policies in
// @workspace/agent-loop (unified-log Stage B). Tools remain below.
export type { AgentTool } from "@workspace/pi-core";

// Channel boundary types (still used by agentic-do)
export type {
  Attachment,
  ChannelEvent,
  SendMessageOptions,
  TurnInput,
  TurnUsage,
  ParticipantDescriptor,
  UnsubscribeResult,
} from "./types.js";

// File tools (workerd-clean port of pi-coding-agent's six file tools)
export {
  createReadTool,
  createEditTool,
  createWriteTool,
  createToolVcs,
  createGrepTool,
  createFindTool,
  createLsTool,
  createCloseTurnWithoutResponseTool,
  createEvalTool,
  formatEvalResult,
  type EvalRunResult,
  createDocsSearchTool,
  createDocsOpenTool,
  resolveToCwd,
  resolveReadPath,
  expandPath,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
  truncateTail,
  truncateLine,
  formatSize,
  detectLineEnding,
  normalizeToLF,
  restoreLineEndings,
  normalizeForFuzzyMatch,
  fuzzyFindText,
  stripBom,
  generateDiffString,
} from "./tools/index.js";

// Web research tools (web_search / web_fetch / web_read).
export { createWebTools } from "./web/index.js";
export type { WebToolsDeps } from "./web/index.js";
export type {
  ReadToolInput,
  ReadToolDetails,
  ReadToolDeps,
  EditToolInput,
  EditToolDetails,
  WriteToolInput,
  WriteToolDetails,
  ToolVcs,
  ToolVcsCommitResult,
  ToolVcsEditOp,
  ToolVcsEditResult,
  ToolVcsFileReadContent,
  ToolVcsFileWriteContent,
  ToolVcsMergeResult,
  ToolVcsPushResult,
  GrepToolInput,
  GrepToolDetails,
  FindToolInput,
  FindToolDetails,
  LsToolInput,
  LsToolDetails,
  DocsSearchInput,
  DocsOpenInput,
  CatalogHit,
  CatalogEntry,
  TruncationResult,
  TruncationOptions,
  LineEnding,
  FuzzyMatchResult,
  DiffResult,
} from "./tools/index.js";
