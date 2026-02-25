/**
 * @workspace/agentic-messaging types
 *
 * Agentic messaging protocol for method discovery, invocation, and streaming
 * results between distributed participants over pubsub.
 */

import type {
  Participant,
  ParticipantMetadata,
  RosterUpdate,
  RosterChange,
  LeaveReason,
  Attachment,
  AttachmentInput,
  ChannelConfig,
  AgentInstanceSummary,
  InviteAgentOptions,
  InviteAgentResult,
  RemoveAgentResult,
} from "@natstack/pubsub";
import type { AgentBuildError } from "@natstack/types";
import type { AgentManifest } from "@natstack/types";
import type { z } from "zod";

// Re-export types from pubsub for convenience
export type {
  Attachment,
  AttachmentInput,
  ChannelConfig,
  AgentInstanceSummary,
  InviteAgentOptions,
  InviteAgentResult,
  RemoveAgentResult,
  RosterUpdate,
  RosterChange,
  LeaveReason,
  AgentBuildError,
};
export type { AgentManifest } from "@natstack/types";

/** JSON Schema representation for method parameters/returns. */
export type JsonSchema = Record<string, unknown>;

/**
 * Standard participant type constants.
 * Use these instead of magic strings for participant type checks.
 */
export const PARTICIPANT_TYPES = {
  PANEL: "panel",
  WORKER: "worker",
  CLAUDE_CODE: "claude-code",
  CODEX: "codex",
  AI_RESPONDER: "ai-responder",
} as const;

export type ParticipantType = typeof PARTICIPANT_TYPES[keyof typeof PARTICIPANT_TYPES];

/**
 * Participant metadata for agentic messaging.
 * Extends base pubsub metadata with name, type, handle, and optional method advertisements.
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
  /** Methods this participant provides (auto-populated from ConnectOptions.methods) */
  methods?: MethodAdvertisement[];
}

/**
 * Method advertisement in participant metadata.
 * Describes a method that can be invoked on this participant.
 */
export interface MethodAdvertisement {
  /** Method name (unique within this provider) */
  name: string;
  /** Human-readable description */
  description?: string;
  /** JSON Schema for method arguments */
  parameters: JsonSchema;
  /** JSON Schema for return value */
  returns?: JsonSchema;
  /** Whether this method can stream partial results */
  streaming?: boolean;
  /** Suggested timeout in milliseconds */
  timeout?: number;
  /** Whether to show this method in participant menu UI */
  menu?: boolean;
}

/**
 * Error codes for agentic operations.
 */
export type AgenticErrorCode =
  | "method-not-found"
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
 * Union type for all incoming event types (messages, method calls, method results, presence).
 * Use the `type` field to discriminate between event types.
 */
export type IncomingEvent =
  | IncomingNewMessage
  | IncomingUpdateMessage
  | IncomingErrorMessage
  | IncomingMethodCallEvent
  | IncomingMethodResultEvent
  | IncomingPresenceEventWithType
  | IncomingExecutionPauseEvent
  | IncomingAgentDebugEvent;

/**
 * Method call event with discriminant type field.
 */
export interface IncomingMethodCallEvent extends IncomingMethodCall {
  type: "method-call";
}

/**
 * Method result event with discriminant type field.
 */
export interface IncomingMethodResultEvent extends IncomingMethodResult {
  type: "method-result";
}

/**
 * Presence event with discriminant type field.
 */
export interface IncomingPresenceEventWithType extends IncomingPresenceEvent {
  type: "presence";
}

/**
 * Agent debug event payload - discriminated by debugType.
 */
export type AgentDebugPayload =
  | {
      debugType: "output";
      agentId: string;
      handle: string;
      stream: "stdout" | "stderr";
      content: string;
    }
  | {
      debugType: "lifecycle";
      agentId: string;
      handle: string;
      event: "spawning" | "started" | "stopped" | "woken" | "warning";
      reason?: "timeout" | "explicit" | "crash" | "idle" | "dirty-repo";
      /** Additional details for warning events (e.g., dirty repo state) */
      details?: unknown;
    }
  | {
      debugType: "spawn-error";
      agentId: string;
      handle: string;
      error?: string;
      buildError?: AgentBuildError;
    }
  | {
      debugType: "log";
      agentId: string;
      handle: string;
      level: "debug" | "info" | "warn" | "error";
      message: string;
      stack?: string;
    };

/**
 * An incoming agent debug event (ephemeral, not persisted).
 * Uses the message type system for filtering (like "error", "message", etc.)
 */
