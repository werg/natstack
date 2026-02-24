/**
 * Types for the PubSub client.
 */

import type { AgentManifest } from "@natstack/types";

/**
 * Channel configuration persisted with the channel.
 * Set when the channel is created, readable by all participants.
 *
 * Note: contextId is NOT part of ChannelConfig. The server sends contextId
 * as a separate top-level field in the ready message. Access it via client.contextId.
 */
export interface ChannelConfig {
  title?: string;
}

/**
 * Input for sending a binary attachment (ID assigned by server).
 * Use this when publishing messages with attachments.
 */
export interface AttachmentInput {
  /** Binary data */
  data: Uint8Array;
  /** MIME type (e.g., "image/png", "application/octet-stream") */
  mimeType: string;
  /** Optional filename */
  name?: string;
}

/**
 * A binary attachment with server-assigned metadata.
 * This is what you receive in messages - the server assigns the ID.
 */
export interface Attachment extends AttachmentInput {
  /** Server-assigned unique ID (e.g., "img_1", "img_2") */
  id: string;
}

/**
 * Error codes for PubSub operations.
 */
export type PubSubErrorCode = "auth" | "validation" | "connection" | "server" | "timeout";

/**
 * Typed error for PubSub operations.
 * Allows programmatic distinction between different error types.
 */
export class PubSubError extends Error {
  constructor(
    message: string,
    public readonly code: PubSubErrorCode
  ) {
    super(message);
    this.name = "PubSubError";
  }
}

/**
 * A message received from the PubSub server.
 */
export interface PubSubMessage<T = unknown> {
  /** Message kind: replay (historical), persisted (new + saved), or ephemeral (not saved) */
  kind: "replay" | "persisted" | "ephemeral";
  /** Message ID (only present for persisted/replay messages) */
  id?: number;
  /** User-defined message type */
  type: string;
  /** Message payload (JSON-serializable value) */
  payload: T;
  /** ID of the sender */
  senderId: string;
  /** Timestamp in milliseconds */
  ts: number;
  /** Binary attachments (separate from JSON payload) */
  attachments?: Attachment[];
  /** Sender metadata snapshot (if available) */
  senderMetadata?: Record<string, unknown>;
}

/**
 * Stream marker emitted after replay completes.
 */
export interface ReadyMessage {
  kind: "ready";
  /** Total message count for pagination */
  totalCount?: number;
  /** Count of type="message" events only, for accurate chat pagination */
  chatMessageCount?: number;
  /** ID of the first chat message in the channel (for pagination boundary) */
  firstChatMessageId?: number;
}

/**
 * Response to get-messages-before request (for pagination).
 * Note: This is not part of the Message union type since it's returned
 * via getMessagesBefore() promise, not the messages() iterator.
 */
export interface MessagesBeforeResponse {
  kind: "messages-before";
  messages: Array<{
    id: number;
    type: string;
    payload: unknown;
    senderId: string;
    ts: number;
    senderMetadata?: Record<string, unknown>;
    attachments?: Attachment[];
  }>;
  trailingUpdates?: Array<{
    id: number;
    type: string;
    payload: unknown;
    senderId: string;
    ts: number;
    senderMetadata?: Record<string, unknown>;
    attachments?: Attachment[];
  }>;
  hasMore: boolean;
}

export type Message<T = unknown> = PubSubMessage<T> | ReadyMessage;

/**
 * Participant metadata - arbitrary key-value data associated with a connected client.
 */
export type ParticipantMetadata = Record<string, unknown>;

/**
 * A participant in a channel with their metadata.
 */
export interface Participant<T extends ParticipantMetadata = ParticipantMetadata> {
  /** The client's unique ID */
  id: string;
  /** Arbitrary metadata provided by the client on connection */
  metadata: T;
}

/**
 * Reason a participant left the channel.
 * - "graceful": Clean shutdown (e.g., idle timeout, explicit stop)
 * - "disconnect": Unexpected disconnection (crash, network loss)
 */
export type LeaveReason = "graceful" | "disconnect";

/**
 * Describes what triggered a roster update.
 * Present on roster updates caused by a single presence event.
 */
export interface RosterChange {
  /** The type of change */
  type: "join" | "leave" | "update";
  /** The participant ID that changed */
  participantId: string;
  /** Participant metadata at the time of the change */
  metadata?: Record<string, unknown>;
  /** Why the participant left (only present for leave events) */
  leaveReason?: LeaveReason;
}

/**
 * Roster update from the server.
 * Sent whenever a client joins or leaves the channel.
 * This is idempotent - it contains the complete current state.
 */
