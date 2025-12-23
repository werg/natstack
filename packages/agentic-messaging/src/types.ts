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
 * Extends base pubsub metadata with name, type, and optional tool advertisements.
 */
export interface AgenticParticipantMetadata extends ParticipantMetadata {
  /** Display name for this participant */
  name: string;
  /** Participant type (e.g., "panel", "worker", "agent") */
  type: string;
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
  | "connection-error";

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
 * An incoming tool call (for tool providers).
 */
export interface IncomingToolCall {
  /** Message kind */
  kind: "replay" | "persisted" | "ephemeral";
  /** ID of the caller */
  senderId: string;
  /** Timestamp */
  ts: number;
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
 * Tool definition formatted for AI SDK integration.
 * Ready to pass to LLM tool-use APIs.
 */
export interface AIToolDefinition {
  /** Tool description */
  description?: string;
  /** JSON Schema for arguments */
  parameters: JsonSchema;
  /** Execute the tool (calls through to callTool) */
  execute: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
}

/**
 * Information about a tool name conflict when building AI tools.
 */
export interface ToolConflict {
  /** The conflicting tool name */
  name: string;
  /** All tools that share this name */
  tools: DiscoveredTool[];
}

/**
 * Callback to resolve tool name conflicts.
 * Receives conflict info and returns a map of providerId -> resolvedName.
 * Return undefined for a tool to exclude it from the result.
 */
export type ConflictResolver = (conflict: ToolConflict) => Record<string, string | undefined>;

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
  /** Channel name to connect to */
  channel: string;
  /** Replay messages with id > sinceId */
  sinceId?: number;
  /** Enable auto-reconnection. Pass true for defaults, or a config object. */
  reconnect?: boolean | { delayMs?: number; maxDelayMs?: number; maxAttempts?: number };
  /** Participant metadata (name, type, and any custom fields) */
  metadata: Omit<T, "tools"> & Partial<Pick<T, "tools">>;
  /** Tools this participant provides. Automatically executed when called. */
  tools?: Record<string, ToolDefinition>;
  /** This client's ID (for skipOwnMessages filtering) */
  clientId?: string;
  /** Skip messages sent by this client (echo suppression) */
  skipOwnMessages?: boolean;
}

/**
 * Agentic messaging client.
 * Provides messaging, tool discovery, and tool invocation APIs.
 */
export interface AgenticClient<T extends AgenticParticipantMetadata = AgenticParticipantMetadata> {
  // === Messaging API ===

  /** Async iterator for incoming messages */
  messages(): AsyncIterableIterator<IncomingMessage>;

  /** Send a new message. Returns the message ID. */
  send(
    content: string,
    options?: {
      replyTo?: string;
      persist?: boolean;
      attachment?: Uint8Array;
      contentType?: string;
    }
  ): Promise<string>;

  /** Update an existing message (for streaming) */
  update(
    id: string,
    content: string,
    options?: { complete?: boolean; persist?: boolean; attachment?: Uint8Array; contentType?: string }
  ): Promise<void>;

  /** Mark a message as complete */
  complete(id: string): Promise<void>;

  /** Mark a message as errored */
  error(id: string, error: string, code?: string): Promise<void>;

  // === Tool Discovery & Invocation API ===

  /** Discover tool definitions advertised by all participants. */
  discoverToolDefs(): DiscoveredTool[];

  /** Discover tool definitions advertised by a specific participant. */
  discoverToolDefsFrom(providerId: string): DiscoveredTool[];

  /** Call a tool on another participant. Returns a handle for the result. */
  callTool(
    providerId: string,
    toolName: string,
    args: unknown,
    options?: { signal?: AbortSignal; validateArgs?: z.ZodTypeAny; timeoutMs?: number }
  ): ToolCallResult;

  /** Collect all discovered tools as executable definitions (for LLM integration). */
  collectExecutableTools(onConflict?: ConflictResolver): Record<string, AIToolDefinition>;

  // === Roster API ===

  /** Current roster of participants */
  readonly roster: Record<string, Participant<T>>;

  /** Subscribe to roster updates */
  onRoster(handler: (roster: RosterUpdate<T>) => void): () => void;

  /** Subscribe to incoming tool calls for tools provided by this client */
  onToolCall(handler: (call: IncomingToolCall) => void): () => void;

  /** Subscribe to all incoming tool calls on the channel */
  onAnyToolCall(handler: (call: IncomingToolCall) => void): () => void;

  /** Subscribe to incoming tool result chunks on the channel */
  onToolResult(handler: (result: IncomingToolResult) => void): () => void;

  // === Connection API ===

  /** Whether currently connected */
  readonly connected: boolean;

  /** Whether currently attempting to reconnect */
  readonly reconnecting: boolean;

  /** Wait for the ready signal (replay complete) */
  ready(timeoutMs?: number): Promise<void>;

  /** Close the connection */
  close(): void;

  /** Subscribe to errors */
  onError(handler: (error: Error) => void): () => void;

  /** Subscribe to disconnect events */
  onDisconnect(handler: () => void): () => void;

  /** Subscribe to reconnect events */
  onReconnect(handler: () => void): () => void;

  /** Underlying transport client (escape hatch). */
  readonly pubsub: PubSubClient<T>;
}
