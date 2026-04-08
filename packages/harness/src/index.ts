// =============================================================================
// @natstack/harness — In-process Pi runtime for the agent worker DO
// =============================================================================

// PiRunner — the worker DO instantiates one per channel
export { PiRunner } from "./pi-runner.js";
export type { PiRunnerOptions, PiStateSnapshot, ThinkingLevel } from "./pi-runner.js";

// NatStack extension factories — supplied to the runner via PiRunnerOptions
export {
  createApprovalGateExtension,
  DEFAULT_SAFE_TOOL_NAMES,
} from "./extensions/approval-gate.js";
export type { ApprovalLevel, ApprovalGateDeps } from "./extensions/approval-gate.js";

export { createChannelToolsExtension } from "./extensions/channel-tools.js";
export type { ChannelToolMethod, ChannelToolsDeps } from "./extensions/channel-tools.js";

export { createAskUserExtension } from "./extensions/ask-user.js";
export type {
  AskUserParams,
  AskUserQuestion,
  AskUserDeps,
} from "./extensions/ask-user.js";

// UI bridge
export { NatStackExtensionUIContext } from "./natstack-extension-context.js";
export type { NatStackUIBridgeCallbacks } from "./natstack-extension-context.js";

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