export interface IncomingAgentDebugEvent extends IncomingBase {
  type: "agent-debug";
  payload: AgentDebugPayload;
}

/**
 * Options for filtering events in the events() iterator.
 */
export interface EventFilterOptions {
  /**
   * Only yield message events where `at` includes this client's ID, or `at` is undefined (broadcast).
   * When false/undefined, all events are yielded regardless of `at`.
   * Note: Non-message events (method-call, method-result, presence) are always yielded.
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
  /** Binary attachments (optional) */
  attachments?: Attachment[];
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
  /** Arbitrary metadata (e.g., SDK session/message UUIDs for recovery) */
  metadata?: Record<string, unknown>;
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

// LeaveReason is re-exported from @natstack/pubsub above

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
  /** Reason for leave (only present when action === "leave") */
  leaveReason?: LeaveReason;
  /** Participant metadata at the time of the event */
  metadata: ParticipantMetadata;
}

/**
 * An incoming method call (for method providers).
 */
export interface IncomingMethodCall {
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
  /** Name of the method being called */
  methodName: string;
  /** Target provider ID (this client) */
  providerId: string;
  /** Method arguments */
  args: unknown;
}

/**
 * An incoming method result chunk.
 */
export interface IncomingMethodResult {
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
  /** MIME type for content (e.g., "application/json") */
  contentType?: string;
  /** Whether this is the final chunk */
  complete: boolean;
  /** Whether this chunk represents an error */
  isError: boolean;
  /** Progress percentage (0-100) */
  progress?: number;
  /** Binary attachments (optional) */
  attachments?: Attachment[];
}

/**
 * Aggregated replay event base.
 * Aggregated events are always replays (historical messages collected during connect).
 */
export interface AggregatedEventBase {
  /** Aggregated events are always replays */
  kind: "replay";
  /** Explicit discriminator — distinguishes aggregated replay from raw IncomingEvent */
  aggregated: true;
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
  /** Content type (e.g., for thinking, action, typing messages) */
  contentType?: string;
  /** Arbitrary metadata (e.g., SDK session/message UUIDs for recovery) */
  metadata?: Record<string, unknown>;
  /** Error state from IncomingErrorMessage (implies completion) */
  error?: string;
}

export interface AggregatedMethodCall extends AggregatedEventBase {
  type: "method-call";
  callId: string;
  methodName: string;
  providerId: string;
  providerName?: string;
  args: unknown;
}

export interface AggregatedMethodResult extends AggregatedEventBase {
  type: "method-result";
  callId: string;
  methodName?: string;
  status: "success" | "error" | "incomplete";
  content?: unknown;
  errorMessage?: string;
}

export type AggregatedEvent = AggregatedMessage | AggregatedMethodCall | AggregatedMethodResult;

/** Type guard to distinguish AggregatedEvent from raw IncomingEvent in EventStreamItem */
export function isAggregatedEvent(event: EventStreamItem): event is AggregatedEvent {
  return "aggregated" in event && (event as AggregatedEventBase).aggregated === true;
}

export interface FormatOptions {
  maxChars?: number;
  format?: "yaml" | "markdown";
  includeMethodArgs?: boolean;
  includeMethodResults?: boolean;
  maxMethodResultChars?: number;
}

export interface MissedContext {
  count: number;
  formatted: string;
  lastPubsubId: number;
  wasElided: boolean;
  events: AggregatedEvent[];
}

/**
 * Final value from a method call.
 */
export interface MethodResultValue {
  /** Result content (JSON-serializable) */
  content: unknown;
  /** Binary attachments */
  attachments?: Attachment[];
  /** MIME type for content */
  contentType?: string;
}

/**
 * A chunk from a streaming method result.
 */
export interface MethodResultChunk extends MethodResultValue {
  /** Whether this is the final chunk */
  complete: boolean;
  /** Whether this chunk represents an error */
  isError: boolean;
  /** Progress percentage (0-100) */
  progress?: number;
}

/**
 * Handle for an in-flight method call.
 * Provides access to the result, streaming chunks, and cancellation.
 */
export interface MethodCallHandle {
  /** Unique call ID */
  readonly callId: string;
  /** Promise that resolves with the final result */
  readonly result: Promise<MethodResultValue>;
  /** Async iterator for streaming chunks */
  readonly stream: AsyncIterable<MethodResultChunk>;
  /** Cancel the method call */
  cancel(): Promise<void>;
  /** Whether the call has completed */
  readonly complete: boolean;
  /** Whether the call resulted in an error */
  readonly isError: boolean;
}

