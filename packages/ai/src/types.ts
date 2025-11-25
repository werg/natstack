/**
 * Shared types for AI provider IPC communication.
 *
 * These types are serializable versions of the Vercel AI SDK types,
 * designed to be passed over IPC between panel contexts and the main process.
 */

// =============================================================================
// Model Metadata
// =============================================================================

/**
 * Information about a model assigned to a role.
 * Panels access models by role (e.g., "fast", "smart"), not by provider-specific IDs.
 */
export interface AIModelInfo {
  /** Underlying model ID this role resolves to */
  modelId: string;
  /** Provider identifier (e.g., "anthropic", "openai") */
  provider: string;
  /** Human-readable display name of the model */
  displayName: string;
  /** Optional description */
  description?: string;
}

/**
 * Record mapping role names to their configured models.
 *
 * Standard roles (smart, fast, cheap, coding) are always present with defaults applied:
 * - smart <-> coding (both prefer fast if not configured)
 * - cheap <-> fast (both prefer smart if not configured)
 *
 * Additional custom roles can be added as needed.
 *
 * Example:
 * ```typescript
 * const roles: AIRoleRecord = {
 *   fast: { modelId: "openai:gpt-4o-mini", provider: "openai", displayName: "GPT-4o Mini" },
 *   smart: { modelId: "anthropic:claude-sonnet-4-20250514", provider: "anthropic", displayName: "Claude Sonnet 4" },
 *   coding: { modelId: "anthropic:claude-sonnet-4-20250514", provider: "anthropic", displayName: "Claude Sonnet 4" },
 *   cheap: { modelId: "openai:gpt-4o-mini", provider: "openai", displayName: "GPT-4o Mini" },
 *   // optional custom roles:
 *   vision: { modelId: "openai:gpt-4o", provider: "openai", displayName: "GPT-4o" }
 * }
 * ```
 */
export type AIRoleRecord = {
  smart: AIModelInfo;
  fast: AIModelInfo;
  cheap: AIModelInfo;
  coding: AIModelInfo;
} & Record<string, AIModelInfo>;

// =============================================================================
// Request Types (Panel -> Main)
// =============================================================================

/** Text content part in a message */
export interface AITextPart {
  type: "text";
  text: string;
}

/** File content part (binary data is base64 encoded for IPC) */
export interface AIFilePart {
  type: "file";
  mimeType: string;
  /** Base64-encoded file data */
  data: string;
}

/** Tool call part in assistant messages */
export interface AIToolCallPart {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  args: unknown;
}

/** Tool result part */
export interface AIToolResultPart {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  result: unknown;
  isError?: boolean;
}

/** Reasoning/thinking part */
export interface AIReasoningPart {
  type: "reasoning";
  text: string;
}

export type AIMessagePart =
  | AITextPart
  | AIFilePart
  | AIToolCallPart
  | AIToolResultPart
  | AIReasoningPart;

/** System message */
export interface AISystemMessage {
  role: "system";
  content: string;
}

/** User message */
export interface AIUserMessage {
  role: "user";
  content: Array<AITextPart | AIFilePart>;
}

/** Assistant message */
export interface AIAssistantMessage {
  role: "assistant";
  content: Array<AITextPart | AIFilePart | AIReasoningPart | AIToolCallPart>;
}

/** Tool message */
export interface AIToolMessage {
  role: "tool";
  content: AIToolResultPart[];
}

export type AIMessage = AISystemMessage | AIUserMessage | AIAssistantMessage | AIToolMessage;

/** Tool definition for function calling */
export interface AIToolDefinition {
  type: "function";
  name: string;
  description?: string;
  parameters: Record<string, unknown>; // JSON Schema
}

/** Tool choice configuration */
export type AIToolChoice =
  | { type: "auto" }
  | { type: "none" }
  | { type: "required" }
  | { type: "tool"; toolName: string };

/** Response format configuration */
export type AIResponseFormat =
  | { type: "text" }
  | { type: "json"; schema?: Record<string, unknown>; name?: string; description?: string };

/**
 * Serializable call options for AI generation.
 * This is a subset of LanguageModelV2CallOptions that can be passed over IPC.
 */
export interface AICallOptions {
  /** The prompt messages */
  prompt: AIMessage[];

