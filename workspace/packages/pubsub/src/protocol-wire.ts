/**
 * Shared WS wire protocol types — used by both the PubSub channel DO
 * (server) and the PubSub client. Single source of truth to prevent drift.
 */

import type { Attachment } from "@natstack/harness";
import type { ChannelConfig } from "./types.js";

// ── Event messages (channel events with transport metadata) ──────────────

/** WS event message: ChannelEvent fields + transport metadata */
export interface WsEventMessage {
  kind: "replay" | "persisted" | "ephemeral";
  id?: number;
  type: string;
  payload: unknown;
  senderId: string;
  ts: number;
  senderMetadata?: Record<string, unknown>;
  /** Sender ack correlation (WS-only, not present on replays) */
  ref?: number;
  /** Parsed attachments (from binary frame or inline) */
  attachments?: Attachment[];
  /** Binary frame attachment metadata (present only in binary frames) */
  attachmentMeta?: Array<{ id: string; mimeType: string; name?: string; size: number }>;
}

// ── Control messages (lifecycle/RPC responses, not events) ───────────────

export interface WsReadyMessage {
  kind: "ready";
  contextId?: string;
  channelConfig?: ChannelConfig;
  totalCount?: number;
  chatMessageCount?: number;
  firstChatMessageId?: number;
}

export interface WsErrorMessage {
  kind: "error";
  error: string;
  ref?: number;
}

export interface WsConfigUpdateMessage {
  kind: "config-update";
  channelConfig: ChannelConfig;
  ref?: number;
}

/** Row shape for messages-before pagination response */
export interface WsMessageEntry {
  id: number;
  type: string;
  payload: unknown;
  senderId: string;
  ts: number;
  senderMetadata?: Record<string, unknown>;
  attachments?: Attachment[];
}

export interface WsMessagesBeforeMessage {
  kind: "messages-before";
  messages?: WsMessageEntry[];
  hasMore?: boolean;
  trailingUpdates?: WsMessageEntry[];
  ref?: number;
}

export type WsControlMessage =
  | WsReadyMessage
  | WsErrorMessage
  | WsConfigUpdateMessage
  | WsMessagesBeforeMessage;

/** Any WS message (event or control) */
export type WsMessage = WsEventMessage | WsControlMessage;