/**
 * A discovered method from the roster.
 * Contains all information needed to invoke the method.
 */
export interface DiscoveredMethod {
  /** Provider's client ID */
  providerId: string;
  /** Provider's display name */
  providerName: string;
  /** Method name */
  name: string;
  /** Method description */
  description?: string;
  /** JSON Schema for arguments */
  parameters: JsonSchema;
  /** JSON Schema for return value */
  returns?: JsonSchema;
  /** Whether method supports streaming */
  streaming: boolean;
  /** Suggested timeout in ms */
  timeout?: number;
  /** Whether this method should only appear in menus, not be used as an AI tool */
  menu?: boolean;
}

/**
 * Context provided to method execute functions.
 * Includes utilities for streaming results, progress, and cancellation.
 */
export interface MethodExecutionContext {
  /** Unique call ID */
  callId: string;
  /** Caller's client ID */
  callerId: string;
  /** Abort signal (aborted when caller cancels) */
  signal: AbortSignal;
  /** Stream a partial result */
  stream(content: unknown): Promise<void>;
  /** Stream a partial result with binary attachments */
  streamWithAttachments(
    content: unknown,
    attachments: AttachmentInput[],
    options?: { contentType?: string }
  ): Promise<void>;
  /** Create a final result with binary attachments */
  resultWithAttachments<T>(
    content: T,
    attachments: AttachmentInput[],
    options?: { contentType?: string }
  ): MethodResultWithAttachments<T>;
  /** Report progress (0-100) */
  progress(percent: number): Promise<void>;
}

/**
 * A method result with attached binary payloads.
 * Returned from context.resultWithAttachments().
 */
export interface MethodResultWithAttachments<T> {
  content: T;
  attachments: AttachmentInput[];
  contentType?: string;
}

/**
 * Definition for a method this client provides.
 * Methods are registered at connection time via ConnectOptions.methods.
 */
export interface MethodDefinition<TArgs extends z.ZodTypeAny = z.ZodTypeAny, TResult = unknown> {
  /** Human-readable description */
  description?: string;
  /** Zod schema for argument validation */
  parameters: TArgs;
  /** Zod schema for result validation (optional) */
  returns?: z.ZodTypeAny;
  /** Whether this method streams partial results */
  streaming?: boolean;
  /** Suggested timeout in milliseconds */
  timeout?: number;
  /** Whether to show this method in participant menu UI */
  menu?: boolean;
  /** Execute the method. Automatically called when method is invoked. */
  execute: (args: z.infer<TArgs>, context: MethodExecutionContext) => Promise<TResult>;
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
  /**
   * Context ID for channel creation. Required for channel creators (workers).
   * Joiners (panels) get contextId from server's ready message via client.contextId.
   */
  contextId?: string;

  /** Unique handle for @-mentions */
  handle: string;
  /** Display name */
  name: string;
  /** Participant type */
  type: string;

  /** Additional metadata (optional) */
  extraMetadata?: Record<string, unknown>;

  /** Channel config to set when creating a new channel */
  channelConfig?: ChannelConfig;

  /** Methods this participant provides. Automatically executed when called. */
  methods?: Record<string, MethodDefinition>;

  /** Enable auto-reconnection. Pass true for defaults, or a config object. */
  reconnect?: boolean | { delayMs?: number; maxDelayMs?: number; maxAttempts?: number };

  /** Replay behavior: collect (default), stream, or skip */
  replayMode?: "collect" | "stream" | "skip";

  /**
   * Resume replay from a specific pubsub message ID (for checkpoint-based recovery).
   *
   * When provided (and replayMode !== "skip"), the server replays messages starting
   * from this ID instead of from the beginning. This enables agents to persist their
   * last processed pubsub ID and resume without full replay on restart.
   *
   * - undefined: Full replay from beginning (default for "collect"/"stream" modes)
   * - number: Resume from this checkpoint (server sends messages with id > replaySinceId)
   *
   * @example
   * ```typescript
   * // Agent persists lastPubsubId in state, uses it on restart:
   * const client = await connect({
   *   ...options,
   *   replayMode: "collect",
   *   replaySinceId: this.state.lastPubsubId, // Resume from checkpoint
   * });
   * ```
   */
  replaySinceId?: number;

  /** Limit initial replay to the N most recent chat messages (server computes anchor). Only applies when replayMode is not "skip". */
  replayMessageLimit?: number;

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

  // === Channel Info ===
  /** Context ID for this channel (from server ready message, authoritative) */
  readonly contextId: string | undefined;
  /** Channel name */
  readonly channel: string;

