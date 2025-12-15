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
export interface Message<T = unknown> {
  /** Message kind: replay (historical), persisted (new + saved), or ephemeral (not saved) */
  kind: "replay" | "persisted" | "ephemeral";
  /** Message ID (only present for persisted/replay messages) */
  id?: number;
  /** User-defined message type */
  type: string;
  /** Message payload */
  payload: T;
  /** ID of the sender */
  senderId: string;
  /** Timestamp in milliseconds */
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
export interface ConnectOptions {
  /** Channel name to subscribe to */
  channel: string;
  /** Replay messages with id > sinceId */
  sinceId?: number;
  /** Enable auto-reconnection. Pass true for defaults, or a config object. Default: false */
  reconnect?: boolean | ReconnectConfig;
}
