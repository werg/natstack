/**
 * @natstack/agentic-messaging types
 *
 * Agentic messaging protocol for tool discovery, invocation, and streaming
 * results between distributed participants over pubsub.
 */

import type { Participant, ParticipantMetadata, PubSubClient, RosterUpdate } from "@natstack/pubsub";
import type { z } from "zod";

/** JSON Schema representation for tool parameters/returns. */
export type JsonSchema = Record<string, unknown>;

/**
 * Participant metadata for agentic messaging.
 * Extends base pubsub metadata with name, type, handle, and optional tool advertisements.
 */
export interface AgenticParticipantMetadata extends ParticipantMetadata {
  /** Display name for this participant */
  name: string;
  /** Participant type (e.g., "panel", "worker", "agent") */
  type: string;
  /**
   * Unique handle for @-mentions (e.g., "claude", "codex", "user").
   * Must be unique within the channel. Conflicts cause connection errors.
   */
  handle: string;
  /** Tools this participant provides (auto-populated from ConnectOptions.tools) */
  tools?: ToolAdvertisement[];
}

/**
 * Tool advertisement in participant metadata.
 * Describes a tool that can be invoked on this participant.
 */
export interface ToolAdvertisement {
  /** Tool name (unique within this provider) */
  name: string;
  /** Human-readable description */
  description?: string;
  /** JSON Schema for tool arguments */
  parameters: JsonSchema;
  /** JSON Schema for return value */
  returns?: JsonSchema;
  /** Whether this tool can stream partial results */
  streaming?: boolean;
  /** Suggested timeout in milliseconds */
  timeout?: number;
}

/**
 * Error codes for agentic operations.
 */
export type AgenticErrorCode =
  | "tool-not-found"
  | "provider-not-found"
  | "provider-offline"
  | "execution-error"
  | "timeout"
  | "cancelled"
  | "validation-error"
  | "connection-error"
  | "handle-conflict";

/**
 * Error class for agentic messaging operations.
 * Includes a machine-readable error code for programmatic handling.
 */
export class AgenticError extends Error {
  constructor(
    message: string,
    public readonly code: AgenticErrorCode,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "AgenticError";
  }
}

/**
 * Error thrown when message validation fails.
 * Includes direction (send/receive) and validation details.
 */
export class ValidationError extends Error {
  constructor(
    message: string,
    public readonly direction: "send" | "receive",
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "ValidationError";
  }
}

/**
 * Union type for all incoming message types.
 */
export type IncomingMessage =
  | IncomingNewMessage
  | IncomingUpdateMessage
  | IncomingErrorMessage;

/**
 * Execution pause event with discriminant type field.
 */
export interface IncomingExecutionPauseEvent {
  type: "execution-pause";
  /** Message ID being paused */
  messageId: string;
  /** Current pause status */
  status: PauseStatus;
  /** Optional reason for the pause */
  reason?: string;
  /** Message kind */
  kind: "replay" | "persisted" | "ephemeral";
  /** ID of the sender */
  senderId: string;
  /** Timestamp in milliseconds */
  ts: number;
  /** Server-assigned ID for checkpointing */
  pubsubId?: number;
  /** Sender metadata snapshot (if available) */
  senderMetadata?: {
    name?: string;
    type?: string;
    handle?: string;
  };
}

/**
 * Union type for all incoming event types (messages, tool calls, tool results, presence).
 * Use the `type` field to discriminate between event types.
 */
export type IncomingEvent =
  | IncomingNewMessage
  | IncomingUpdateMessage
  | IncomingErrorMessage
  | IncomingToolCallEvent
  | IncomingToolResultEvent
  | IncomingPresenceEventWithType
  | IncomingExecutionPauseEvent;

/**
 * Tool call event with discriminant type field.
 */
export interface IncomingToolCallEvent extends IncomingToolCall {
  type: "tool-call";
}

/**
 * Tool result event with discriminant type field.
 */
export interface IncomingToolResultEvent extends IncomingToolResult {
  type: "tool-result";
}

/**
 * Presence event with discriminant type field.
 */
export interface IncomingPresenceEventWithType extends IncomingPresenceEvent {
  type: "presence";
}

/**
 * Options for filtering events in the events() iterator.
 */
export interface EventFilterOptions {
  /**
   * Only yield message events where `at` includes this client's ID, or `at` is undefined (broadcast).
   * When false/undefined, all events are yielded regardless of `at`.
   * Note: Non-message events (tool-call, tool-result, presence) are always yielded.
   */
  targetedOnly?: boolean;
  /**
   * When targetedOnly is true, also yield non-targeted messages if this client
   * is the only non-panel participant in the channel.
   * Useful for agents that should respond when they're the sole responder.
   */
  respondWhenSolo?: boolean;
  /**
   * Callback invoked for events that are filtered out.
   * Useful for logging or debugging filtered events.
   */
  onFiltered?: (event: IncomingEvent) => void;
}