  // === Session State (undefined if contextId not available from server) ===
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
      attachments?: AttachmentInput[];
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
    options?: { complete?: boolean; persist?: boolean; attachments?: AttachmentInput[]; contentType?: string }
  ): Promise<number | undefined>;

  complete(id: string): Promise<number | undefined>;

  error(id: string, error: string, code?: string): Promise<number | undefined>;

  // === Conversation History (derived from pubsub replay) ===
  getConversationHistory(): ConversationMessage[];
  /** Get messages with full metadata for session recovery correlation */
  getMessagesWithMetadata(): AggregatedMessage[];

  // === Settings Persistence ===
  updateSettings(settings: Record<string, unknown>): Promise<void>;
  getSettings<T = Record<string, unknown>>(): Promise<T | null>;

  // === Method Discovery & Invocation ===
  discoverMethodDefs(): DiscoveredMethod[];
  discoverMethodDefsFrom(providerId: string): DiscoveredMethod[];
  callMethod(
    providerId: string,
    methodName: string,
    args: unknown,
    options?: { signal?: AbortSignal; validateArgs?: z.ZodTypeAny; timeoutMs?: number }
  ): MethodCallHandle;

  // === Roster ===
  readonly roster: Record<string, Participant<T>>;
  resolveHandles(handles: string[]): string[];
  getParticipantByHandle(handle: string): string | undefined;
  onRoster(handler: (roster: RosterUpdate<T>) => void): () => void;

  // === Channel Config ===
  /** Channel config (from server ready message) */
  readonly channelConfig: ChannelConfig | undefined;

  // === Channel Title ===
  /** Set the channel title (updates channel config) */
  setChannelTitle(title: string): Promise<void>;
  /** Subscribe to title changes (via channel config updates) */
  onTitleChange(handler: (title: string) => void): () => void;

  // === Pagination ===
  /** Total message count (from server ready message, for pagination) */
  readonly totalMessageCount: number | undefined;
  /** Count of type="message" events only (excludes protocol chatter), for accurate chat pagination */
  readonly chatMessageCount: number | undefined;
  /** ID of the first chat message in the channel (for pagination boundary) */
  readonly firstChatMessageId: number | undefined;
  /** Get older messages before a given ID (for pagination UI) */
  getMessagesBefore(beforeId: number, limit?: number): Promise<{
    messages: Array<{
      id: number;
      type: string;
      payload: unknown;
      senderId: string;
      ts: number;
      senderMetadata?: Record<string, unknown>;
      attachments?: Attachment[];
    }>;
    hasMore: boolean;
  }>;

  /** Get older messages before a given ID, aggregated (for chat pagination) */
  getAggregatedMessagesBefore(beforeId: number, limit?: number): Promise<{
    messages: AggregatedMessage[];
    hasMore: boolean;
    nextBeforeId?: number;
  }>;

  // === Lifecycle ===
  readonly connected: boolean;
  readonly reconnecting: boolean;
  close(): Promise<void>;
  onError(handler: (error: Error) => void): () => void;
  onDisconnect(handler: () => void): () => void;
  onReconnect(handler: () => void): () => void;
  /** Register ready handler (called on every ready message, including reconnects). Returns unsubscribe function. */
  onReady(handler: () => void): () => void;

  // === Metadata ===
  /** Update this participant's metadata */
  updateMetadata(metadata: T): Promise<void>;

  // === Low-level ===
  /** Publish a custom event to the channel */
  publish(
    eventType: string,
    payload: unknown,
    options?: { persist?: boolean }
  ): Promise<void>;

  sendMethodResult(
    callId: string,
    content: unknown,
    options?: {
      complete?: boolean;
      isError?: boolean;
      progress?: number;
      attachments?: AttachmentInput[];
      contentType?: string;
    }
  ): Promise<void>;

  // === Agent Management ===
  /** List all available agents in the workspace */
  listAgents(timeoutMs?: number): Promise<AgentManifest[]>;
  /** Invite an agent to join this channel */
  inviteAgent(agentId: string, options?: InviteAgentOptions): Promise<InviteAgentResult>;
  /** List agents currently on this channel */
  channelAgents(timeoutMs?: number): Promise<AgentInstanceSummary[]>;
  /** Remove an agent from this channel */
  removeAgent(instanceId: string, timeoutMs?: number): Promise<RemoveAgentResult>;
}

/**
 * Status of an execution pause.
 */
export type PauseStatus = "paused" | "resumed" | "cancelled";
