/**
 * Types for the PubSub client.
 */


/**
 * Channel configuration persisted with the channel.
 * Set when the channel is created, readable by all participants.
 *
 * Note: contextId is NOT part of ChannelConfig. The server sends contextId
 * as a separate top-level field in the ready message. Access it via client.contextId.
 */
export interface ChannelConfig {
  title?: string;
  approvalLevel?: 0 | 1 | 2;  // 0=Ask All, 1=Auto-Safe, 2=Full Auto (default)
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

export type LogRootKind = "chat" | "method" | "presence" | "system";

export interface ServerLogEvent<T = unknown> {
  id: number;
  messageId: string;
  type: string;
  payload: T;
  senderId: string;
  senderMetadata?: Record<string, unknown>;
  contentType?: string;
  ts: number;
  attachments?: Array<{
    id: string;
    type?: string;
    data: string;
    mimeType: string;
    filename?: string;
    size: number;
  }>;
}

export interface ParticipantSnapshot {
  id: string;
  metadata: Record<string, unknown>;
}

export type BootstrapSnapshot =
  | { kind: "roster-snapshot"; participants: ParticipantSnapshot[]; ts: number };

export interface ReplayReady {
  contextId?: string;
  channelConfig?: ChannelConfig;
  totalCount: number;
  envelopeCount: number;
  firstEnvelopeSeq?: number;
  replayFromId?: number;
  replayToId?: number;
  hasMoreBefore?: boolean;
}

export interface ChannelReplayEnvelope {
  mode: "initial" | "after" | "before";
  logEvents: ServerLogEvent[];
  snapshots: BootstrapSnapshot[];
  ready: ReplayReady;
}

/**
 * Error codes for PubSub operations.
 */
export type PubSubErrorCode = "auth" | "validation" | "connection" | "server";

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
  /** Transport stream that produced the message. */
  delivery: "log" | "signal";
  /** Log phase, present only for durable log messages. */
  phase?: "replay" | "live";
  /** Message ID (only present for durable log messages) */
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
  /** Count of replayable channel envelopes. */
  envelopeCount?: number;
  /** First replayable channel-envelope sequence. */
  firstEnvelopeSeq?: number;
  /** Whether older envelopes exist before the replayed window. */
  hasMoreBefore?: boolean;
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
 * - "replaced": Same participant ID was rebound to a new client session
 */
export type LeaveReason = "graceful" | "disconnect" | "replaced";

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
  leaves?: Record<string, { leaveReason?: LeaveReason }>;
}

/**
 * Options for publishing a message.
 */
export interface PublishOptions {
  /** Binary attachments to send alongside JSON payload (server assigns IDs) */
  attachments?: AttachmentInput[];
  /** Caller-provided idempotency key for dedup on retry. Must be stable across retries. */
  idempotencyKey?: string;
}

/**
 * Options for updating participant metadata.
 */
export interface UpdateMetadataOptions {
}
