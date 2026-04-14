/**
 * PubSubClient interface — the contract for pub/sub messaging clients.
 *
 * The sole implementation is connectViaRpc() in rpc-client.ts.
 */

import type {
  Message,
  PublishOptions,
  UpdateMetadataOptions,
  RosterUpdate,
  ParticipantMetadata,
  Participant,
  Attachment,
  ChannelConfig,
} from "./types.js";
import type {
  EventStreamItem,
  EventStreamOptions,
  MethodCallHandle,
} from "./protocol-types.js";

/**
 * PubSub client interface.
 */
export interface PubSubClient<T extends ParticipantMetadata = ParticipantMetadata> {
  /** Async iterator for incoming messages */
  messages(): AsyncIterableIterator<Message>;

  /** Publish a message to the channel. Returns the message ID for persisted messages. */
  publish<P>(type: string, payload: P, options?: PublishOptions): Promise<number | undefined>;

  /** Update this client's participant metadata (full replace, triggers roster broadcast). */
  updateMetadata(metadata: Partial<T>, options?: UpdateMetadataOptions): Promise<void>;

  /** Set this client's typing state. Broadcasts ephemerally (not persisted to message history). */
  setTyping(active: boolean): Promise<void>;

  /** Wait for the ready signal (replay complete). Throws if timeout exceeded. */
  ready(timeoutMs?: number): Promise<void>;

  /** Close the connection */
  close(): void;

  /** Send a raw message to the server (for protocol-level messages like "close") */
  sendRaw(message: Record<string, unknown>): Promise<void>;

  /** Whether currently connected */
  readonly connected: boolean;

  /** Whether currently attempting to reconnect */
  readonly reconnecting: boolean;

  /** Context ID for the channel (from server ready message) */
  readonly contextId: string | undefined;

  /** Channel config (from server ready message) */
  readonly channelConfig: ChannelConfig | undefined;

  /** Register error handler. Returns unsubscribe function. */
  onError(handler: (error: Error) => void): () => void;

  /** Register disconnect handler. Returns unsubscribe function. */
  onDisconnect(handler: () => void): () => void;

  /** Register reconnect handler (called after successful reconnection). Returns unsubscribe function. */
  onReconnect(handler: () => void): () => void;

  /** Register ready handler (called on every ready message, including reconnects). Returns unsubscribe function. */
  onReady(handler: () => void): () => void;

  /** Register roster update handler. Returns unsubscribe function. */
  onRoster(handler: (roster: RosterUpdate<T>) => void): () => void;

  /** Update the channel config (merges with existing config). */
  updateChannelConfig(config: Partial<ChannelConfig>): Promise<ChannelConfig>;

  /** Register channel config change handler. Returns unsubscribe function. */
  onConfigChange(handler: (config: ChannelConfig) => void): () => void;

  /** Get the current roster participants (may be empty if no roster update received yet) */
  readonly roster: Record<string, Participant<T>>;

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
  }>;

  /**
   * Async iterator for typed protocol events (IncomingEvent | AggregatedEvent).
   *
   * Higher-level than messages() — parses PubSubMessages into typed IncomingEvent
   * objects and optionally aggregates replay events into AggregatedEvent objects.
   *
   * @param options.includeReplay - Include replay events (default: false)
   * @param options.includeEphemeral - Include ephemeral events (default: false)
   */
  events(options?: EventStreamOptions): AsyncIterableIterator<EventStreamItem>;

  // === Agentic convenience methods ===

  /** This client's participant ID */
  readonly clientId: string | undefined;

  /**
   * Send a new chat message. Convenience wrapper around publish("message", ...).
   * Returns the message UUID and server-assigned pubsub ID.
   */
  send(
    content: string,
    options?: {
      replyTo?: string;
      persist?: boolean;
      attachments?: import("./types.js").AttachmentInput[];
      contentType?: string;
      at?: string[];
      metadata?: Record<string, unknown>;
      idempotencyKey?: string;
    }
  ): Promise<{ messageId: string; pubsubId: number | undefined }>;

  /**
   * Update an existing message (for streaming). Convenience wrapper around publish("update-message", ...).
   */
  update(
    id: string,
    content: string,
    options?: { complete?: boolean; persist?: boolean; attachments?: import("./types.js").AttachmentInput[]; contentType?: string }
  ): Promise<number | undefined>;

  /**
   * Mark a message as complete. Convenience wrapper around publish("update-message", { id, complete: true }).
   */
  complete(id: string, options?: { idempotencyKey?: string }): Promise<number | undefined>;

  /**
   * Publish an error for a message. Convenience wrapper around publish("error", ...).
   */
  error(id: string, error: string, code?: string): Promise<number | undefined>;

  /**
   * Call a method on a remote provider. Publishes a method-call message and
   * tracks the result via method-result messages.
   */
  callMethod(
    providerId: string,
    methodName: string,
    args?: unknown,
    options?: { timeoutMs?: number }
  ): MethodCallHandle;
}
