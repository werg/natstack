// Core types and protocol
export * from "@natstack/agentic-protocol/types";
export * from "./protocol.js";
export { connect, createToolsForAgentSDK, type AgentSDKToolDefinition } from "./client.js";

// Database injection (for runtime configuration)
export { setDbOpen, getDbOpen, openDb, type Database, type DbOpener } from "./db-inject.js";

// Async utilities
export { AsyncQueue, createFanout } from "./async-queue.js";

// Message queue utilities (for responder workers)
export {
  MessageQueue,
  createQueuePositionText,
  cleanupQueuedTypingTrackers,
  drainForInterleave,
  type QueuedMessageBase,
  type QueuePositionTextOptions,
} from "./message-queue.js";
export type { AgenticClient } from "@natstack/agentic-protocol/types";

// JSON Schema utilities
export { jsonSchemaToZod, jsonSchemaToZodRawShape, isRecord } from "./json-schema-to-zod.js";

// Responder utilities (logging, formatting, message targeting)
export {
  createLogger,
  formatArgsForLog,
  isMessageTargetedAt,
} from "./responder-utils.js";

// Protocol types and tracker factories (canonical source: @natstack/agentic-protocol)
export {
  type ChatParticipantMetadata,
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
  // Inline UI (fire-and-forget MDX rendering)
  CONTENT_TYPE_INLINE_UI,
  type InlineUiData,
  // Shared tracker client interface
  type TrackerClient,
} from "@natstack/agentic-protocol";

// Context window usage data types (implementation in @natstack/agent-patterns)
export type {
  ContextWindowUsage,
  TokenUsage,
  NormalizedUsage,
} from "@natstack/agentic-protocol/context-tracker";

// Execution pause/resume utilities
export {
  createPauseMethodDefinition,
} from "./execution.js";

// NOTE: createInterruptHandler was merged into InterruptController in @natstack/agent-patterns.
// Use createInterruptController().startMonitoring(messageId, onPause) instead.

// Missed context utilities
export {
  aggregateReplayEvents,
  formatMissedContext,
  DEFAULT_MISSED_CONTEXT_MAX_CHARS,
  DEFAULT_METHOD_RESULT_MAX_CHARS,
} from "./missed-context.js";

// Tool approval utilities
export { needsApprovalForTool, isReadOnlyTool, APPROVAL_LEVELS } from "@natstack/agentic-protocol/tool-approval";
export type { ApprovalLevel } from "@natstack/agentic-protocol/tool-approval";

// Tool schemas for pubsub RPC tools
export * from "@natstack/agentic-protocol/tool-schemas";

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

// Approval schema (used by tool-ui for panel-side approval UI)
// NOTE: showPermissionPrompt moved to @natstack/agent-patterns (agent-facing utility)
export {
  createApprovalSchema,
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

// Subagent manager (consolidates subagent lifecycle management)
export {
  SubagentManager,
  type SubagentManagerConfig,
  type SubagentConfig,
} from "./subagent-manager.js";

// Feedback UI types
export {
  FeedbackFormArgs,
  FeedbackFormArgsSchema,
  FeedbackCustomArgs,
  FeedbackCustomArgsSchema,
  FieldDefinitionSchema,
} from "./protocol-schemas.js";

// TODO list inline UI utilities
export {
  type TodoItem,
  type TodoTracker,
  type TodoTrackerOptions,
  getTodoListCode,
  getCachedTodoListCode,
  createTodoInlineUiData,
  sendTodoListMessage,
  createTodoTracker,
} from "./todo-ui.js";

// Session recovery utilities: import from "@natstack/agentic-messaging/recovery"
// (Node.js only - uses 'os' module for homedir)

// For agent configs, use: import { ... } from "@natstack/agentic-messaging/config"
// For session persistence, use: import { ... } from "@natstack/agentic-messaging/session"