/**
 * Base properties shared by all incoming messages.
 */
export interface IncomingBase {
  /** Message kind: replay (historical), persisted (new + saved), or ephemeral */
  kind: "replay" | "persisted" | "ephemeral";
  /** ID of the sender */
  senderId: string;
  /** Timestamp in milliseconds */
  ts: number;
  /** Binary attachment (optional) */
  attachment?: Uint8Array;
  /** Server-assigned ID for checkpointing */
  pubsubId?: number;
  /** Sender metadata snapshot (if available) */
  senderMetadata?: {
    name?: string;
    type?: string;
    handle?: string;
  };
}

/**
 * A new message in the conversation.
 */
export interface IncomingNewMessage extends IncomingBase {
  type: "message";
  /** Unique message ID */
  id: string;
  /** Message content */
  content: string;
  /** ID of message being replied to */
  replyTo?: string;
  /** MIME type for attachment */
  contentType?: string;
  /** IDs of intended recipients (empty/undefined = broadcast to all) */
  at?: string[];
}

/**
 * An update to an existing message (for streaming).
 */
export interface IncomingUpdateMessage extends IncomingBase {
  type: "update-message";
  /** ID of the message being updated */
  id: string;
  /** Content to append (if any) */
  content?: string;
  /** Whether the message is now complete */
  complete?: boolean;
  /** MIME type for attachment */
  contentType?: string;
}

/**
 * An error marker for a message.
 */
export interface IncomingErrorMessage extends IncomingBase {
  type: "error";
  /** ID of the message that errored */
  id: string;
  /** Error message */
  error: string;
  /** Machine-readable error code */
  code?: string;
}

/**
 * Presence event actions.
 */
export type PresenceAction = "join" | "leave" | "update";

/**
 * An incoming presence event (join/leave/update).
 * These events are persisted and replayed to reconstruct participant history.
 */
export interface IncomingPresenceEvent {
  /** Message kind */
  kind: "replay" | "persisted" | "ephemeral";
  /** ID of the participant */
  senderId: string;
  /** Timestamp */
  ts: number;
  /** Server-assigned ID for checkpointing */
  pubsubId?: number;
  /** Sender metadata snapshot (if available) */
  senderMetadata?: {
    name?: string;
    type?: string;
    handle?: string;
  };
  /** The action */
  action: PresenceAction;
  /** Participant metadata at the time of the event */
  metadata: ParticipantMetadata;
}

/**
 * An incoming tool call (for tool providers).
 */
export interface IncomingToolCall {
  /** Message kind */
  kind: "replay" | "persisted" | "ephemeral";
  /** ID of the caller */
  senderId: string;
  /** Timestamp */
  ts: number;
  /** Server-assigned ID for checkpointing */
  pubsubId?: number;
  /** Sender metadata snapshot (if available) */
  senderMetadata?: {
    name?: string;
    type?: string;
    handle?: string;
  };
  /** Unique call ID for correlation */
  callId: string;
  /** Name of the tool being called */
  toolName: string;
  /** Target provider ID (this client) */
  providerId: string;
  /** Tool arguments */
  args: unknown;
}

/**
 * An incoming tool result chunk.
 */
export interface IncomingToolResult {
  /** Message kind */
  kind: "replay" | "persisted" | "ephemeral";
  /** ID of the sender */
  senderId: string;
  /** Timestamp */
  ts: number;
  /** Server-assigned ID for checkpointing */
  pubsubId?: number;
  /** Sender metadata snapshot (if available) */
  senderMetadata?: {
    name?: string;
    type?: string;
    handle?: string;
  };
  /** Call ID for correlation */
  callId: string;
  /** Result content */
  content?: unknown;
  /** MIME type for attachment */
  contentType?: string;
  /** Whether this is the final chunk */
  complete: boolean;
  /** Whether this chunk represents an error */
  isError: boolean;
  /** Progress percentage (0-100) */
  progress?: number;
  /** Binary attachment (optional) */
  attachment?: Uint8Array;
}

/**
 * Aggregated replay event base.
 */
export interface AggregatedEventBase {
  pubsubId: number;
  senderId: string;
  senderName?: string;
  senderType?: string;
  senderHandle?: string;
  ts: number;
}

export interface AggregatedMessage extends AggregatedEventBase {
  type: "message";
  id: string;
  content: string;
  complete: boolean;
  incomplete: boolean;
  replyTo?: string;
}

export interface AggregatedToolCall extends AggregatedEventBase {
  type: "tool-call";
  callId: string;
  toolName: string;
  providerId: string;
  providerName?: string;
  args: unknown;
}

