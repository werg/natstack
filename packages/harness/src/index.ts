// =============================================================================
// @natstack/harness — In-process Pi runtime for the agent worker DO
// =============================================================================

// PiRunner — the worker DO instantiates one per channel
export { PiRunner, providerDisplayName, isEnvVarOnlyProvider } from "./pi-runner.js";
export type { PiRunnerOptions, PiStateSnapshot, ThinkingLevel } from "./pi-runner.js";

// NatStack extension factories — supplied to the runner via PiRunnerOptions
export {
  createApprovalGateExtension,
  DEFAULT_SAFE_TOOL_NAMES,
} from "./extensions/approval-gate.js";
export type { ApprovalLevel, ApprovalGateDeps } from "./extensions/approval-gate.js";

export { createChannelToolsExtension } from "./extensions/channel-tools.js";
export type { ChannelToolMethod, ChannelToolsDeps, StreamUpdateCallback } from "./extensions/channel-tools.js";

export { createAskUserExtension } from "./extensions/ask-user.js";
export type {
  AskUserParams,
  AskUserQuestion,
  AskUserDeps,
} from "./extensions/ask-user.js";

// UI bridge
export {
  DispatchedError,
  NatStackExtensionUIContext,
} from "./natstack-extension-context.js";
export type { NatStackScopedUiContext } from "./natstack-extension-context.js";

// NatStack-local Pi extension API + runtime
export { PiExtensionRuntime } from "./pi-extension-runtime.js";
export type {
  AgentTool,
  PiExtensionAPI,
  PiExtensionContext,
  PiExtensionEvent,
  PiExtensionEventResult,
  PiExtensionFactory,
  PiExtensionHandler,
  PiExtensionUIContext,
  PiExtensionUIDialogOptions,
  PiExtensionWidgetOptions,
  PiExtensionWidgetPlacement,
  PiSessionStartEvent,
  PiToolCallEvent,
  PiToolInfo,
  PiTurnStartEvent,
} from "./pi-extension-api.js";

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
  createGrepTool,
  createFindTool,
  createLsTool,
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
export type {
  ReadToolInput,
  ReadToolDetails,
  ReadToolDeps,
  EditToolInput,
  EditToolDetails,
  WriteToolInput,
  WriteToolDetails,
  GrepToolInput,
  GrepToolDetails,
  FindToolInput,
  FindToolDetails,
  LsToolInput,
  LsToolDetails,
  TruncationResult,
  TruncationOptions,
  LineEnding,
  FuzzyMatchResult,
  DiffResult,
} from "./tools/index.js";
