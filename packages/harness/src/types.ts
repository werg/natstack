/**
 * Channel boundary types still used by `@workspace/agentic-do` and the
 * worker DO base. Everything harness-protocol-related has been deleted —
 * Pi runs in-process now.
 */

/** Usage metrics returned after a completed turn. */
export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** Attachment on a channel message — canonical format for all transports. */
export interface Attachment {
  /** Stable ID for binary frame correlation. */
  id: string;
  /** Derived convenience: "image" | "file". */
  type?: string;
  /** Base64-encoded content. */
  data: string;
  mimeType: string;
  filename?: string;
  /** Byte size for binary frame slicing. */
  size: number;
}

/** Channel event — canonical format for all transports (WS + DO). */
export interface ChannelEvent {
  id: number;
  messageId: string;
  type: string;
  payload: unknown;
  senderId: string;
  senderMetadata?: Record<string, unknown>;
  /** Content type from the payload (e.g., "typing" for typing indicators). */
  contentType?: string;
  ts: number;
  persist: boolean;
  attachments?: Attachment[];
}

/** Options for sending a channel message (used by DO clients and PubSub server). */
export interface SendMessageOptions {
  contentType?: string;
  persist?: boolean;
  senderMetadata?: Record<string, unknown>;
  replyTo?: string;
  idempotencyKey?: string;
  attachments?: Array<{ data: string; mimeType: string }>;
}

/** Input for starting a new agent turn. */
export interface TurnInput {
  content: string;
  senderId: string;
  context?: string;
  attachments?: Attachment[];
}

/** Pubsub participant identity — returned by subscribeChannel(). */
export interface ParticipantDescriptor {
  /** Stable, unique-within-channel handle. */
  handle: string;
  name: string;
  type: string;
  metadata?: Record<string, unknown>;
  methods?: Array<{
    name: string;
    description: string;
    parameters?: unknown;
  }>;
}

/** Result from unsubscribing a channel. */
export interface UnsubscribeResult {
  ok: true;
}