export interface AggregatedToolResult extends AggregatedEventBase {
  type: "tool-result";
  callId: string;
  toolName?: string;
  status: "success" | "error" | "incomplete";
  content?: unknown;
  errorMessage?: string;
}

export type AggregatedEvent = AggregatedMessage | AggregatedToolCall | AggregatedToolResult;

export interface FormatOptions {
  maxChars?: number;
  format?: "yaml" | "markdown";
  includeToolArgs?: boolean;
  includeToolResults?: boolean;
  maxToolResultChars?: number;
}

export interface MissedContext {
  count: number;
  formatted: string;
  lastPubsubId: number;
  wasElided: boolean;
  events: AggregatedEvent[];
}

/**
 * Final value from a tool call.
 */
export interface ToolResultValue {
  /** Result content (JSON-serializable) */
  content: unknown;
  /** Binary attachment */
  attachment?: Uint8Array;
  /** MIME type for attachment */
  contentType?: string;
}

/**
 * A chunk from a streaming tool result.
 */
export interface ToolResultChunk extends ToolResultValue {
  /** Whether this is the final chunk */
  complete: boolean;
  /** Whether this chunk represents an error */
  isError: boolean;
  /** Progress percentage (0-100) */
  progress?: number;
}

/**
 * Handle for an in-flight tool call.
 * Provides access to the result, streaming chunks, and cancellation.
 */
export interface ToolCallResult {
  /** Unique call ID */
  readonly callId: string;
  /** Promise that resolves with the final result */
  readonly result: Promise<ToolResultValue>;
  /** Async iterator for streaming chunks */
  readonly stream: AsyncIterable<ToolResultChunk>;
  /** Cancel the tool call */
  cancel(): Promise<void>;
  /** Whether the call has completed */
  readonly complete: boolean;
  /** Whether the call resulted in an error */
  readonly isError: boolean;
}

/**
 * A discovered tool from the roster.
 * Contains all information needed to invoke the tool.
 */
export interface DiscoveredTool {
  /** Provider's client ID */
  providerId: string;
  /** Provider's display name */
  providerName: string;
  /** Tool name */
  name: string;
  /** Tool description */
  description?: string;
  /** JSON Schema for arguments */
  parameters: JsonSchema;
  /** JSON Schema for return value */
  returns?: JsonSchema;
  /** Whether tool supports streaming */
  streaming: boolean;
  /** Suggested timeout in ms */
  timeout?: number;
}

/**
 * Context provided to tool execute functions.
 * Includes utilities for streaming results, progress, and cancellation.
 */
export interface ToolExecutionContext {
  /** Unique call ID */
  callId: string;
  /** Caller's client ID */
  callerId: string;
  /** Abort signal (aborted when caller cancels) */
  signal: AbortSignal;
  /** Stream a partial result */
  stream(content: unknown): Promise<void>;
  /** Stream a partial result with binary attachment */
  streamWithAttachment(
    content: unknown,
    attachment: Uint8Array,
    options?: { contentType?: string }
  ): Promise<void>;
  /** Create a final result with binary attachment */
  resultWithAttachment<T>(
    content: T,
    attachment: Uint8Array,
    options?: { contentType?: string }
  ): ToolResultWithAttachment<T>;
  /** Report progress (0-100) */
  progress(percent: number): Promise<void>;
}

/**
 * A tool result with an attached binary payload.
 * Returned from context.resultWithAttachment().
 */
export interface ToolResultWithAttachment<T> {
  content: T;
  attachment: Uint8Array;
  contentType?: string;
}

/**
 * Definition for a tool this client provides.
 * Tools are registered at connection time via ConnectOptions.tools.
 */
export interface ToolDefinition<TArgs extends z.ZodTypeAny = z.ZodTypeAny, TResult = unknown> {
  /** Human-readable description */
  description?: string;
  /** Zod schema for argument validation */
  parameters: TArgs;
  /** Zod schema for result validation (optional) */
  returns?: z.ZodTypeAny;
  /** Whether this tool streams partial results */
  streaming?: boolean;
  /** Suggested timeout in milliseconds */
  timeout?: number;
  /** Execute the tool. Automatically called when tool is invoked. */
  execute: (args: z.infer<TArgs>, context: ToolExecutionContext) => Promise<TResult>;
}

/**
 * Options for connecting to an agentic messaging channel.
 */
export interface ConnectOptions<T extends AgenticParticipantMetadata = AgenticParticipantMetadata> {
  /** Pubsub server URL */
  serverUrl: string;
  /** Authentication token */
  token: string;
  /** Channel name to connect to */
  channel: string;

