import { z } from "zod";
import type { ParticipantType } from "./channel";
import type { ConsoleEntry } from "../eval";

export type { ConsoleEntry };

/**
 * Tool execution status.
 */
export type ToolExecutionStatus = "pending" | "executing" | "completed" | "error";

/**
 * Base message structure.
 */
export interface ChannelMessage {
  id: string;
  channelId: string;
  participantId: string;
  participantType: ParticipantType;
  timestamp: Date;
  content: MessageContent;
  /** For agent messages: whether still streaming */
  isStreaming?: boolean;
  /** For tool calls: execution status */
  toolStatus?: ToolExecutionStatus;
}

/**
 * Serializable version for storage.
 */
export interface SerializableChannelMessage {
  id: string;
  channelId: string;
  participantId: string;
  participantType: ParticipantType;
  timestamp: string;
  content: MessageContent;
  isStreaming?: boolean;
  toolStatus?: ToolExecutionStatus;
}

/**
 * Message content - discriminated union of all content types.
 */
export type MessageContent =
  | TextContent
  | ToolCallContent
  | ToolResultContent
  | FileUploadContent
  | SystemContent;

/**
 * Plain text content from user or agent.
 */
export interface TextContent {
  type: "text";
  text: string;
  /** For agent: reasoning/thinking content */
  reasoning?: string;
}

/**
 * Tool call from agent.
 */
export interface ToolCallContent {
  type: "tool_call";
  toolCallId: string;
  toolName: string;
  args: unknown;
}

// -----------------------------------------------------------------------------
// Tool Result Data Schemas (Zod)
// -----------------------------------------------------------------------------

/**
 * Zod schema for console entries.
 */
export const ConsoleEntrySchema = z.object({
  level: z.enum(["log", "info", "warn", "error", "debug"]),
  args: z.array(z.unknown()),
  timestamp: z.number(),
});

/**
 * Zod schema for code execution data.
 */
export const CodeExecutionDataSchema = z.object({
  type: z.literal("code_execution"),
  result: z.unknown().optional(),
  consoleOutput: z.array(ConsoleEntrySchema),
  componentId: z.string().optional(),
  executionTime: z.number(),
  error: z.string().optional(),
  code: z.string().optional(),
});

/**
 * Data returned from code execution tool.
 */
export type CodeExecutionData = z.infer<typeof CodeExecutionDataSchema>;

/**
 * Type guard for code execution data.
 */
export function isCodeExecutionData(data: unknown): data is CodeExecutionData {
  return CodeExecutionDataSchema.safeParse(data).success;
}

/**
 * Tool execution result.
 */
export interface ToolResultContent {
  type: "tool_result";
  toolCallId: string;
  toolName: string;
  /** Human-readable result text */
  result: unknown;
  isError: boolean;
  /** Structured data for specialized renderers (e.g., CodeExecutionData) */
  data?: CodeExecutionData;
}

/**
 * File upload from user.
 */
export interface FileUploadContent {
  type: "file_upload";
  files: UploadedFile[];
}

/**
 * Uploaded file metadata.
 */
export interface UploadedFile {
  name: string;
  mimeType: string;
  size: number;
  /** OPFS path where file was stored */
  opfsPath: string;
}

/**
 * System notification content.
 */
export interface SystemContent {
  type: "system";
  level: "info" | "warning" | "error";
  message: string;
}

/**
 * Create a unique message ID.
 */
export function createMessageId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

// -----------------------------------------------------------------------------
// Tool Result Helpers
// -----------------------------------------------------------------------------

/**
 * Base structure for tool results.
 */
export interface BaseToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

/**
 * Tool result with code execution data.
 */
export interface CodeExecutionToolResult extends BaseToolResult {
  data: CodeExecutionData;
}

/**
 * Type guard to check if a result is a code execution result.
 */
export function isCodeExecutionResult(
  result: unknown
): result is CodeExecutionToolResult {
  if (
    typeof result !== "object" ||
    result === null ||
    !("data" in result)
  ) {
    return false;
  }
  return isCodeExecutionData((result as { data: unknown }).data);
}