  // Generation parameters
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  stopSequences?: string[];
  seed?: number;

  // Response format
  responseFormat?: AIResponseFormat;

  // Tool configuration
  tools?: AIToolDefinition[];
  toolChoice?: AIToolChoice;

  // Provider-specific options
  providerOptions?: Record<string, Record<string, unknown>>;
}

// =============================================================================
// Response Types (Main -> Panel)
// =============================================================================

export type AIFinishReason =
  | "stop"
  | "length"
  | "content-filter"
  | "tool-calls"
  | "error"
  | "other"
  | "unknown";

export interface AIUsage {
  promptTokens: number;
  completionTokens: number;
}

/** Text content in response */
export interface AIResponseText {
  type: "text";
  text: string;
}

/** Reasoning content in response */
export interface AIResponseReasoning {
  type: "reasoning";
  text: string;
}

/** Tool call in response */
export interface AIResponseToolCall {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  args: unknown;
}

export type AIResponseContent = AIResponseText | AIResponseReasoning | AIResponseToolCall;

export interface AICallWarning {
  type: string;
  message: string;
  details?: unknown;
}

export interface AIResponseMetadata {
  id?: string;
  modelId?: string;
  timestamp?: string; // ISO string (Date objects aren't serializable)
}

/**
 * Result from a non-streaming generation call.
 */
export interface AIGenerateResult {
  content: AIResponseContent[];
  finishReason: AIFinishReason;
  usage: AIUsage;
  warnings: AICallWarning[];
  response?: AIResponseMetadata;
}

// =============================================================================
// Streaming Types
// =============================================================================

/** Stream chunk: text content starting */
export interface AIStreamTextStart {
  type: "text-start";
  id: string;
}

/** Stream chunk: text delta */
export interface AIStreamTextDelta {
  type: "text-delta";
  id: string;
  delta: string;
}

/** Stream chunk: text content ended */
export interface AIStreamTextEnd {
  type: "text-end";
  id: string;
}

/** Stream chunk: reasoning starting */
export interface AIStreamReasoningStart {
  type: "reasoning-start";
  id: string;
}

/** Stream chunk: reasoning delta */
export interface AIStreamReasoningDelta {
  type: "reasoning-delta";
  id: string;
  delta: string;
}

/** Stream chunk: reasoning ended */
export interface AIStreamReasoningEnd {
  type: "reasoning-end";
  id: string;
}

/** Stream chunk: tool input starting */
export interface AIStreamToolInputStart {
  type: "tool-input-start";
  toolCallId: string;
  toolName: string;
}

/** Stream chunk: tool input delta */
export interface AIStreamToolInputDelta {
  type: "tool-input-delta";
  toolCallId: string;
  inputTextDelta: string;
}

/** Stream chunk: tool input ended */
export interface AIStreamToolInputEnd {
  type: "tool-input-end";
  toolCallId: string;
}

/** Stream chunk: stream metadata */
export interface AIStreamStart {
  type: "stream-start";
  warnings: AICallWarning[];
}

/** Stream chunk: response metadata */
export interface AIStreamResponseMetadata {
  type: "response-metadata";
  id?: string;
  modelId?: string;
  timestamp?: string;
}

/** Stream chunk: generation finished */
export interface AIStreamFinish {
  type: "finish";
  finishReason: AIFinishReason;
  usage: AIUsage;
}

/** Stream chunk: error occurred */
export interface AIStreamError {
  type: "error";
  error: string;
}

export type AIStreamPart =
  | AIStreamTextStart
  | AIStreamTextDelta
  | AIStreamTextEnd
  | AIStreamReasoningStart
  | AIStreamReasoningDelta
  | AIStreamReasoningEnd
  | AIStreamToolInputStart
  | AIStreamToolInputDelta
  | AIStreamToolInputEnd
  | AIStreamStart
  | AIStreamResponseMetadata
  | AIStreamFinish
  | AIStreamError;

// =============================================================================
// IPC Event Payloads
// =============================================================================

/** Event sent from main to panel with stream chunks */
export interface AIStreamChunkEvent {
  panelId: string;
  streamId: string;
  chunk: AIStreamPart;
}

/** Event sent from main to panel when stream ends */
export interface AIStreamEndEvent {
  panelId: string;
  streamId: string;
}
