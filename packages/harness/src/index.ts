// =============================================================================
// @natstack/harness — In-process Pi runtime for the agent worker DO
// =============================================================================

// PiRunner — the worker DO instantiates one per channel
export { PiRunner } from "./pi-runner.js";
export type {
  PiRunnerOptions,
  PiStateSnapshot,
  ThinkingLevel,
  PiRunnerGadProvenance,
  RunnerTurnInput,
  HibernationResumableTool,
} from "./pi-runner.js";

// TurnSnapshot (Phase 2) — surfaced via `onPrepareNextTurn`.
export { buildTurnSnapshot } from "./turn-snapshot.js";
export type { TurnSnapshot, BuildTurnSnapshotInput } from "./turn-snapshot.js";

// HookBus (Phase 6) — typed multi-listener event/hook bus owned by PiRunner.
export { HookBus } from "./hook-bus.js";
export type {
  HookName,
  HookListenerMap,
  EventListener,
  TransformContextListener,
  BeforeProviderRequestListener,
  RunnerEvent,
  NatStackRunnerEvent,
  OrphanFileMutationIntentEvent,
} from "./hook-bus.js";

// CompactionTrigger - decides when to call AgentHarness.compact().
export { CompactionTrigger } from "./compaction-trigger.js";
export type { CompactionTriggerOptions } from "./compaction-trigger.js";

// Stable runner-level error codes (Phase 7).
export { AgentWorkerError } from "./errors.js";
export type { AgentWorkerErrorCode } from "./errors.js";

export {
  NATSTACK_BASE_SYSTEM_PROMPT,
  composeSystemPrompt,
} from "./system-prompt.js";
export type { ComposeSystemPromptOptions, SystemPromptMode } from "./system-prompt.js";

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

export { createWebToolsExtension } from "./extensions/web/index.js";
export type {
  WebToolsDeps,
  WebRpcCaller,
  SearchResult,
  ProviderName,
  CredentialPresenceProbe,
} from "./extensions/web/index.js";
export { SEARCH_PROVIDER_ORIGINS } from "./extensions/web/provider.js";

// UI bridge
export {
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