  /** Unique handle for @-mentions */
  handle: string;
  /** Display name */
  name: string;
  /** Participant type */
  type: string;

  /** Additional metadata (optional) */
  extraMetadata?: Record<string, unknown>;

  /** Workspace ID for session persistence (optional) */
  workspaceId?: string;

  /** Tools this participant provides. Automatically executed when called. */
  tools?: Record<string, ToolDefinition>;

  /** Enable auto-reconnection. Pass true for defaults, or a config object. */
  reconnect?: boolean | { delayMs?: number; maxDelayMs?: number; maxAttempts?: number };

  /** Replay behavior: collect (default), stream, or skip */
  replayMode?: "collect" | "stream" | "skip";

  /** This client's ID (for skipOwnMessages filtering) */
  clientId?: string;
  /** Skip messages sent by this client (echo suppression) */
  skipOwnMessages?: boolean;
}

export interface SendResult {
  /** UUID for message correlation */
  messageId: string;
  /** Server-assigned ID for checkpointing */
  pubsubId: number | undefined;
}

export interface EventStreamOptions extends EventFilterOptions {
  includeReplay?: boolean;
  includeEphemeral?: boolean;
}

export type EventStreamItem = IncomingEvent | AggregatedEvent;

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Agentic messaging client.
 * Provides messaging, tool discovery, and tool invocation APIs.
 */
export interface AgenticClient<T extends AgenticParticipantMetadata = AgenticParticipantMetadata> {
  // === Identity ===
  readonly handle: string;
  readonly clientId: string | null;

  // === Session State (undefined if workspaceId not provided) ===
  /** Whether session persistence is enabled and operational */
  readonly sessionEnabled: boolean;
  readonly sessionKey: string | undefined;
  readonly checkpoint: number | undefined;
  readonly sdkSessionId: string | undefined;
  readonly status: "active" | "interrupted" | undefined;

  // === Replay ===
  readonly missedMessages: AggregatedEvent[];
  formatMissedContext(options?: FormatOptions): MissedContext;
  getMissedByType<K extends AggregatedEvent["type"]>(
    type: K
  ): Extract<AggregatedEvent, { type: K }>[];

  // === Events ===
  events(options?: EventStreamOptions): AsyncIterableIterator<EventStreamItem>;

  // === Two-Phase Commit ===
  commitCheckpoint(pubsubId: number): Promise<void>;
  updateSdkSession(sessionId: string): Promise<void>;
  clearSdkSession(): Promise<void>;

  // === Messaging ===
  send(
    content: string,
    options?: {
      replyTo?: string;
      persist?: boolean;
      attachment?: Uint8Array;
      contentType?: string;
      /** IDs of intended recipients (omit for broadcast to all) */
      at?: string[];
      /** Resolve @handle mentions to participant IDs */
      resolveHandles?: boolean;
    }
  ): Promise<SendResult>;

  update(
    id: string,
    content: string,
    options?: { complete?: boolean; persist?: boolean; attachment?: Uint8Array; contentType?: string }
  ): Promise<number | undefined>;

  complete(id: string): Promise<number | undefined>;

  error(id: string, error: string, code?: string): Promise<number | undefined>;

  // === Manual History ===
  storeMessage(role: "user" | "assistant", content: string): Promise<void>;
  getHistory(limit?: number): Promise<ConversationMessage[]>;
  clearHistory(): Promise<void>;

  // === Tool Discovery & Invocation ===
  discoverToolDefs(): DiscoveredTool[];
  discoverToolDefsFrom(providerId: string): DiscoveredTool[];
  callTool(
    providerId: string,
    toolName: string,
    args: unknown,
    options?: { signal?: AbortSignal; validateArgs?: z.ZodTypeAny; timeoutMs?: number }
  ): ToolCallResult;

  // === Roster ===
  readonly roster: Record<string, Participant<T>>;
  resolveHandles(handles: string[]): string[];
  getParticipantByHandle(handle: string): string | undefined;
  onRoster(handler: (roster: RosterUpdate<T>) => void): () => void;

  // === Lifecycle ===
  readonly connected: boolean;
  readonly reconnecting: boolean;
  close(): Promise<void>;
  onError(handler: (error: Error) => void): () => void;
  onDisconnect(handler: () => void): () => void;
  onReconnect(handler: () => void): () => void;

  // === Low-level ===
  readonly pubsub: PubSubClient<T>;
  sendToolResult(
    callId: string,
    content: unknown,
    options?: {
      complete?: boolean;
      isError?: boolean;
      progress?: number;
      attachment?: Uint8Array;
      contentType?: string;
    }
  ): Promise<void>;
}

/**
 * Status of an execution pause.
 */
export type PauseStatus = "paused" | "resumed" | "cancelled";
