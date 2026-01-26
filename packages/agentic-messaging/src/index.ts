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
export type { Participant, RosterUpdate, ParticipantMetadata, Attachment, AttachmentInput } from "@natstack/pubsub";

// JSON Schema utilities
export { jsonSchemaToZod, jsonSchemaToZodRawShape, isRecord } from "./json-schema-to-zod.js";

// Responder utilities
export {
  type ChatParticipantMetadata,
  createLogger,
  formatArgsForLog,
  isMessageTargetedAt,
  // Thinking/reasoning message tracker
  CONTENT_TYPE_THINKING,
  createThinkingTracker,
  type ThinkingTracker,
  type ThinkingTrackerState,
  type ThinkingTrackerOptions,
  // Action message tracker
  CONTENT_TYPE_ACTION,
  createActionTracker,
  getDetailedActionDescription,
  type ActionTracker,
  type ActionTrackerState,
  type ActionTrackerOptions,
  type ActionData,
  // Typing indicator tracker (ephemeral)
  CONTENT_TYPE_TYPING,
  createTypingTracker,
  type TypingTracker,
  type TypingTrackerState,
  type TypingTrackerOptions,
  type TypingData,
  // Shared tracker client interface
  type TrackerClient,
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

// Image processing utilities
export {
  SUPPORTED_IMAGE_TYPES,
  MAX_IMAGE_BYTES,
  MAX_TOTAL_BYTES,
  isImageMimeType,
  validateAttachment,
  validateAttachments,
  uint8ArrayToBase64,
  base64ToUint8Array,
  buildClaudeContentBlocks,
  buildOpenAIContents,
  filterImageAttachments,
  formatBytes,
  type SupportedImageType,
  type AttachmentValidationResult,
  type ClaudeImageBlock,
  type ClaudeTextBlock,
  type ClaudeContentBlock,
  type OpenAIImageContent,
  type OpenAITextContent,
  type OpenAIContent,
} from "./image-utils.js";

// Worker base utilities (shared across claude-code-responder, codex-responder, and other workers)
export {
  showPermissionPrompt,
  findPanelParticipant,
  validateRestrictedMode,
  createApprovalSchema,
  type PermissionPromptOptions,
  type CreateApprovalSchemaParams,
} from "./worker-base.js";

// Subagent connection utilities
export {
  createSubagentConnection,
  forwardStreamEventToSubagent,
  type SubagentConnection,
  type SubagentConnectionConfig,
  type SubagentConnectionOptions,
  type SDKStreamEvent,
} from "./subagent-connection.js";


// Feedback UI types (formerly in broker-protocol.ts)
export {
  FeedbackFormArgs,
  FeedbackFormArgsSchema,
  FeedbackCustomArgs,
  FeedbackCustomArgsSchema,
  FieldDefinitionSchema,
} from "./protocol-schemas.js";

// For agent configs, use: import { ... } from "@natstack/agentic-messaging/config"
// For session persistence, use: import { ... } from "@natstack/agentic-messaging/session"
// For agent registry, use: import { ... } from "@natstack/agentic-messaging/registry"

