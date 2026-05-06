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
  idempotencyKey?: string;
}

/** Result from subscribing a DO participant. */
export interface SubscribeResult {
  ok: boolean;
  channelConfig?: Record<string, unknown>;
  /**
   * Ordered wire-format replay events for RPC subscribers. This mirrors the
   * replay events queued to the subscriber before `ready`, so an RPC client can
   * recover if the ready event is lost without weakening the "ready means
   * replay drained" contract.
   */
  initialReplay?: Array<Record<string, unknown>>;
  ready?: {
    contextId?: string;
    channelConfig?: Record<string, unknown>;
    totalCount: number;
    chatMessageCount: number;
    firstChatMessageId?: number;
  };
  /** Up to 50 most recent persisted events before the subscriber joined (best-effort catch-up). */
  replay?: ChannelEvent[];
  /** True if replay was capped and older events exist beyond the returned window. */
  replayTruncated?: boolean;
}

/** Participant info stored in the participants table. */
export interface ParticipantInfo {
  id: string;
  metadata: Record<string, unknown>;
  transport: "rpc" | "do";
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
  leaveReason?: "graceful" | "disconnect" | "replaced";
}

/** Metadata passed alongside a ChannelEvent to broadcast(). */
export interface BroadcastEnvelope {
  kind: "persisted" | "ephemeral";
  ref?: number;
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
