import type { ParticipantType } from "./channel";
import type { ConsoleEntry } from "../kernel/KernelManager";

export type { ConsoleEntry };

/**
 * Code language options.
 */
export type CodeLanguage = "javascript" | "typescript" | "jsx" | "tsx";

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
  /** For responses (tool_result, code_result): ID of the message this responds to */
  responseTo?: string;
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
  responseTo?: string;
}

/**
 * Message content - discriminated union of all content types.
 */
export type MessageContent =
  | TextContent
  | CodeContent
  | CodeResultContent
  | ToolCallContent
  | ToolResultContent
  | FileUploadContent
  | SystemContent
  | ReactMountContent;

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
 * Code cell content.
 */
export interface CodeContent {
  type: "code";
  code: string;
  language: CodeLanguage;
  /** User-submitted vs agent-generated */
  source: "user" | "agent";
}

/**
 * Code execution result from kernel.
 */
export interface CodeResultContent {
  type: "code_result";
  success: boolean;
  /** Last expression value */
  result?: unknown;
  /** Error message if failed */
  error?: string;
  /** Console output during execution */
  consoleOutput: ConsoleEntry[];
  /** If result includes a React component, the mount ID */
  reactMountId?: string;
  /** Execution time in milliseconds */
  executionTime: number;
  /** Variables declared with const */
  constNames?: string[];
  /** Variables declared with let/var */
  mutableNames?: string[];
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

/**
 * Tool execution result.
 */
export interface ToolResultContent {
  type: "tool_result";
  toolCallId: string;
  toolName: string;
  result: unknown;
  isError: boolean;
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
  /** For kernel state notifications */
  kernelStateWarning?: boolean;
}

/**
 * React component mount content.
 */
export interface ReactMountContent {
  type: "react_mount";
  mountId: string;
  /** Component source code for reference */
  componentCode?: string;
}

/**
 * Create a unique message ID.
 */
export function createMessageId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Create a text message.
 */
export function createTextMessage(
  channelId: string,
  participantId: string,
  participantType: ParticipantType,
  text: string,
  reasoning?: string
): ChannelMessage {
  return {
    id: createMessageId(),
    channelId,
    participantId,
    participantType,
    timestamp: new Date(),
    content: {
      type: "text",
      text,
      reasoning,
    },
  };
}

/**
 * Create a code message.
 */
export function createCodeMessage(
  channelId: string,
  participantId: string,
  participantType: ParticipantType,
  code: string,
  language: CodeLanguage,
  source: "user" | "agent"
): ChannelMessage {
  return {
    id: createMessageId(),
    channelId,
    participantId,
    participantType,
    timestamp: new Date(),
    content: {
      type: "code",
      code,
      language,
      source,
    },
  };
}

/**
 * Create a code result message.
 */
export function createCodeResultMessage(
  channelId: string,
  participantId: string,
  success: boolean,
  result: unknown,
  consoleOutput: ConsoleEntry[],
  executionTime: number,
  error?: string,
  reactMountId?: string
): ChannelMessage {
  return {
    id: createMessageId(),
    channelId,
    participantId,
    participantType: "kernel",
    timestamp: new Date(),
    content: {
      type: "code_result",
      success,
      result,
      error,
      consoleOutput,
      reactMountId,
      executionTime,
    },
  };
}

/**
 * Create a tool call message.
 */
export function createToolCallMessage(
  channelId: string,
  participantId: string,
  toolCallId: string,
  toolName: string,
  args: unknown
): ChannelMessage {
  return {
    id: createMessageId(),
    channelId,
    participantId,
    participantType: "agent",
    timestamp: new Date(),
    content: {
      type: "tool_call",
      toolCallId,
      toolName,
      args,
    },
    toolStatus: "pending",
  };
}

/**
 * Create a tool result message.
 */
export function createToolResultMessage(
  channelId: string,
  participantId: string,
  toolCallId: string,
  toolName: string,
  result: unknown,
  isError: boolean
): ChannelMessage {
  return {
    id: createMessageId(),
    channelId,
    participantId,
    participantType: "agent",
    timestamp: new Date(),
    content: {
      type: "tool_result",
      toolCallId,
      toolName,
      result,
      isError,
    },
  };
}

/**
 * Create a system message.
 */
export function createSystemMessage(
  channelId: string,
  level: "info" | "warning" | "error",
  message: string,
  kernelStateWarning?: boolean
): ChannelMessage {
  return {
    id: createMessageId(),
    channelId,
    participantId: "system",
    participantType: "system",
    timestamp: new Date(),
    content: {
      type: "system",
      level,
      message,
      kernelStateWarning,
    },
  };
}

/**
 * Serialize a message for storage.
 */
export function serializeMessage(message: ChannelMessage): SerializableChannelMessage {
  return {
    ...message,
    timestamp: message.timestamp.toISOString(),
  };
}

/**
 * Deserialize a message from storage.
 */
export function deserializeMessage(data: SerializableChannelMessage): ChannelMessage {
  return {
    ...data,
    timestamp: new Date(data.timestamp),
  };
}
