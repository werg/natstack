/**
 * PubSubClient interface — the contract for pub/sub messaging clients.
 *
 * The sole implementation is connectViaRpc() in rpc-client.ts.
 */

import type {
  PublishOptions,
  UpdateMetadataOptions,
  RosterUpdate,
  ParticipantMetadata,
  Participant,
  Attachment,
  ChannelConfig,
  ChannelReplayEnvelope,
  MessageTypeDefinition,
  RegisterMessageTypeInput,
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
  /** Publish a message to the channel. Returns the message ID for persisted messages. */
  publish<P>(type: string, payload: P, options?: PublishOptions): Promise<number | undefined>;

  /** Update this client's participant metadata (full replace, triggers roster broadcast). */
  updateMetadata(metadata: Partial<T>, options?: UpdateMetadataOptions): Promise<void>;

  /** Set this client's typing state. Broadcasts as a signal, outside durable message history. */
  setTyping(active: boolean): Promise<void>;

  /** Wait for the ready signal (replay complete). */
  ready(signal?: AbortSignal): Promise<void>;

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

  /** Count of replayable channel envelopes. */
  readonly envelopeCount: number | undefined;

  /** First replayable channel-envelope sequence. */
  readonly firstEnvelopeSeq: number | undefined;

  /** Whether the server reported older envelopes before the initial replay window. */
  readonly hasMoreBefore: boolean | undefined;

  /** Get older channel envelopes before a sequence. */
  getReplayBefore(beforeSeq: number, limit?: number): Promise<ChannelReplayEnvelope>;

  /** Get durable log rows after a sequence ID. */
  getReplayAfter(sinceId: number): Promise<ChannelReplayEnvelope>;

  /** Fetch registered custom message types for this channel. */
  getMessageTypes(): Promise<MessageTypeDefinition[]>;

  /** Fetch one registered custom message type for this channel. */
  getMessageType(typeId: string): Promise<MessageTypeDefinition | null>;

  /** Register or replace a custom message type. */
  registerMessageType(input: RegisterMessageTypeInput, options?: { idempotencyKey?: string }): Promise<number | undefined>;

  /** Clear a custom message type registration. */
  clearMessageType(typeId: string, options?: { idempotencyKey?: string }): Promise<number | undefined>;

  /** Publish a custom message instance and return its message id and pubsub id. */
  publishCustomMessage(input: {
    typeId: string;
    initialState?: unknown;
    displayMode?: "inline" | "row";
  }, options?: { idempotencyKey?: string }): Promise<{ messageId: string; pubsubId: number | undefined }>;

  /** Publish an update for a custom message instance. */
  updateCustomMessage(messageId: string, update: unknown, options?: { idempotencyKey?: string }): Promise<number | undefined>;

  /**
   * Async iterator for typed protocol events.
   *
   * Parses channel envelopes into raw typed IncomingEvent objects. Replay and
   * live events use the same event shape so transcript consumers can reduce a
   * single stream.
   *
   * @param options.includeReplay - Include replay events (default: false)
   * @param options.includeSignals - Include signal events (default: false)
   */
  events(options?: EventStreamOptions): AsyncIterableIterator<EventStreamItem>;

  // === Agentic convenience methods ===

  /** This client's participant ID */
  readonly clientId: string | undefined;

  /** Channel identifier this client is connected to. */
  readonly channelId: string;

  /**
   * Send a new chat message as an agentic trajectory event.
   * Returns the message UUID and server-assigned pubsub ID.
   */
  send(
    content: string,
    options?: {
      replyTo?: string;
      attachments?: import("./types.js").AttachmentInput[];
      contentType?: string;
      mentions?: string[];
      metadata?: Record<string, unknown>;
      idempotencyKey?: string;
    }
  ): Promise<{ messageId: string; pubsubId: number | undefined }>;

  /**
   * Publish an error for a message. Convenience wrapper around publish("error", ...).
   */
  error(id: string, error: string, code?: string): Promise<number | undefined>;

  /**
   * Call a method on a remote provider. Publishes an invocation-call message and
   * tracks progress/results via dedicated method transport envelopes.
   */
  callMethod(
    providerId: string,
    methodName: string,
    args?: unknown,
    options?: { signal?: AbortSignal; invocationId?: string; transportCallId?: string; turnId?: string }
  ): MethodCallHandle;

  /** Cancel a specific in-flight method dispatch by transport call id. */
  cancelMethodCall(callId: string): Promise<void>;

  /**
   * Abort a method that THIS client is currently executing, synchronously and
   * in-process, by firing the AbortController handed to the method's execution
   * context. Returns true if a matching in-flight execution was found and
   * aborted. Unlike `cancelMethodCall` (which round-trips through the channel
   * DO and aborts remote executors through a dedicated method-cancel envelope),
   * this acts immediately on the local executor — use it to stop an eval
   * running in this very panel.
   * `callId` is the transport call id.
   */
  abortExecutingMethod(callId: string): boolean;
}
