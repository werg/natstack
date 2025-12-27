/**
 * Types for the PubSub client.
 */

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
  /** Binary attachment (separate from JSON payload) */
  attachment?: Uint8Array;
  /** Sender metadata snapshot (if available) */
  senderMetadata?: Record<string, unknown>;
}

/**
 * Stream marker emitted after replay completes.
 */
export interface ReadyMessage {
  kind: "ready";
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
 * Roster update from the server.
 * Sent whenever a client joins or leaves the channel.
 * This is idempotent - it contains the complete current state.
 */
export interface RosterUpdate<T extends ParticipantMetadata = ParticipantMetadata> {
  /** Map of client ID to participant info (including metadata) */
  participants: Record<string, Participant<T>>;
  /** Timestamp of the update */
  ts: number;
}

/**
 * Options for publishing a message.
 */
export interface PublishOptions {
  /** Whether to persist the message to SQLite. Default: true */
  persist?: boolean;
  /** Timeout in milliseconds for the publish operation. Default: 30000 */
  timeoutMs?: number;
  /** Binary attachment to send alongside JSON payload */
  attachment?: Uint8Array;
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
  /** Replay messages with id > sinceId */
  sinceId?: number;
  /** Enable auto-reconnection. Pass true for defaults, or a config object. Default: false */
  reconnect?: boolean | ReconnectConfig;
  /** Metadata to associate with this participant. Sent to all other participants in roster updates. */
  metadata?: T;
  /** This client's ID (used for skipOwnMessages filtering) */
  clientId?: string;
  /** Skip messages sent by this client (echo suppression). Requires clientId to be set. Default: false */
  skipOwnMessages?: boolean;
}
