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
  /** Up to 50 most recent persisted events before the subscriber joined (best-effort catch-up). */
  replay?: ChannelEvent[];
  /** True if replay was capped and older events exist beyond the returned window. */
  replayTruncated?: boolean;
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

/** WS-specific metadata passed alongside a ChannelEvent to broadcast(). */
export interface BroadcastEnvelope {
  kind: "persisted" | "ephemeral";
  ref?: number;
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
