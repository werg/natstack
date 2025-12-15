/**
 * Shared types for AI provider IPC communication.
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
 */
export type AIRoleRecord = {
  smart: AIModelInfo;
  fast: AIModelInfo;
  cheap: AIModelInfo;
  coding: AIModelInfo;
} & Record<string, AIModelInfo>;

// =============================================================================
// Tool Definition (used for validation)
// =============================================================================

/** Tool definition for function calling */
export interface AIToolDefinition {
  type: "function";
  name: string;
  description?: string;
  parameters: Record<string, unknown>; // JSON Schema
}

// =============================================================================
// streamText API Types
// =============================================================================

/**
 * Message role types for the streamText API.
 */
export type MessageRole = "system" | "user" | "assistant" | "tool";

/**
 * Content part types for messages.
 * FilePart data accepts Uint8Array for convenience but will be base64-encoded for IPC.
 */
export type TextPart = { type: "text"; text: string };
export type FilePart = { type: "file"; mimeType: string; data: string | Uint8Array };
export type ToolCallPart = { type: "tool-call"; toolCallId: string; toolName: string; args: unknown };
export type ToolResultPart = {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  result: unknown;
  isError?: boolean;
};

/**
 * Message types for the streamText API.
 */
export type SystemMessage = { role: "system"; content: string };
export type UserMessage = { role: "user"; content: string | Array<TextPart | FilePart> };
export type AssistantMessage = { role: "assistant"; content: string | Array<TextPart | ToolCallPart> };
export type ToolMessage = { role: "tool"; content: ToolResultPart[] };
export type Message = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

/**
 * Tool definition with execute callback.
 */
export interface ToolDefinition {
  description?: string;
  parameters: Record<string, unknown>; // JSON Schema
  execute: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
}

/**
 * Callback types for streamText (Vercel AI SDK compatible)
 */
export type OnChunkCallback = (chunk: StreamEvent) => void | Promise<void>;
export type OnFinishCallback = (result: StreamTextFinishResult) => void | Promise<void>;
export type OnStepFinishCallback = (step: StepFinishResult) => void | Promise<void>;
export type OnErrorCallback = (error: Error) => void | Promise<void>;

export interface StepFinishResult {
  stepNumber: number;
  finishReason: "stop" | "tool-calls" | "length" | "error";
  text: string;
  toolCalls: Array<{ toolCallId: string; toolName: string; args: unknown }>;
  toolResults: Array<{ toolCallId: string; toolName: string; result: unknown; isError?: boolean }>;
}

export interface StreamTextFinishResult {
  text: string;
  toolCalls: Array<{ toolCallId: string; toolName: string; args: unknown }>;
  toolResults: Array<{ toolCallId: string; toolName: string; result: unknown; isError?: boolean }>;
  totalSteps: number;
  usage?: { promptTokens: number; completionTokens: number };
  finishReason: "stop" | "tool-calls" | "length" | "error";
}

/**
 * Options for streamText.
 */
export interface StreamTextOptions {
  /** Model role name (e.g., "fast", "smart") or full model ID (e.g., "claude-code:sonnet") */
  model: string;
  /** Messages to send */
  messages: Message[];
  /** Tools with execute callbacks */
  tools?: Record<string, ToolDefinition>;
  /** Maximum agent loop iterations (default: 10) */
  maxSteps?: number;
  /** Abort signal for cancellation */
  abortSignal?: AbortSignal;
  /** Maximum output tokens */
  maxOutputTokens?: number;
  /** Temperature (0-1) */
  temperature?: number;
  /** System prompt (alternative to system message) */
  system?: string;

  // Callbacks (Vercel AI SDK compatible)
  /** Called for each stream chunk */
  onChunk?: OnChunkCallback;
  /** Called when the stream finishes */
  onFinish?: OnFinishCallback;
  /** Called when each step finishes */
  onStepFinish?: OnStepFinishCallback;
  /** Called when an error occurs */
  onError?: OnErrorCallback;
}

/**
 * Stream event types returned by streamText.
 */
export type StreamEvent =
  | { type: "text-delta"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool-result"; toolCallId: string; toolName: string; result: unknown; isError?: boolean }
  | { type: "step-finish"; stepNumber: number; finishReason: "stop" | "tool-calls" | "length" | "error" }
  | { type: "finish"; totalSteps: number; usage?: { promptTokens: number; completionTokens: number } }
  | { type: "error"; error: Error };

/**
 * Tool execution result (internal format for IPC).
 */
export interface ToolExecutionResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  data?: unknown;
}

/**
 * Result object returned by streamText.
 * Provides multiple ways to consume the stream (Vercel AI SDK compatible).
 */
export interface StreamTextResult extends AsyncIterable<StreamEvent> {
  /** Full stream of all events */
  readonly fullStream: AsyncIterable<StreamEvent>;

  /** Stream of text deltas only */
  readonly textStream: AsyncIterable<string>;

  /** Promise that resolves to the full generated text */
  readonly text: Promise<string>;

  /** Promise that resolves to all tool calls made */
  readonly toolCalls: Promise<Array<{ toolCallId: string; toolName: string; args: unknown }>>;

  /** Promise that resolves to all tool results */
  readonly toolResults: Promise<Array<{ toolCallId: string; toolName: string; result: unknown; isError?: boolean }>>;

  /** Promise that resolves to the finish reason */
  readonly finishReason: Promise<"stop" | "tool-calls" | "length" | "error">;

  /** Promise that resolves to token usage */
  readonly usage: Promise<{ promptTokens: number; completionTokens: number } | undefined>;

  /** Promise that resolves to total steps */
  readonly totalSteps: Promise<number>;
}
