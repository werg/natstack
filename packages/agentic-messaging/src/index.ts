// Core types and protocol
export * from "./types.js";
export * from "./protocol.js";
export { connect, createToolsForAgentSDK, type AgentSDKToolDefinition } from "./client.js";
export type { AgenticClient } from "./types.js";
export {
  DEFAULT_CHAT_ASSISTANT_PERSONA,
  COMPONENT_ENHANCED_RICH_TEXT_GUIDE,
  RESTRICTED_MODE_ENVIRONMENT_GUIDE,
  createRichTextChatSystemPrompt,
  createRestrictedModeSystemPrompt,
} from "./prompts.js";

// Re-export commonly needed types from pubsub so consumers don't need a direct dependency
export type { Participant, RosterUpdate, ParticipantMetadata } from "@natstack/pubsub";

// JSON Schema utilities
export { jsonSchemaToZod, jsonSchemaToZodRawShape, isRecord } from "./json-schema-to-zod.js";

// Responder utilities
export {
  type ChatParticipantMetadata,
  parseAgentConfig,
  createLogger,
  formatArgsForLog,
  isMessageTargetedAt,
} from "./responder-utils.js";

// Execution pause/resume utilities
export {
  createPauseMethodDefinition,
} from "./execution.js";

// Interrupt handler for responders
export {
  createInterruptHandler,
  type InterruptHandlerOptions,
} from "./interrupt-handler.js";

// Missed context utilities
export {
  aggregateReplayEvents,
  formatMissedContext,
  DEFAULT_MISSED_CONTEXT_MAX_CHARS,
  DEFAULT_METHOD_RESULT_MAX_CHARS,
} from "./missed-context.js";

// Tool approval utilities
export { requestToolApproval, needsApprovalForTool, extractMethodName, isReadOnlyTool, READ_ONLY_TOOLS, APPROVAL_LEVELS } from "./tool-approval.js";
export type { ApprovalOptions, ApprovalLevel } from "./tool-approval.js";

// Tool schemas for pubsub RPC tools
export * from "./tool-schemas.js";

// Worker base utilities (shared across claude-code, codex, pubsub-chat workers)
export {
  showPermissionPrompt,
  findPanelParticipant,
  validateRestrictedMode,
  type PermissionPromptOptions,
} from "./worker-base.js";

// For broker functionality, use: import { ... } from "@natstack/agentic-messaging/broker"
// For agent configs, use: import { ... } from "@natstack/agentic-messaging/config"
// For session persistence, use: import { ... } from "@natstack/agentic-messaging/session"

