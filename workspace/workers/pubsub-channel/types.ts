/**
 * Types for the PubSub Channel DO.
 */

import type { ChannelEvent, SendMessageOptions } from "@natstack/harness/types";

/** Options for sending a message via the channel DO. */
export interface SendOpts {
  contentType?: string;
  persist?: boolean;
  senderMetadata?: Record<string, unknown>;
  replyTo?: string;
}

/** Result from subscribing a DO participant. */
export interface SubscribeResult {
  ok: boolean;
  channelConfig?: Record<string, unknown>;
  /** Persisted channel events the subscriber missed (sent before it joined). */
  replay?: ChannelEvent[];
}

/** Participant info stored in the participants table. */
export interface ParticipantInfo {
  id: string;
  metadata: Record<string, unknown>;
  transport: "ws" | "do";
  connectedAt: number;
  doSource?: string;
  doClass?: string;
  doKey?: string;
}

/** Channel config (mirrors PubSub client ChannelConfig). */
export interface ChannelConfig {
  title?: string;
  approvalLevel?: number;
  [key: string]: unknown;
}

/** Presence event payload stored in messages table. */
export interface PresencePayload {
  action: "join" | "leave" | "update";
  metadata: Record<string, unknown>;
  leaveReason?: "graceful" | "disconnect";
}

/** Server message format sent to WebSocket clients (same as PubSub server). */
export interface ServerMessage {
  kind: "replay" | "persisted" | "ephemeral" | "ready" | "error" | "config-update" | "messages-before";
  id?: number;
  type?: string;
  payload?: unknown;
  senderId?: string;
  ts?: number;
  ref?: number;
  error?: string;
  attachments?: Array<{ id: string; data: string; mimeType: string; name?: string; size: number }>;
  senderMetadata?: Record<string, unknown>;
  contextId?: string;
  channelConfig?: ChannelConfig;
  totalCount?: number;
  chatMessageCount?: number;
  firstChatMessageId?: number;
  messages?: Array<{
    id: number;
    type: string;
    payload: unknown;
    senderId: string;
    ts: number;
    senderMetadata?: Record<string, unknown>;
    attachments?: Array<{ id: string; data: string; mimeType: string; name?: string; size: number }>;
  }>;
  hasMore?: boolean;
  trailingUpdates?: Array<{
    id: number;
    type: string;
    payload: unknown;
    senderId: string;
    ts: number;
    senderMetadata?: Record<string, unknown>;
  }>;
}

/** Client message format received from WebSocket clients. */
export type ClientMessage =
  | { action: "publish"; type: string; payload: unknown; persist?: boolean; ref?: number; attachmentMeta?: AttachmentMeta[] }
  | { action: "update-metadata"; payload: unknown; ref?: number }
  | { action: "close"; ref?: number }
  | { action: "update-config"; config: Partial<ChannelConfig>; ref?: number }
  | { action: "get-messages-before"; beforeId: number; limit?: number; ref?: number };

/** Attachment metadata from binary wire format. */
export interface AttachmentMeta {
  mimeType: string;
  name?: string;
  size: number;
}

/** Attachment stored in messages table (JSON). */
export interface StoredAttachment {
  id: string;
  data: string;  // base64
  mimeType: string;
  name?: string;
  size: number;
}

/** Event delivered to agent DOs via callDO. Same as ChannelEvent from harness/types. */
export type { ChannelEvent, SendMessageOptions };
