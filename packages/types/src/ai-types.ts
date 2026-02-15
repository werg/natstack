/**
 * AI Types - Shared types for AI provider IPC communication.
 */

// =============================================================================
// Model Metadata
// =============================================================================

export interface AIModelInfo {
  modelId: string;
  provider: string;
  displayName: string;
  description?: string;
}

export type AIRoleRecord = {
  smart: AIModelInfo;
  fast: AIModelInfo;
  cheap: AIModelInfo;
  coding: AIModelInfo;
} & Record<string, AIModelInfo>;

// =============================================================================
// Tool Definition (used for validation)
// =============================================================================

export interface AIToolDefinition {
  type: "function";
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

// =============================================================================
// streamText API Types
// =============================================================================

export type MessageRole = "system" | "user" | "assistant" | "tool";

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

export type SystemMessage = { role: "system"; content: string };
export type UserMessage = { role: "user"; content: string | Array<TextPart | FilePart> };
export type AssistantMessage = { role: "assistant"; content: string | Array<TextPart | ToolCallPart> };
export type ToolMessage = { role: "tool"; content: ToolResultPart[] };
export type Message = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

export interface ToolDefinition {
  description?: string;
  parameters: Record<string, unknown>;
  execute?: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
}

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

export interface StreamTextOptions {
  model: string;
  messages: Message[];
  tools?: Record<string, ToolDefinition>;
  maxSteps?: number;
  abortSignal?: AbortSignal;
  maxOutputTokens?: number;
  temperature?: number;
  system?: string;
  thinking?: { type: "enabled" | "disabled"; budgetTokens?: number };
  onChunk?: OnChunkCallback;
  onFinish?: OnFinishCallback;
  onStepFinish?: OnStepFinishCallback;
  onError?: OnErrorCallback;
  onReasoningDelta?: (delta: string) => void | Promise<void>;
}

export type StreamEvent =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-start" }
  | { type: "reasoning-delta"; text: string }
  | { type: "reasoning-end" }
  | { type: "tool-call"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool-result"; toolCallId: string; toolName: string; result: unknown; isError?: boolean }
  | { type: "step-finish"; stepNumber: number; finishReason: "stop" | "tool-calls" | "length" | "error" }
  | { type: "finish"; totalSteps: number; usage?: { promptTokens: number; completionTokens: number } }
  | { type: "error"; error: Error };

export interface ToolExecutionResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  data?: unknown;
}

export interface StreamTextResult extends AsyncIterable<StreamEvent> {
  readonly fullStream: AsyncIterable<StreamEvent>;
  readonly textStream: AsyncIterable<string>;
  readonly text: Promise<string>;
  readonly toolCalls: Promise<Array<{ toolCallId: string; toolName: string; args: unknown }>>;
  readonly toolResults: Promise<Array<{ toolCallId: string; toolName: string; result: unknown; isError?: boolean }>>;
  readonly finishReason: Promise<"stop" | "tool-calls" | "length" | "error">;
  readonly usage: Promise<{ promptTokens: number; completionTokens: number } | undefined>;
  readonly totalSteps: Promise<number>;
}