export interface RosterUpdate<T extends ParticipantMetadata = ParticipantMetadata> {
  /** Map of client ID to participant info (including metadata) */
  participants: Record<string, Participant<T>>;
  /** Timestamp of the update */
  ts: number;
  /** What triggered this update (absent during initial catch-up emit on handler registration) */
  change?: RosterChange;
  /** Participants that left in this update, with reason (only present on leave events) */
  leaves?: Record<string, { leaveReason?: "graceful" | "disconnect" }>;
}

/**
 * Options for publishing a message.
 */
export interface PublishOptions {
  /** Whether to persist the message to SQLite. Default: true */
  persist?: boolean;
  /** Timeout in milliseconds for the publish operation. Default: 30000 */
  timeoutMs?: number;
  /** Binary attachments to send alongside JSON payload (server assigns IDs) */
  attachments?: AttachmentInput[];
}

/**
 * Options for updating participant metadata.
 */
export interface UpdateMetadataOptions {
  /** Timeout in milliseconds for the update operation. Default: 30000 */
  timeoutMs?: number;
}

/**
 * Configuration for automatic reconnection.
 */
export interface ReconnectConfig {
  /** Initial reconnect delay in ms. Default: 1000 */
  delayMs?: number;
  /** Maximum reconnect delay in ms (for exponential backoff). Default: 30000 */
  maxDelayMs?: number;
  /** Maximum reconnection attempts (0 = infinite). Default: 0 */
  maxAttempts?: number;
}

/**
 * Options for connecting to a channel.
 */
export interface ConnectOptions<T extends ParticipantMetadata = ParticipantMetadata> {
  /** Channel name to subscribe to */
  channel: string;
  /** Context ID for channel creators (triggers channel creation in database). Joiners get contextId from server. */
  contextId?: string;
  /** Channel config to set when creating a new channel (ignored for existing channels) */
  channelConfig?: ChannelConfig;
  /** Replay messages with id > sinceId */
  sinceId?: number;
  /** Limit initial replay to the N most recent chat messages (server computes anchor). sinceId takes precedence when both are set. */
  replayMessageLimit?: number;
  /** Enable auto-reconnection. Pass true for defaults, or a config object. Default: false */
  reconnect?: boolean | ReconnectConfig;
  /** Metadata to associate with this participant. Sent to all other participants in roster updates. */
  metadata?: T;
  /** This client's ID (used for skipOwnMessages filtering) */
  clientId?: string;
  /** Skip messages sent by this client (echo suppression). Requires clientId to be set. Default: false */
  skipOwnMessages?: boolean;
}

// =============================================================================
// Agent Protocol Types
// =============================================================================

/**
 * Agent instance info (running agent on a channel).
 * Used in channel-agents responses.
 */
export interface AgentInstanceSummary {
  /** Unique instance ID (UUID) */
  instanceId: string;
  /** Agent type ID (matches AgentManifest.id) */
  agentId: string;
  /** Handle used in channel */
  handle: string;
  /** Unix timestamp when started */
  startedAt: number;
}

/**
 * Options for inviting an agent to a channel.
 */
export interface InviteAgentOptions {
  /** Handle to use in channel (defaults to agentId) */
  handle?: string;
  /** Agent configuration parameters */
  config?: Record<string, unknown>;
  /** Timeout in milliseconds (default: 30000) */
  timeoutMs?: number;
}

// AgentBuildError canonical source: @natstack/types
import type { AgentBuildError } from "@natstack/types";

/**
 * Result of inviting an agent.
 */
export interface InviteAgentResult {
  /** Whether the invite succeeded */
  success: boolean;
  /** Instance ID of the spawned agent (on success) */
  instanceId?: string;
  /** Error message (on failure) */
  error?: string;
  /** Structured build error with full diagnostics (on failure) */
  buildError?: AgentBuildError;
}

/**
 * Result of removing an agent.
 */
export interface RemoveAgentResult {
  /** Whether the removal succeeded */
  success: boolean;
  /** Error message (on failure) */
  error?: string;
}

/**
 * Response to list-agents request.
 */
export interface ListAgentsResponse {
  kind: "list-agents-response";
  ref: number;
  agents: AgentManifest[];
}

/**
 * Response to invite-agent request.
 */
export interface InviteAgentResponse {
  kind: "invite-agent-response";
  ref: number;
  success: boolean;
  instanceId?: string;
  error?: string;
  /** Structured build error with full diagnostics (on failure) */
  buildError?: AgentBuildError;
}

/**
 * Response to channel-agents request.
 */
export interface ChannelAgentsResponse {
  kind: "channel-agents-response";
  ref: number;
  agents: AgentInstanceSummary[];
}

/**
 * Response to remove-agent request.
 */
export interface RemoveAgentResponse {
  kind: "remove-agent-response";
  ref: number;
  success: boolean;
  error?: string;
}

